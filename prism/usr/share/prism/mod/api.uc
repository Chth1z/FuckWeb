// The ubus object "prism": what the dashboard and the CLI read, and the few
// things they may ask for. prismd publishes it; uhttpd exposes it over
// /ubus under the ACL in /usr/share/rpcd/acl.d/prism.json (reads are open on
// the LAN, writes need a login).
//
// Read methods answer from the daemon's memory and the last reconcile
// snapshot. They never touch the kernel, so a slow client cannot stall it.

import * as fs from "fs";
import * as core from "../lib/core.uc";
import * as config from "../lib/config.uc";
import * as series from "../lib/series.uc";
import * as weave from "./weave.uc";
import * as tunnel from "./tunnel.uc";
import * as identity from "./identity.uc";
import * as led from "./led.uc";

let list_cache = {};
let size_cache = {};
const SET_SIZE_TTL = 20;

function list_count(file) {
	let st = fs.stat(file);
	if (!st)
		return 0;
	let mark = sprintf("%d.%d", st.size, st.mtime);
	if (list_cache[file]?.mark == mark)
		return list_cache[file].count;
	let count = length(core.lines(file));
	list_cache[file] = { mark, count };
	return count;
}

function controller(cfg, lan_ip, method, url, body) {
	let cmd = sprintf("curl -4 --noproxy '*' --connect-timeout 1 -m 2 -sS -X %s -H %s", method,
		core.shq("Authorization: Bearer " + (core.read(core.ETC + "/controller.secret") ?? "")));
	if (body)
		cmd += " -H 'Content-Type: application/json' --data " + core.shq(body);
	let r = core.sh(sprintf("%s %s 2>/dev/null", cmd, core.shq(sprintf("http://%s:%d%s", lan_ip, cfg.tunnel.controller_port, url))));
	try {
		return r.code == 0 ? (length(trim(r.out)) ? json(r.out) : {}) : null;
	}
	catch (e) {
		return null;
	}
}

function events(limit) {
	let lines = split(trim(fs.readfile(core.RUN + "/events.log") ?? ""), "\n");
	let out = [];
	for (let line in slice(lines, -limit)) {
		let m = match(line, /^([0-9]+) (.*)$/);
		if (m)
			push(out, { ts: int(m[1]), msg: m[2] });
	}
	return reverse(out);
}

const MAX_FLOWS = 400;

// LAN flows that left directly, from the kernel's connection table.
function direct_flows(snap) {
	let lan = replace(snap.lan_ip ?? "", /[0-9]+$/, ""), strand = {}, out = [];
	for (let s in snap.strands ?? [])
		strand[s.id] = s.dev;
	let raw = fs.readfile("/proc/net/nf_conntrack");
	if (!raw || !length(lan))
		return out;
	let lan_tag = "src=" + lan;
	for (let line in split(raw, "\n")) {
		if (substr(line, 0, 5) != "ipv4 " || index(line, lan_tag) < 0)
			continue;
		let p_mk = index(line, " mark=");
		if (p_mk < 0)
			continue;
		let mark = int(substr(line, p_mk + 6, 12));
		if (mark & 0x4000)
			continue;
		let p_src = index(line, " src=");
		if (p_src < 12)
			continue;
		let i = 5;
		while (i < p_src && substr(line, i, 1) == " ") i++;
		while (i < p_src && substr(line, i, 1) != " ") i++;
		while (i < p_src && substr(line, i, 1) == " ") i++;
		let ps = i;
		while (i < p_src && substr(line, i, 1) != " ") i++;
		let proto = substr(line, ps, i - ps);
		if (!length(proto))
			continue;
		let rest = substr(line, p_src + 5);
		let p = index(rest, " dst=");
		if (p < 0)
			continue;
		let src = substr(rest, 0, p);
		if (index(src, lan) != 0)
			continue;
		rest = substr(rest, p + 5);
		p = index(rest, " sport=");
		if (p < 0)
			continue;
		let dst = substr(rest, 0, p);
		if (index(dst, lan) == 0)
			continue;
		rest = substr(rest, p + 7);
		p = index(rest, " dport=");
		if (p < 0)
			continue;
		let sport = substr(rest, 0, p);
		rest = substr(rest, p + 7);
		p = index(rest, " ");
		if (p < 0)
			continue;
		let dport = int(substr(rest, 0, p));
		p = index(rest, " bytes=");
		if (p < 0)
			continue;
		rest = substr(rest, p + 7);
		let sp = index(rest, " ");
		if (sp < 0)
			continue;
		let up = int(substr(rest, 0, sp));
		p = index(rest, " bytes=");
		if (p < 0)
			continue;
		let down = int(substr(rest, p + 7, 20));
		push(out, {
			key: proto + src + ":" + sport + ">" + dst + ":" + dport,
			src, dst, port: dport, proto, route: "direct",
			via: strand[mark & 0xff] ?? "", vip: (mark & 0x100) != 0,
			up, down,
		});
	}
	out = sort(out, (a, b) => (b.down + b.up) - (a.down + a.up));
	return slice(out, 0, MAX_FLOWS);
}

