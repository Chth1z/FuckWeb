// The ubus object "braid": what the dashboard and the CLI read, and the few
// things they may ask for. braidd publishes it; uhttpd exposes it over
// /ubus under the ACL in /usr/share/rpcd/acl.d/braid.json (reads are open on
// the LAN, writes need a login).
//
// Read methods answer from the daemon's memory and the last reconcile
// snapshot. They never touch the kernel, so a slow client cannot stall it.

import * as fs from "fs";
import * as core from "../lib/core.uc";
import * as config from "../lib/config.uc";
import * as series from "../lib/series.uc";

function controller(cfg, lan_ip, method, url, body) {
	let cmd = sprintf("curl -4 -m 3 -sS -X %s -H %s", method,
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

// What each classify rule means, by its nft comment. Order here is not the
// order of evaluation: that is whatever the kernel returns.
function rules() {
	let r = core.sh("nft -j list chain inet braid classify"), out = [];
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
	let r = core.sh(sprintf("nft -j list set inet braid %s", name));
	try {
		for (let item in json(r.out).nftables)
			if (item.set)
				return length(item.set.elem ?? []);
	}
	catch (e) {
		return 0;
	}
	return 0;
}

// d: the daemon's view — { cfg(), snapshot(), load(), pattern(), history(),
//    devices(), interval(), kick(), reload() }
export function methods(d) {
	let lan_ip = () => d.snapshot()?.lan_ip ?? "127.0.0.1";

	let methods = {
		status: {
			call: function() {
				let snap = d.snapshot() ?? {}, load = d.load(), pattern = d.pattern();
				let weight = {}, total = 0;
				for (let id in pattern)
					weight[id] = (weight[id] ?? 0) + 1;
				let strands = map(snap.strands ?? [], (s) => {
					let l = load[s.dev] ?? {};
					total += l.now ?? 0;
					return { ...s, rate: int(l.rate ?? 0), now: int(l.now ?? 0), peak: int(l.peak ?? 0), slots: weight[s.id] ?? 0 };
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
					version: core.VERSION,
					ts: time(),
					reconciled: snap.ts ?? 0,
					rate: int(total),
					strands,
					weave: { ...(snap.weave ?? {}), pattern, interval: d.interval() },
				};
			},
		},

		series: {
			args: { limit: 0 },
			call: function(req) {
				return { interval: d.interval(), ...series.dump(d.history(), req.args?.limit ?? 0) };
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

		// Relays as the tunnel sees them: who is selected, how fast each is.
		tunnel: {
			call: function() {
				let all = controller(d.cfg(), lan_ip(), "GET", "/proxies")?.proxies;
				if (!all)
					return { reachable: false, relays: [] };
				let delay = (p) => {
					let h = p?.history ?? [];
					return length(h) ? h[length(h) - 1].delay : 0;
				};
				let relays = [];
				for (let name in all.PROXY?.all ?? [])
					push(relays, { name, type: all[name]?.type ?? "", delay: delay(all[name]) });
				return {
					reachable: true,
					selected: all.PROXY?.now ?? "",
					auto: all.AUTO?.now ?? "",
					relays,
					dashboard: sprintf("http://%s:%d/ui/", lan_ip(), d.cfg().tunnel.controller_port),
				};
			},
		},

		devices: {
			call: function() {
				return { devices: d.devices() };
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
						domestic4: length(core.lines(config.path(c.classify.domestic4))),
						tunnel4: length(core.lines(config.path(c.classify.tunnel4))),
						tunnel_domains: length(core.lines(config.path(c.classify.tunnel_domains))),
						tunnel4_dns: set_size("tunnel4_dns"),
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
				let res = config.device_store(lc(a.mac ?? ""), a.name ?? "", a.policy || "auto");
				if (res.ok) {
					core.event("DEVICE %s policy=%s name=%s", a.mac, a.policy || "auto", a.name ?? "");
					d.reload();
					d.kick();
				}
				return res;
			},
		},

		// Remember the network we are on now, and whether to aggregate here.
		remember: {
			args: { name: "", aggregate: true, portal: "" },
			call: function(req) {
				let a = req.args ?? {};
				let res = config.site_store(d.snapshot()?.site?.gateway, a.name, !!a.aggregate, a.portal);
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
			args: { name: "" },
			call: function(req) {
				let name = req.args?.name ?? "";
				let res = controller(d.cfg(), lan_ip(), "PUT", "/proxies/PROXY", sprintf("%J", { name }));
				if (res != null)
					core.event("TUNNEL relay selected: %s", name);
				return { ok: res != null };
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
