// hotel — command line and the reconcile pipeline.
//
// One tick reads the config, looks at the system, works out what the kernel
// and the helper daemons should look like, and changes only what differs.
// Running it twice in a row changes nothing the second time.

import * as fs from "fs";
import * as core from "./lib/core.uc";
import * as config from "./lib/config.uc";
import * as facts from "./lib/facts.uc";
import * as uplink from "./mod/uplink.uc";
import * as proxy from "./mod/proxy.uc";
import * as datapath from "./mod/datapath.uc";
import * as dns from "./mod/dns.uc";
import * as system_ from "./mod/system.uc";
import * as wifi from "./mod/wifi.uc";
import * as led from "./mod/led.uc";
import * as doctor from "./mod/doctor.uc";

const STATE = core.RUN + "/state.json";
const STATUS = core.RUN + "/status.json";
const DOCTOR = core.RUN + "/doctor.json";
const INIT = "/etc/init.d/hotel";
// Present from `teardown` until the next service start. A tick that was
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
	};
}

function status(ctx, report, led_color) {
	let st = ctx.st, up = ctx.uplink, weight = {};
	for (let id in up.slots)
		weight[id] = (weight[id] ?? 0) + 1;
	let healthy = map(up.healthy, (l) => l.dev);
	return {
		ts: ctx.now,
		ok: report.ok,
		fail: report.fail,
		warn: report.warn,
		uplink: {
			mode: ctx.cfg.uplink.mode,
			role: up.role,
			healthy: length(up.healthy),
			total: length(up.legs),
			slots: join(" ", up.slots),
			legs: map(up.legs, (l) => {
				let s = st.legs[l.dev] ?? {};
				return {
					dev: l.dev, id: l.id, ip: l.ip ?? "", role: l.role,
					healthy: l.dev in healthy,
					http: s.code ?? 0, ttfb: s.ttfb ?? 0,
					rate_bps: int((s.rate ?? 0) * 8),
					weight: weight[l.id] ?? 0,
				};
			}),
		},
		proxy: {
			enabled: ctx.proxy.enabled, running: ctx.proxy.running, on: ctx.proxy.on,
			nodes: ctx.proxy.nodes, fail_open: !!st.proxy?.open,
			canary_ms: st.proxy?.delay ?? 0, canary_fails: st.proxy?.fails ?? 0,
		},
		dns: { smartdns: dns.running(), port: ctx.cfg.dns.port },
		sys: {
			conntrack: system_.conntrack(),
			load1: system_.load(),
			mem_available_kb: system_.mem_available_kb(),
			uptime: ctx.facts.uptime,
		},
		led: led_color,
	};
}

// Ask the supervisor for a tick soon (debounced on its side).
function kick() {
	return system("ubus call service signal '{\"name\":\"hotel\",\"instance\":\"supervisor\",\"signal\":10}' >/dev/null 2>&1");
}