function tunnel_flows(cfg, lan_ip) {
	let res = controller(cfg, lan_ip, "GET", "/connections"), out = [];
	for (let c in res?.connections ?? []) {
		let m = c.metadata ?? {};
		if (!m.sourceIP || m.sourceIP == "127.0.0.1")
			continue;
		push(out, {
			key: c.id, src: m.sourceIP, dst: m.host || m.sniffHost || m.destinationIP, port: int(m.destinationPort),
			proto: m.network, route: "tunnel", via: c.chains?.[0] ?? "", vip: false,
			up: c.upload ?? 0, down: c.download ?? 0,
			start: c.start ?? "",
		});
	}
	return slice(out, 0, MAX_FLOWS);
}

// What each classify rule means, by its nft comment. Order here is not the
// order of evaluation: that is whatever the kernel returns.
function rules() {
	let r = core.sh("nft -j list chain inet prism classify"), out = [];
	try {
		for (let item in json(r.out).nftables) {
			let c = null;
			for (let e in item.rule?.expr ?? [])
				c ??= e.counter;
			if (item.rule?.comment)
				push(out, { tag: item.rule.comment, packets: c?.packets ?? 0, bytes: c?.bytes ?? 0 });
		}
	}
	catch (e) {
		return [];
	}
	return out;
}

function set_size(name) {
	let now = time(), cached = size_cache[name];
	if (cached && now - cached.ts < SET_SIZE_TTL)
		return cached.count;
	let r = core.sh(sprintf("nft -j list set inet prism %s", name));
	let count = cached?.count ?? 0;
	try {
		for (let item in json(r.out).nftables) {
			if (item.set) {
				count = length(item.set.elem ?? []);
				break;
			}
		}
		size_cache[name] = { ts: now, count };
	}
	catch (e) {
		return count;
	}
	return count;
}

