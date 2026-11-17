// prism — command line and the reconcile pipeline.
//
// One reconcile pass reads the config, looks at the system, works out what
// the kernel and the helper daemons should look like, and changes only what
// differs. Running it twice in a row changes nothing the second time.

import * as fs from "fs";
import * as ubus from "ubus";
import * as core from "./lib/core.uc";
import * as config from "./lib/config.uc";
import * as facts from "./lib/facts.uc";
import * as strands from "./mod/strands.uc";
import * as weave from "./mod/weave.uc";
import * as tunnel from "./mod/tunnel.uc";
import * as kernel from "./mod/kernel.uc";
import * as guard from "./mod/guard.uc";
import * as dns from "./mod/dns.uc";
import * as host from "./mod/host.uc";
import * as wifi from "./mod/wifi.uc";
import * as led from "./mod/led.uc";
import * as doctor from "./mod/doctor.uc";
import * as identity from "./mod/identity.uc";

const STATE = core.RUN + "/state.json";
const STATUS = core.RUN + "/status.json";
const DOCTOR = core.RUN + "/doctor.json";
const REQUEST = core.RUN + "/request.json";
const INIT = "/etc/init.d/prism";
// Present from `teardown` until the next service start. A pass that was
// already queued when the service stopped must not rebuild what stop removed.
const STOPPED = core.RUN + "/stopped";

function context(opt) {
	core.init_dirs();
	return {
		cfg: config.load(),
		facts: facts.gather(),
		st: core.load_json(STATE, {}),
		now: core.now(),
		force: !!opt.force,
		boot: !!opt.boot,
		load: {},
	};
}

// One-shot asks from the dashboard (see api.uc), consumed by the next pass.
function take_request() {
	let req = core.load_json(REQUEST, null);
	if (req && !core.is_dry())
		fs.unlink(REQUEST);
	return req;
}

// Ask prismd for a pass soon. It collapses a burst of asks into one pass.
function kick() {
	return system("ubus call prism reconcile >/dev/null 2>&1");
}

// What prismd and the dashboard need to know about the last pass. Live
// numbers (rates, the current pattern) are added by prismd, not stored here.
function snapshot(ctx, report, led_color) {
	let st = ctx.st, healthy = map(ctx.health.healthy, (s) => s.dev);
	return {
		ts: ctx.now,
		ok: report.ok,
		fail: report.fail,
		warn: report.warn,
		lan_ip: ctx.facts.lan_ip,
		site: {
			known: ctx.site.known, name: ctx.site.name, gateway: ctx.site.gateway ?? "",
			aggregate: ctx.site.aggregate, mode: ctx.cfg.strands.aggregate, portal: ctx.site.portal,
		},
		role: ctx.health.role,
		strands: map(ctx.strands, (s) => {
			let h = st.strands[s.dev] ?? {};
			return {
				dev: s.dev, id: s.id, ip: s.ip ?? "", gw: s.gw ?? "",
				subnet: s.subnet ?? "", iface: s.iface ?? "", role: s.role,
				healthy: s.dev in healthy,
				http: h.code ?? 0, ttfb: h.ttfb ?? 0, loss: h.loss ?? 0,
				parked: (h.parked ?? 0) > 0,
			};
		}),
		weave: { policy: ctx.cfg.weave.policy, affinity: ctx.cfg.weave.affinity, slots: ctx.weave.slots },
		tunnel: {
			enabled: ctx.tunnel.enabled, running: ctx.tunnel.running, on: ctx.tunnel.on,
			restored: !!ctx.tunnel.restored, pid: ctx.tunnel.pid ?? "",
			mixed_port: ctx.cfg.tunnel.mixed_port,
			relays: ctx.tunnel.relays, fail_open: !!st.tunnel?.open,
			canary_ms: st.tunnel?.delay ?? 0, canary_fails: st.tunnel?.fails ?? 0,
		},
		dns: { smartdns: dns.running(), port: ctx.cfg.dns.port },
		mptcp: kernel.mptcp_state(ctx),
		sys: {
			conntrack: host.conntrack(),
			load1: host.load(),
			mem_available_kb: host.mem_available_kb(),
			uptime: ctx.facts.uptime,
		},
		led: led_color,
	};
}

