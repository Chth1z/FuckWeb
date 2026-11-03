// braid — command line and the reconcile pipeline.
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

const STATE = core.RUN + "/state.json";
const STATUS = core.RUN + "/status.json";
const DOCTOR = core.RUN + "/doctor.json";
const REQUEST = core.RUN + "/request.json";
const INIT = "/etc/init.d/braid";
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

// Ask braidd for a pass soon. It collapses a burst of asks into one pass.
function kick() {
	return system("ubus call braid reconcile >/dev/null 2>&1");
}

// What braidd and the dashboard need to know about the last pass. Live
// numbers (rates, the current pattern) are added by braidd, not stored here.
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
				dev: s.dev, id: s.id, ip: s.ip ?? "", role: s.role,
				healthy: s.dev in healthy,
				http: h.code ?? 0, ttfb: h.ttfb ?? 0,
				parked: (h.parked ?? 0) > 0,
			};
		}),
		weave: { policy: ctx.cfg.weave.policy, affinity: ctx.cfg.weave.affinity, slots: ctx.weave.slots },
		tunnel: {
			enabled: ctx.tunnel.enabled, running: ctx.tunnel.running, on: ctx.tunnel.on,
			relays: ctx.tunnel.relays, fail_open: !!st.tunnel?.open,
			canary_ms: st.tunnel?.delay ?? 0, canary_fails: st.tunnel?.fails ?? 0,
		},
		dns: { smartdns: dns.running(), port: ctx.cfg.dns.port },
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
			warn("braid: another pass holds the lock\n");
		return 0;
	}
	let rc = fn();
	lock.close();
	return rc;
}

// Live view from braidd; the last snapshot on disk when it is not running.
function live(method) {
	let bus = ubus.connect();
	let res = bus?.call("braid", method, {});
	bus?.disconnect();
	return res ?? (method == "status" ? core.load_json(STATUS, null) : null);
}

function kbit(bytes_per_s) {
	return bytes_per_s * 8 / 1000;
}

const COMMANDS = {
	reconcile: {
		help: "one reconcile pass (what braidd runs)",
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
				tunnel.prepare(ctx.cfg, ctx.facts.lan_ip);
			dns.bootstrap(ctx.cfg);
			return 0;
		},
	},
	teardown: {
		help: "remove all kernel state: back to a plain router",
		run: () => locked(() => {
			let ctx = context({});
			fs.writefile(STOPPED, "");
			ctx.strands = [];
			kernel.teardown(ctx);
			dns.teardown(ctx);
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
		help: "ask braidd for an immediate pass",
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
		help: "one line per strand: health, load, share of new flows",
		run: () => {
			let s = live("status");
			if (!s)
				return 1;
			printf("%-10s %3s %-16s %-8s %4s %6s %10s %10s %5s\n", "STRAND", "ID", "ADDRESS", "HEALTH", "HTTP", "TTFB", "KBIT/S", "PEAK", "SLOTS");
			for (let x in s.strands)
				printf("%-10s %3d %-16s %-8s %4d %6.3f %10.0f %10.0f %5d\n", x.dev, x.id, x.ip,
					x.healthy ? "ok" : (x.parked ? "parked" : "down"), x.http, x.ttfb,
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
				warn("usage: braid portal via <strand>\n");
				return 1;
			}
			system(sprintf("ip route replace default via %s dev %s metric 1", s.gw, s.dev));
			printf("default route now via %s. Log in from a LAN client, then: ip route del default metric 1\n", s.dev);
			return 0;
		},
	},
};

function usage() {
	warn("braid " + core.VERSION + " — many strands, one line\n\nusage: braid <command>\n");
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