// The pipeline. Order matters: route the legs so they can be probed, decide
// (uplink, proxy), make the kernel match, then the daemons, then report.
function reconcile(ctx) {
	ctx.legs = uplink.discover(ctx.cfg, ctx.facts);
	datapath.plumb(ctx);
	ctx.uplink = uplink.observe(ctx);
	ctx.proxy = proxy.observe(ctx);
	datapath.apply(ctx);
	dns.apply(ctx);
	system_.apply(ctx);
	wifi.apply(ctx);

	// procd owns the daemons; re-registering makes it start a missing one and
	// restart one whose config file changed.
	// A follow-up tick picks the daemon up without waiting a full period; the
	// counter stops that from spinning when a daemon cannot start at all.
	if (ctx.want_service_sync && !core.is_dry()) {
		core.act(INIT + " start");
		if ((ctx.st.resync = (ctx.st.resync ?? 0) + 1) <= 3)
			kick();
	}
	else {
		ctx.st.resync = 0;
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
	core.save_json(STATUS, status(ctx, report, color));
	core.save_json(STATE, ctx.st, 0o600);
	return report;
}

// wait_s > 0 queues behind a running tick instead of giving up.
function locked(fn, wait_s) {
	core.init_dirs();
	let lock = core.lock("tick");
	for (let i = 0; !lock && i < (wait_s ?? 0) * 5; i++) {
		sleep(200);
		lock = core.lock("tick");
	}
	if (!lock) {
		// Normal for the periodic tick: someone is already doing its job.
		if (ARGV[0] != "tick")
			warn("hotel: another run holds the lock\n");
		return 0;
	}
	let rc = fn();
	lock.close();
	return rc;
}

function show(path, refresh) {
	if (refresh || !fs.stat(path))
		locked(() => reconcile(context({})));
	print(fs.readfile(path) ?? "{}\n");
	return 0;
}

const COMMANDS = {
	tick: {
		help: "one reconcile pass (what the supervisor runs)",
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
		help: "dry run: show what a tick would change, touch nothing",
		run: () => {
			core.set_mode({ dry: true });
			let report = reconcile(context({ force: "--full" in ARGV }));
			print(doctor.text(report));
			return 0;
		},
	},
	prepare: {
		help: "render daemon configs and unpack mihomo (used by the init script)",
		run: () => {
			let ctx = context({});
			fs.unlink(STOPPED);
			datapath.listen_addr(ctx.cfg);
			if (ctx.cfg.proxy.enabled)
				proxy.prepare(ctx.cfg, ctx.facts.lan_ip);
			dns.bootstrap(ctx.cfg);
			return 0;
		},
	},
	teardown: {
		help: "remove all kernel state: back to a plain router",
		run: () => locked(() => {
			let ctx = context({});
			fs.writefile(STOPPED, "");
			ctx.legs = [];
			datapath.teardown(ctx);
			dns.teardown(ctx);
			core.save_json(STATE, ctx.st, 0o600);
			return 0;
		}, 90),
	},
	provision: {
		help: "apply the UCI defaults from provision.json (--dry to preview)",
		run: (args) => {
			core.set_mode({ dry: "--dry" in args, verbose: true });
			let changed = system_.provision(context({}));
			print(length(changed) ? "changed: " + join(" ", changed) + "\n" : "nothing to do\n");
			return 0;
		},
	},
	kick: {
		help: "ask the supervisor for an immediate tick",
		run: () => kick(),
	},
	status: {
		help: "last status snapshot as JSON (-r to refresh first)",
		run: (args) => show(STATUS, "-r" in args),
	},
	doctor: {
		help: "health report (json | text)",
		run: (args) => {
			if ("json" in args)
				return show(DOCTOR, true);
			let report;
			locked(() => { report = reconcile(context({})); });
			// Lock busy: a tick is running right now, its report is as fresh.
			report ??= core.load_json(DOCTOR, { ok: false, checks: [], fail: [ "no_report" ], warn: [] });
			print(doctor.text(report));
			return report.ok ? 0 : 1;
		},
	},
	legs: {
		help: "one line per uplink leg",
		run: () => {
			let s = core.load_json(STATUS, null);
			if (!s)
				return 1;
			printf("%-10s %3s %-16s %-7s %4s %6s %9s %s\n", "DEV", "ID", "ADDRESS", "HEALTHY", "HTTP", "TTFB", "KBIT/S", "SLOTS");
			for (let l in s.uplink.legs)
				printf("%-10s %3d %-16s %-7s %4d %6.3f %9d %d\n", l.dev, l.id, l.ip, l.healthy ? "yes" : "no", l.http, l.ttfb, l.rate_bps / 1000, l.weight);
			return 0;
		},
	},
	events: {
		help: "recent state transitions",
		run: (args) => system(sprintf("tail -n %d %s/events.log", int(args[0] ?? "40") || 40, core.RUN)),
	},
	proxy: {
		help: "proxy reload | ui",
		run: (args) => {
			let ctx = context({});
			if (args[0] == "reload") {
				let prep = proxy.prepare(ctx.cfg, ctx.facts.lan_ip);
				return prep && proxy.reload(ctx.cfg, ctx.facts.lan_ip) ? 0 : 1;
			}
			printf("http://%s:%d/ui/\n", ctx.facts.lan_ip, ctx.cfg.proxy.api_port);
			return 0;
		},
	},
	portal: {
		help: "portal via <dev>: route the router's own default through one leg for a manual login",
		run: (args) => {
			let ctx = context({});
			let leg = filter(uplink.discover(ctx.cfg, ctx.facts), (l) => l.dev == args[1])[0];
			if (args[0] != "via" || !leg?.gw) {
				warn("usage: hotel portal via <dev>\n");
				return 1;
			}
			system(sprintf("ip route replace default via %s dev %s metric 1", leg.gw, leg.dev));
			printf("default route now via %s. Log in from a LAN client, then: ip route del default metric 1\n", leg.dev);
			return 0;
		},
	},
};

function usage() {
	warn("usage: hotel <command>\n");
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