// d: the daemon's view — { cfg(), snapshot(), load(), pattern(), history(),
//    devices(), interval(), kick(), reload() }
export function methods(d) {
	let lan_ip = () => d.snapshot()?.lan_ip ?? "127.0.0.1";

	let methods = {
		status: {
			call: function() {
				let snap = d.snapshot() ?? {}, load = d.load(), pattern = d.pattern(), vip = d.vip?.() ?? [];
				let mnow = d.now ? d.now() : 0;
				let vip_id = (vip[0] ?? 0) & 0xff, vip_dev = "";
				let weight = {};
				for (let id in pattern)
					weight[id] = (weight[id] ?? 0) + 1;
				let total = 0, total_up = 0, total_ewma = 0, total_up_ewma = 0, total_bytes = 0, total_up_bytes = 0;
				let healthy_count = 0, b_counts = { charged: 0, draining: 0, depleted: 0, cooling: 0 };
				let strands = map(snap.strands ?? [], (s) => {
					let down = load[s.dev]?.down ?? {}, up = load[s.dev]?.up ?? {}, b = load[s.dev]?.bucket ?? {};
					let is_vip = s.id == vip_id;
					if (is_vip)
						vip_dev = s.dev;
					if (s.healthy)
						healthy_count++;
					let b_state = b.state ?? "charged";
					if (s.healthy && b_counts[b_state] != null)
						b_counts[b_state]++;
					let tokens = int(b.tokens ?? weave.BURST_MAX);
					let cd_rem = (b.cooldown_until && mnow > 0 && b.cooldown_until > mnow) ? +sprintf("%.1f", b.cooldown_until - mnow) : 0;
					total += down.now ?? 0;
					total_up += up.now ?? 0;
					total_ewma += down.rate ?? 0;
					total_up_ewma += up.rate ?? 0;
					total_bytes += down.bytes ?? 0;
					total_up_bytes += up.bytes ?? 0;
					return {
						...s,
						ttfb_ms: int((s.ttfb ?? 0) * 1000 + 0.5),
						loss_pct: int((s.loss ?? 0) * 100 + 0.5),
						rate: int(down.rate ?? 0), now: int(down.now ?? 0), peak: int(down.peak ?? 0), down_bytes: down.bytes ?? 0,
						up: int(up.rate ?? 0), up_now: int(up.now ?? 0), up_peak: int(up.peak ?? 0), up_bytes: up.bytes ?? 0,
						slots: weight[s.id] ?? 0,
						vip: is_vip,
						bucket: b_state,
						tokens,
						tokens_max: weave.BURST_MAX,
						tokens_pct: int(min(100, max(0, tokens * 100 / weave.BURST_MAX))),
						cooldown_rem: cd_rem,
					};
				});
				// The current choice for every tunable, so a viewer who is not
				// logged in still sees which option is in force.
				let cfg = d.cfg(), settings = {};
				for (let key in keys(config.TUNABLE)) {
					let p = split(key, ".");
					settings[key] = cfg[p[0]][p[1]];
				}
				return {
					...snap,
					settings,
					led_state: d.led_view ? d.led_view() : led.inspect(cfg),
					version: core.VERSION,
					ts: time(),
					reconciled: snap.ts ?? 0,
					strand_count: length(strands),
					healthy_count,
					rate: int(total),
					rate_up: int(total_up),
					rate_ewma: int(total_ewma),
					rate_up_ewma: int(total_up_ewma),
					down_bytes: total_bytes,
					up_bytes: total_up_bytes,
					strands,
					weave: {
						...(snap.weave ?? {}),
						pattern,
						vip,
						vip_id,
						vip_dev,
						interval: d.interval(),
						charged_count: b_counts.charged,
						draining_count: b_counts.draining,
						depleted_count: b_counts.depleted,
						cooling_count: b_counts.cooling,
					},
				};
			},
		},

		series: {
			args: { limit: 0 },
			call: function(req) {
				let iv = d.series_interval ? d.series_interval() : d.interval();
				return { interval: iv, ...series.dump(d.history(), req.args?.limit ?? 0) };
			},
		},

		events: {
			args: { limit: 0 },
			call: function(req) {
				return { events: events(req.args?.limit || 60) };
			},
		},

		doctor: {
			call: function() {
				return core.load_json(core.RUN + "/doctor.json", { ok: false, fail: [ "no_report" ], warn: [], checks: [] });
			},
		},

		// Relays as the tunnel sees them: TW-HOME fallback status, kept relays, and per-device groups.
		tunnel: {
			call: function() {
				let cfg = d.cfg(), lip = lan_ip();
				let all = controller(cfg, lip, "GET", "/proxies")?.proxies;
				if (!all)
					return { reachable: false, relays: [], groups: [] };
				let delay = (p) => {
					let h = p?.history ?? [];
					return length(h) ? h[length(h) - 1].delay : 0;
				};
				let relays = [], seen = {};
				for (let spec in tunnel.load_relays(cfg).proxies) {
					if (seen[spec.name])
						continue;
					seen[spec.name] = true;
					push(relays, { name: spec.name, type: all[spec.name]?.type ?? spec.type ?? "", delay: delay(all[spec.name]) });
				}
				let profiles = identity.load_store()?.profiles ?? [];
				let groups = map(profiles, (p) => ({
					uid: p.uid,
					group_name: p.group_name,
					anchor_mac: p.anchor_mac,
					port: p.port,
					now: all[p.group_name]?.now ?? "",
				}));
				let tw_now = all["TW-HOME"]?.now ?? "";
				return {
					reachable: true,
					selected: tw_now || groups[0]?.now || relays[0]?.name || "TW-HOME",
					tw_home: tw_now,
					auto: tw_now,
					relays,
					groups,
					dashboard: sprintf("http://%s:%d/ui/", lip, cfg.tunnel.controller_port),
				};
			},
		},

		devices: {
			call: function() {
				let v = d.devices();
				if (type(v) == "object" && type(v.devices) == "array")
					return v;
				return { devices: v ?? [], quarantine: [] };
			},
		},

		// Every flow leaving the LAN right now. Direct flows come from
		// conntrack (the strand is in the mark); tunnelled ones from mihomo,
		// which also knows the hostname and the relay. Login only: this is
		// who is talking to whom.
		connections: {
			call: function() {
				let snap = d.snapshot() ?? {};
				return { connections: [ ...direct_flows(snap), ...tunnel_flows(d.cfg(), lan_ip()) ] };
			},
		},

		// The classify chain as the kernel holds it, with live counters.
		rules: {
			call: function() {
				let c = d.cfg();
				return {
					rules: rules(),
					tunnel_on: !!d.snapshot()?.tunnel?.on,
					sizes: {
						domestic4: list_count(config.path(c.classify.domestic4)),
						tunnel4: list_count(config.path(c.classify.tunnel4)),
						tunnel_domains: list_count(config.path(c.classify.tunnel_domains)),
						tunnel4_dns: set_size("tunnel4_dns"),
						domestic4_dns: set_size("domestic4_dns"),
						relay4: set_size("relay4"),
					},
					ports: c.classify.tunnel_udp_port,
				};
			},
		},

		config: {
			call: function() {
				let cfg = d.cfg(), values = {};
				for (let key in keys(config.TUNABLE)) {
					let p = split(key, ".");
					values[key] = cfg[p[0]][p[1]];
				}
				return { values, tunable: config.TUNABLE };
			},
		},

		// --- writes ----------------------------------------------------------

		reconcile: {
			call: function() {
				d.kick();
				return { ok: true };
			},
		},

		configure: {
			args: { set: {} },
			call: function(req) {
				let res = config.store(req.args?.set ?? {});
				if (res.ok) {
					core.event("CONFIG %s", join(" ", map(keys(req.args.set), (k) => k + "=" + req.args.set[k])));
					d.reload();
					d.kick();
				}
				return res;
			},
		},

		device: {
			args: { mac: "", name: "", policy: "" },
			call: function(req) {
				let a = req.args ?? {};
				if (d.set_device)
					return d.set_device(a);
				let res = config.device_store(lc(a.mac ?? ""), a.name ?? "", a.policy || "auto");
				if (res.ok) {
					core.event("DEVICE %s policy=%s name=%s", a.mac, a.policy || "auto", a.name ?? "");
					d.reload();
					d.kick();
				}
				return res;
			},
		},

		claim: {
			args: { mac: "", action: "new", target_uid: "", alias: "", policy: "", relay: "" },
			call: function(req) {
				let a = req.args ?? {};
				return d.claim ? d.claim(a) : identity.claim(a, d.cfg());
			},
		},

		dhcp_event: {
			args: { action: "", mac: "", ip: "", host: "", opt55: "", vendor: "", cid: "", iface: "", ts: 0 },
			call: function(req) {
				let a = req.args ?? {};
				return d.dhcp_event ? d.dhcp_event(a) : identity.on_dhcp_event(a);
			},
		},

		// Remember the network we are on now, and whether to aggregate here.
		remember: {
			args: { name: "", aggregate: true, portal: "" },
			call: function(req) {
				let a = req.args ?? {}, gw = d.snapshot()?.site?.gateway;
				let prev = gw ? core.load_json(core.RUN + "/state.json", {})?.site_portals?.[gw] : null;
				let portal = length(a.portal) ? a.portal : (prev?.portal ?? "");
				let secret = prev?.portal_secret ?? "";
				let res = config.site_store(gw, a.name, !!a.aggregate, portal, secret);
				if (res.ok) {
					core.event("SITE remembered: %s aggregate=%s", a.name ?? "", a.aggregate ? "on" : "off");
					d.reload();
					d.kick();
				}
				return res;
			},
		},

		forget: {
			call: function() {
				let res = config.site_forget(d.snapshot()?.site?.gateway ?? "");
				if (res.ok) {
					d.reload();
					d.kick();
				}
				return res;
			},
		},

		// Forget every portal park and probe all strands on the next pass.
		relogin: {
			call: function() {
				core.save_json(core.RUN + "/request.json", { relogin: true });
				d.kick();
				return { ok: true };
			},
		},

		select: {
			args: { name: "", group: "" },
			call: function(req) {
				let name = req.args?.name ?? "", grp_in = req.args?.group ?? "";
				let grp = "TW-HOME", save_key = "_tw_home";
				if (length(grp_in) && grp_in != "TW-HOME") {
					let profiles = identity.load_store()?.profiles ?? [];
					let prof = null;
					for (let p in profiles) {
						if (p.uid == grp_in || p.group_name == grp_in) {
							prof = p;
							break;
						}
					}
					if (!prof)
						return { ok: false, error: "unknown group" };
					grp = prof.group_name;
					save_key = prof.uid;
				}
				let res = controller(d.cfg(), lan_ip(), "PUT", "/proxies/" + tunnel.urlenc(grp), sprintf("%J", { name }));
				if (res != null) {
					tunnel.save_selected(save_key, name);
					core.event("TUNNEL relay selected: %s -> %s", grp, name);
				}
				return { ok: res != null };
			},
		},

		led_view: {
			call: function() {
				return d.led_view ? d.led_view() : led.inspect(d.cfg());
			},
		},

		reload: {
			call: function() {
				if (d.reload)
					d.reload();
				return { ok: true };
			},
		},

		led_demo: {
			call: function() {
				return d.led_demo ? d.led_demo() : { ok: false, error: "prismd offline" };
			},
		},

		led_color: {
			args: { r: 0, g: 0, b: 0, target: "", ttl: 10 },
			call: function(req) {
				let a = req.args ?? {};
				return d.led_color ? d.led_color(a) : { ok: false, error: "prismd offline" };
			},
		},
	};

	// uhttpd passes the caller's session id along with every call; a method
	// that does not declare it would reject the whole request.
	// And a handler that throws must cost one reply, not the daemon.
	for (let name, m in methods) {
		let call = m.call;
		m.args = { ...(m.args ?? {}), ubus_rpc_session: "" };
		m.call = function(req) {
			try {
				return call(req);
			}
			catch (e) {
				core.err("api %s: %s", name, e.message);
				return { ok: false, error: e.message };
			}
		};
	}
	return methods;
};