// The pipeline. Order is dependency: recognise the network and bring the
// identities up or down to suit it, route the strands so they can be probed,
// decide (health, tunnel, weave), make the kernel match, then the daemons
// that sit on top, then report.
function reconcile(ctx) {
	ctx.request = take_request();
	ctx.site = strands.site(ctx);
	strands.steer(ctx);
	ctx.strands = strands.discover(ctx);
	kernel.plumb(ctx);
	ctx.health = strands.check(ctx);
	ctx.cfg = config.load();
	ctx.identity = identity.reconcile(ctx);
	ctx.tunnel = tunnel.observe(ctx);
	ctx.weave = weave.plan(ctx);
	kernel.apply(ctx);
	guard.apply(ctx);
	dns.apply(ctx);
	host.apply(ctx);
	wifi.apply(ctx);

	// procd owns the daemons; re-registering makes it start a missing one and
	// restart one whose config file changed. The follow-up pass picks the
	// daemon up without waiting a full period; the counter stops that from
	// spinning when a daemon cannot start at all.
	if (ctx.want_service_sync && !core.is_dry()) {
		core.act(INIT + " start");
		if ((ctx.st.resync = (ctx.st.resync ?? 0) + 1) <= 3)
			kick();
	}
	else {
		ctx.st.resync = 0;
		if (ctx.want_rescan && !core.is_dry()) {
			if ((ctx.st.rescan = (ctx.st.rescan ?? 0) + 1) <= 2)
				kick();
		}
		else {
			ctx.st.rescan = 0;
		}
	}

	let report = doctor.run(ctx);
	let color = led.apply(ctx, report);
	if (core.is_dry())
		return report;

	if (join(" ", report.fail) != ctx.st.doctor_fail && ctx.facts.uptime >= ctx.cfg.main.boot_grace) {
		core.event("DOCTOR %s", report.ok ? "ok" : "fail " + join(" ", report.fail));
		ctx.st.doctor_fail = join(" ", report.fail);
	}
	core.save_json(DOCTOR, report);
	core.save_json(STATUS, snapshot(ctx, report, color));
	core.save_json(STATE, ctx.st, 0o600);
	return report;
}

// wait_s > 0 queues behind a running pass instead of giving up.
function locked(fn, wait_s) {
	core.init_dirs();
	let lock = core.lock("reconcile");
	for (let i = 0; !lock && i < (wait_s ?? 0) * 5; i++) {
		sleep(200);
		lock = core.lock("reconcile");
	}
	if (!lock) {
		// Normal for the periodic pass: someone is already doing its job.
		if (ARGV[0] != "reconcile")
			warn("prism: another pass holds the lock\n");
		return 0;
	}
	let rc = fn();
	lock.close();
	return rc;
}

// Live view from prismd; the last snapshot on disk when it is not running.
function live(method) {
	let bus = ubus.connect();
	let res = bus?.call("prism", method, {});
	bus?.disconnect();
	return res ?? (method == "status" ? core.load_json(STATUS, null) : null);
}

function kbit(bytes_per_s) {
	return bytes_per_s * 8 / 1000;
}

