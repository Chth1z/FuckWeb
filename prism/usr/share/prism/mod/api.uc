// The ubus object "prism": what the dashboard and the CLI read, and the few
// things they may ask for. prismd publishes it; uhttpd exposes it over
// /ubus under the ACL in /usr/share/rpcd/acl.d/prism.json (reads are open on
// the LAN, writes need a login).
//
// Status and tunnel telemetry share the daemon snapshots. The privileged
// flow list and rule-set sizes read kernel state on demand and cache it.

import * as fs from "fs";
import * as uloop from "uloop";
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

const MAX_FLOWS = 400;

// Keep the largest rows while scanning. Scratch memory is bounded even if
// conntrack reaches its limit or the controller reports many connections.
function top_flows(rows) {
	sort(rows, (a, b) => (b.down + b.up) - (a.down + a.up));
	return slice(rows, 0, MAX_FLOWS);
}

// LAN flows that left directly, from the kernel's connection table.
function direct_flows(snap) {
	let sources = {}, strands = {}, wan_ips = {}, out = [];
	for (let pair in core.load_json(identity.RT_FILE, {})?.pairs ?? [])
		sources[split(pair, " . ")[1]] = true;
	for (let s in snap.strands ?? []) {
		strands[s.id] = s.dev;
		if (s.ip)
			wan_ips[s.ip] = s.dev;
	}
	let file = fs.open("/proc/net/nf_conntrack");
	if (!file)
		return out;
	for (let line; (line = file.read("line")) != null && length(line); ) {
		if (substr(line, 0, 5) != "ipv4 ")
			continue;
		let tuples = split(line, " src=");
		if (length(tuples) != 3)
			continue;
		let orig = split(tuples[1], " "), src = orig[0];
		if (!sources[src] || substr(orig[2], 0, 6) != "sport=" || substr(orig[5], 0, 6) != "bytes=")
			continue;
		let tag = index(tuples[2], " mark=");
		if (tag < 0)
			continue;
		let mark = int(substr(tuples[2], tag + 6, 12));
		if (mark & 0x4000)
			continue;
		let reply = split(tuples[2], " ");
		// Masquerade identifies the actual strand even with mark zero on single WAN.
		let via = wan_ips[substr(reply[1], 4)] ?? strands[mark & 0xff];
		if (!via || substr(reply[5], 0, 6) != "bytes=")
			continue;
		let proto = match(tuples[0], /^ipv4 +[0-9]+ +(tcp|udp) /)?.[1];
		if (!proto)
			continue;
		let dst = substr(orig[1], 4), sport = substr(orig[2], 6), port = int(substr(orig[3], 6));
		push(out, {
			key: proto + src + ":" + sport + ">" + dst + ":" + port,
			src, dst, port, proto, route: "direct", via, vip: (mark & 0x100) != 0,
			up: int(substr(orig[5], 6)), down: int(substr(reply[5], 6)),
		});
		if (length(out) == 2 * MAX_FLOWS)
			out = top_flows(out);
	}
	file.close();
	return top_flows(out);
}