const COMMANDS = {
	reconcile: {
		help: "one reconcile pass (what prismd runs)",
		run: (args) => locked(() => {
			let ctx = context({ boot: "--boot" in args });
			if (!ctx.cfg.main.enabled || fs.stat(STOPPED))
				return 0;
			reconcile(ctx);
			return 0;
		}),
	},
	apply: {
		help: "reconcile now and rebuild the nft table from scratch",
		run: () => locked(() => {
			core.set_mode({ verbose: true });
			let report = reconcile(context({ force: true }));
			print(doctor.text(report));
			return report.ok ? 0 : 1;
		}, 30),
	},
	plan: {
		help: "dry run: show what a pass would change, touch nothing (--full: as if from scratch)",
		run: (args) => {
			core.set_mode({ dry: true });
			let report = reconcile(context({ force: "--full" in args }));
			print(doctor.text(report));
			return 0;
		},
	},
	prepare: {
		help: "what must exist before the daemons start (used by the init script)",
		run: () => {
			let ctx = context({});
			fs.unlink(STOPPED);
			kernel.listen_addr(ctx.cfg);
			if (ctx.cfg.tunnel.enabled)
				tunnel.prepare(ctx.cfg, ctx.facts.lan_ip, identity.load_store()?.profiles ?? []);
			dns.bootstrap(ctx.cfg);
			return 0;
		},
	},
	devices: {
		help: "show enrolled device profiles and Mode A quarantine list",
		run: () => {
			let res = live("devices") ?? identity.view(context({}).cfg, [], {});
			printf("%-14s %-17s %-6s %-8s %-15s %-22s %s\n", "UID", "ANCHOR MAC", "PORT", "POLICY", "IP", "RELAY", "NAME / STATUS");
			for (let d in (res.devices ?? []))
				printf("%-14s %-17s %-6d %-8s %-15s %-22s %s (%d MACs%s)\n",
					d.uid ?? "-", d.mac, d.port ?? 0, d.policy ?? "auto",
					d.ip ?? "-", d.relay ?? "-", d.name || d.host || "-",
					length(d.bound_macs ?? [ d.mac ]), d.online ? ", online" : "");
			if (length(res.quarantine ?? [])) {
				print("\nQuarantined (Mode A blocked):\n");
				for (let q in res.quarantine)
					printf("  %-17s %-15s %-6s score=%-3d (%s) host=%s\n",
						q.mac, q.ip || "-", q.link || "-", q.score ?? 0, q.reason ?? "-", q.host || "-");
			}
			return 0;
		},
	},
	claim: {
		help: "claim <mac> <new|merge:<uid>|forget> [alias]",
		run: (args) => {
			let mac = args[0] ?? "", how = args[1] ?? "new", alias = args[2] ?? "";
			if (!identity.is_mac(mac)) {
				warn("usage: prism claim <mac> <new|merge:<uid>|forget> [alias]\n");
				return 1;
			}
			let act = how == "forget" ? "forget" : (index(how, "merge:") == 0 ? "merge" : "new");
			let uid = act == "merge" ? substr(how, 6) : "";
			let ctx = context({});
			let r = identity.claim({ mac, action: act, target_uid: uid, alias }, ctx.cfg);
			if (!r.ok) {
				warn("claim failed: " + (r.error ?? "unknown") + "\n");
				return 1;
			}
			printf("%.2J\n", r);
			kick();
			return 0;
		},
	},
	teardown: {
		help: "remove all kernel state: back to a plain router",
		run: () => locked(() => {
			let ctx = context({});
			fs.writefile(STOPPED, "");
			if (ctx.cfg.tunnel.enabled && core.pidof("mihomo"))
				tunnel.sync_selected(ctx.cfg, ctx.facts.lan_ip);
			ctx.strands = [];
			kernel.teardown(ctx);
			dns.teardown(ctx);
			delete ctx.st.tunnel;
			core.save_json(STATE, ctx.st, 0o600);
			return 0;
		}, 90),
	},
	provision: {
		help: "apply the UCI defaults from provision.json (--dry to preview)",
		run: (args) => {
			core.set_mode({ dry: "--dry" in args, verbose: true });
			let changed = host.provision(context({}));
			print(length(changed) ? "changed: " + join(" ", changed) + "\n" : "nothing to do\n");
			return 0;
		},
	},
	kick: {
		help: "ask prismd for an immediate pass",
		run: () => kick(),
	},
	status: {
		help: "everything the dashboard shows, as JSON",
		run: () => {
			printf("%.2J\n", live("status") ?? {});
			return 0;
		},
	},
	strands: {
		help: "one line per strand: health, load, bucket state, share of new flows",
		run: () => {
			let s = live("status");
			if (!s)
				return 1;
			printf("%-10s %3s %-16s %-8s %-9s %6s %6s %10s %10s %5s\n", "STRAND", "ID", "ADDRESS", "HEALTH", "BUCKET", "TOK_KB", "TTFB", "KBIT/S", "PEAK", "SLOTS");
			for (let x in s.strands)
				printf("%-10s %3d %-16s %-8s %-9s %6.0f %6.3f %10.0f %10.0f %5d\n", x.dev, x.id, x.ip,
					x.healthy ? "ok" : (x.parked ? "parked" : "down"),
					x.vip ? "vip*" : (x.bucket ?? "-"), (x.tokens ?? 0) / 1000, x.ttfb,
					kbit(x.rate ?? 0), kbit(x.peak ?? 0), x.slots ?? 0);
			printf("\n%s: aggregation %s. %d of %d healthy, %s/%s weave over %d slots, %.0f kbit/s down\n",
				s.site?.known ? s.site.name : "unknown network", s.site?.aggregate ? "on" : "off",
				length(filter(s.strands, (x) => x.healthy)), length(s.strands),
				s.weave?.policy ?? "-", s.weave?.affinity ?? "-", s.weave?.slots ?? 0, kbit(s.rate ?? 0));
			return 0;
		},
	},
	doctor: {
		help: "health report (json | text); exit 1 when a check fails",
		run: (args) => {
			let report;
			locked(() => { report = reconcile(context({})); });
			// Lock busy: a pass is running right now, its report is as fresh.
			report ??= core.load_json(DOCTOR, { ok: false, checks: [], fail: [ "no_report" ], warn: [] });
			print("json" in args ? sprintf("%.2J\n", report) : doctor.text(report));
			return report.ok ? 0 : 1;
		},
	},
	events: {
		help: "recent state transitions",
		run: (args) => system(sprintf("tail -n %d %s/events.log", int(args[0] ?? "40") || 40, core.RUN)),
	},
	tunnel: {
		help: "tunnel reload | ui",
		run: (args) => {
			let ctx = context({});
			if (args[0] == "reload") {
				let prep = tunnel.prepare(ctx.cfg, ctx.facts.lan_ip);
				return prep && tunnel.reload(ctx.cfg, ctx.facts.lan_ip) ? 0 : 1;
			}
			printf("http://%s:%d/ui/\n", ctx.facts.lan_ip, ctx.cfg.tunnel.controller_port);
			return 0;
		},
	},
	portal: {
		help: "portal via <strand>: route the router's own default through one strand for a manual login",
		run: (args) => {
			let ctx = context({});
			ctx.site = strands.site(ctx);
			let s = filter(strands.discover(ctx), (x) => x.dev == args[1])[0];
			if (args[0] != "via" || !s?.gw) {
				warn("usage: prism portal via <strand>\n");
				return 1;
			}
			system(sprintf("ip route replace default via %s dev %s metric 1", s.gw, s.dev));
			printf("default route now via %s. Log in from a LAN client, then: ip route del default metric 1\n", s.dev);
			return 0;
		},
	},
};

function usage() {
	warn("prism " + core.VERSION + " — one beam, twenty-one wavelengths\n\nusage: prism <command>\n");
	for (let name in sort(keys(COMMANDS)))
		warn(sprintf("  %-10s %s\n", name, COMMANDS[name].help));
	return 1;
}

let cmd = COMMANDS[ARGV[0]];
let rc = 1;
try {
	rc = cmd ? cmd.run(slice(ARGV, 1)) : usage();
}
catch (e) {
	core.err("%s: %s\n%s", ARGV[0], e.message, join("\n", map(e.stacktrace ?? [], (f) => sprintf("  at %s:%d", f.filename ?? "?", f.line ?? 0))));
	rc = 2;
}
exit(rc ?? 0);