export function tunnel_flows(connections) {
	let out = [];
	for (let c in connections ?? []) {
		let m = c.metadata ?? {};
		if (!m.sourceIP || m.sourceIP == "127.0.0.1")
			continue;
		push(out, {
			key: c.id, src: m.sourceIP, dst: m.host || m.sniffHost || m.destinationIP, port: int(m.destinationPort),
			proto: m.network, route: "tunnel", via: c.chains?.[0] ?? "", vip: false,
			up: c.upload ?? 0, down: c.download ?? 0,
			start: c.start ?? "",
		});
		if (length(out) == 2 * MAX_FLOWS)
			out = top_flows(out);
	}
	return top_flows(out);
};

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

	let direct = [], direct_sampled = 0, direct_task;
	let methods = {
		status: {
			call: function() {
				let snap = d.snapshot() ?? {}, load = d.load(), pattern = d.pattern(), vip = d.vip?.() ?? [];
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
					let refill = (d.cfg().weave.strand_kbit > 0 ? d.cfg().weave.strand_kbit * 125 : weave.CIR_BYTES_S) - max(down.now ?? 0, up.now ?? 0);
					let cd_rem = b_state == "cooling" && refill > 0 ? +sprintf("%.1f", (weave.BURST_MAX - tokens) / refill) : 0;
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
					sys: {
						...(snap.sys ?? {}),
						...(d.host_sys ? (d.host_sys() ?? {}) : {}),
					},
					daemon: d.daemon_health ? d.daemon_health() : null,
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
					rate_peak: d.rate_peak ? d.rate_peak() : int(total),
					tunnel: {
						...(snap.tunnel ?? {}),
						tproxy_port: cfg.tunnel.tproxy_port,
						controller_port: cfg.tunnel.controller_port,
					},
					telemetry: d.telemetry ? d.telemetry() : null,
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
			args: { limit: 0, tag: "", window: 0 },
			call: function(req) {
				return {
					events: core.read_events(req.args?.limit || 60, req.args?.tag ?? ""),
					summary: core.events_summary(req.args?.window || 86400),
				};
			},
		},

		diagnostics: {
			call: function() {
				if (d.diagnostics)
					return d.diagnostics();
				return {
					ts: time(),
					host: d.snapshot()?.sys ?? {},
					daemon: d.daemon_health ? d.daemon_health() : null,
					window_1h: { samples: 0, span_sec: 0 },
					window_24h: { samples: 0, span_sec: 0 },
					qos_drops: { "1:10": 0, "1:20": 0, "1:30": 0, total: 0 },
					events: core.events_summary(86400),
				};
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
				let all = d.proxies();
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
				let tw_now = all["TW-HOME"]?.now ?? "";
				let counts = {}, groups = map(profiles, (p) => {
					let sel = all[p.group_name]?.now ?? "";
					let eff = (sel == "TW-HOME" && length(tw_now)) ? tw_now : sel;
					if (length(eff))
						counts[eff] = (counts[eff] ?? 0) + 1;
					return {
						uid: p.uid,
						group_name: p.group_name,
						anchor_mac: p.anchor_mac,
						port: p.port,
						now: sel,
					};
				});
				let majority = "", best_cnt = 0;
				for (let name, cnt in counts) {
					if (cnt > best_cnt) {
						best_cnt = cnt;
						majority = name;
					}
				}
				return {
					reachable: true,
					selected: majority || tw_now || relays[0]?.name || "TW-HOME",
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
				let now = d.now();
				if ((!direct_sampled || now - direct_sampled >= 4) && (!direct_task || direct_task.finished())) {
					direct_task = uloop.task(() => direct_flows(snap), (rows) => {
						direct = rows ?? [];
						direct_sampled = d.now();
					});
					assert(direct_task, "cannot sample direct flows: " + uloop.error());
				}
				return {
					sampled: { direct: direct_sampled, tunnel: d.tunnel_sampled() },
					connections: [ ...direct, ...d.tunnel_flows() ],
				};
			},
		},

		// The classify chain as the kernel holds it, with live counters.
		rules: {
			call: function() {
				let c = d.cfg();
				return {
					rules: d.rules(),
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
				let set = req.args?.set;
				if (type(set) != "object" || !length(keys(set)))
					return { ok: false, error: "empty set" };
				let res = config.store(set);
				if (res.ok) {
					core.event("CONFIG %s", join(" ", map(keys(set), (k) => k + "=" + set[k])));
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
				if (!length(name))
					return { ok: false, error: "missing relay name" };
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
				let ok = tunnel.select_relay(d.cfg(), lan_ip(), grp, save_key, name);
				if (ok) {
					d.selected(grp, name);
					core.event("TUNNEL relay selected: %s -> %s", grp, name);
				}
				return { ok };
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
