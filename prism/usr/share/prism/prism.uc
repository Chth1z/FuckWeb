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
				http: h.code ?? 0, ttfb: h.ttfb ?? 0, loss: +(sprintf("%.3f", h.loss ?? 0)),
				parked: (h.parked ?? 0) > 0,
			};
		}),
		weave: { policy: ctx.cfg.weave.policy, affinity: ctx.cfg.weave.affinity, slots: ctx.weave.slots },
		tunnel: {
			enabled: ctx.tunnel.enabled, running: ctx.tunnel.running, on: ctx.tunnel.on,
			restored: !!ctx.tunnel.restored, pid: ctx.tunnel.pid ?? "",
			mixed_port: ctx.cfg.tunnel.mixed_port,
			relays: ctx.tunnel.relays, fail_open: false,
			canary_ms: st.tunnel?.delay ?? 0, canary_fails: st.tunnel?.fails ?? 0,
		},
		dns: { smartdns: dns.running(), port: ctx.cfg.dns.port },
		mptcp: kernel.mptcp_state(ctx),
		sys: (() => {
			let la = host.loadavg(), mem = host.mem_info();
			let wan_dev = ctx.cfg.shaper?.device ?? ctx.cfg.strands?.uplink?.[0] ?? "wan";
			return {
				conntrack: host.conntrack(),
				load1: la.load1,
				load5: la.load5,
				load15: la.load15,
				mem_available_kb: mem.available_kb,
				mem_total_kb: mem.total_kb,
				temp_c: host.temp_c(),
				wan: host.wan_stats(wan_dev),
				uptime: ctx.facts.uptime,
			};
		})(),
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
	assert(kernel.plumb(ctx), "strand routing setup failed");
	ctx.health = strands.check(ctx);
	ctx.identity = identity.reconcile(ctx);
	ctx.tunnel = tunnel.observe(ctx);
	ctx.relay_ports = guard.relay_ports(ctx.cfg, ctx);
	ctx.mptcp_eps = facts.ip("mptcp endpoint show");
	ctx.mptcp_ids = {};
	for (let e in ctx.mptcp_eps)
		ctx.mptcp_ids[e.id] = true;
	ctx.weave = weave.plan(ctx);
	assert(kernel.apply(ctx), "datapath update failed");
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

function clean_tok(s) {
	return trim(replace("" + (s ?? ""), /[\r\n\u00a0\u200b-\u200d\ufeff]/g, ""));
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
		// Normal for the periodic pass and fallback `doctor`: someone is already doing its job.
		if (!(clean_tok(ARGV[0]) in [ "reconcile", "doctor" ]))
			warn("prism: another pass holds the lock\n");
		return 0;
	}
	try {
		let rc = fn();
		lock.close();
		return rc;
	}
	catch (e) {
		lock.close();
		die(e);
	}
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

function fmt_ts(ts) {
	if (!ts)
		return "-";
	let t = localtime(ts);
	return sprintf("%02d-%02d %02d:%02d:%02d", t.mon, t.mday, t.hour, t.min, t.sec);
}

function fmt_dur(sec) {
	let s = max(0, int(sec ?? 0));
	let d = int(s / 86400), h = int((s % 86400) / 3600), m = int((s % 3600) / 60);
	if (d > 0)
		return sprintf("%dd %dh %dm", d, h, m);
	if (h > 0)
		return sprintf("%dh %dm", h, m);
	return sprintf("%dm %ds", m, s % 60);
}

function fmt_rate_cli(bps) {
	let b = max(0, (bps ?? 0) * 8);
	if (b >= 1e9) return sprintf("%.2f Gbps", b / 1e9);
	if (b >= 1e6) return sprintf("%.1f Mbps", b / 1e6);
	if (b >= 1e3) return sprintf("%.0f Kbps", b / 1e3);
	return sprintf("%.0f bps", b);
}

function parse_window(s) {
	if (!s || s == "24h" || s == "1d") return 86400;
	if (s == "1h") return 3600;
	if (s == "6h") return 21600;
	if (s == "12h") return 43200;
	if (s == "all") return 31536000;
	let m = match(s, /^([0-9]+)([smhd])$/);
	if (!m) return 86400;
	let mul = m[2] == "s" ? 1 : (m[2] == "m" ? 60 : (m[2] == "h" ? 3600 : 86400));
	return max(60, int(m[1]) * mul);
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
			return report.ok ? 0 : 1;
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
		help: "recent state transitions ([N] [--tag <t>] [--summary [1h|24h|all]] [--raw])",
		run: (args) => {
			let show_summary = false, raw_mode = false, tag = "", limit = 40, win_arg = "24h";
			for (let i = 0; i < length(args); i++) {
				let a = args[i];
				if (a == "--summary" || a == "-s") {
					show_summary = true;
					if (i + 1 < length(args) && substr(args[i + 1], 0, 1) != "-")
						win_arg = args[++i];
				}
				else if (a == "--raw") {
					raw_mode = true;
				}
				else if (a == "--tag" && i + 1 < length(args)) {
					tag = args[++i];
				}
				else if (match(a, /^[0-9]+$/)) {
					limit = max(1, int(a));
				}
			}
			if (show_summary) {
				let win = parse_window(win_arg);
				let sum = core.events_summary(win);
				printf("EVENTS SUMMARY  total=%d  1h=%d  24h=%d  window(%s)=%d  span=%s .. %s\n",
					sum.total, sum.count_1h, sum.count_24h, win_arg, sum.count_window,
					fmt_ts(sum.oldest_ts), fmt_ts(sum.newest_ts));
				if (!length(sum.by_tag)) {
					print("(no events recorded)\n");
					return 0;
				}
				printf("%-12s %6s %6s %7s  %-14s  %s\n", "TAG", "1H", "24H", "TOTAL", "LAST", "LATEST MESSAGE");
				for (let r in sum.by_tag) {
					if (length(tag) && r.tag != lc(tag))
						continue;
					printf("%-12s %6d %6d %7d  %-14s  %s\n",
						r.tag, r.c1h, r.c24h, r.total, fmt_ts(r.last_ts), r.last_msg);
				}
				return 0;
			}
			let rows = reverse(core.read_events(limit, tag));
			for (let ev in rows) {
				if (raw_mode)
					printf("%d %s\n", ev.ts, ev.msg);
				else
					printf("%s  %s\n", fmt_ts(ev.ts), ev.msg);
			}
			return 0;
		},
	},
	report: {
		help: "router & network observability report (json | text)",
		run: (args) => {
			let diag = live("diagnostics");
			let st = live("status") ?? {};
			let doc = live("doctor") ?? core.load_json(DOCTOR, { ok: false, checks: [], fail: [], warn: [] });
			if (!diag) {
				let la = host.loadavg(), mem = host.mem_info();
				let cfg = config.load();
				let wan_dev = cfg.shaper?.device ?? cfg.strands?.uplink?.[0] ?? "wan";
				diag = {
					ts: time(),
					host: {
						conntrack: host.conntrack(),
						load1: la.load1, load5: la.load5, load15: la.load15,
						mem_available_kb: mem.available_kb, mem_total_kb: mem.total_kb,
						temp_c: host.temp_c(), wan: host.wan_stats(wan_dev),
						uptime: core.uptime(),
					},
					daemon: null,
					window_1h: { samples: 0, span_sec: 0 },
					window_24h: { samples: 0, span_sec: 0 },
					qos_drops: { "1:10": 0, "1:20": 0, "1:30": 0, total: 0 },
					events: core.events_summary(86400),
				};
			}
			if ("json" in args) {
				printf("%.2J\n", {
					version: core.VERSION,
					diagnostics: diag,
					doctor: { ok: doc.ok, checks: length(doc.checks ?? []), fail: doc.fail ?? [], warn: doc.warn ?? [] },
					site: st.site ?? null,
					strands: { healthy: st.healthy_count ?? 0, total: st.strand_count ?? 0 },
				});
				return 0;
			}
			let h = diag.host ?? {}, dm = diag.daemon, ev = diag.events ?? {};
			let ct = h.conntrack ?? {}, mem_a = int((h.mem_available_kb ?? 0) / 1024), mem_t = int((h.mem_total_kb ?? 0) / 1024);
			printf("PRISM %s · ROUTER & NETWORK OBSERVABILITY REPORT (%s)\n", core.VERSION, fmt_ts(diag.ts ?? time()));
			printf("------------------------------------------------------------------------\n");
			printf("HOST     uptime=%s  cpu=%.1f%% (softirq=%.1f%%)  temp=%s  load=%.2f/%.2f/%.2f\n",
				fmt_dur(h.uptime), h.cpu_pct ?? 0, h.softirq_pct ?? 0,
				h.temp_c != null ? sprintf("%.1fC", h.temp_c) : "n/a",
				h.load1 ?? 0, h.load5 ?? 0, h.load15 ?? 0);
			printf("MEM/CT   mem=%d/%d MB free  conntrack=%d/%d (%.1f%%)\n",
				mem_a, mem_t, ct.count ?? 0, ct.max ?? 0,
				(ct.max ?? 0) > 0 ? (ct.count ?? 0) * 100.0 / ct.max : 0);
			if (h.wan)
				printf("WAN PHY  dev=%s  link=%s  speed=%dM  flaps=%d  err=%d/%d  drop=%d/%d\n",
					h.wan.dev, h.wan.carrier ? "up" : "down", h.wan.speed ?? 0,
					h.wan.carrier_changes ?? 0, h.wan.rx_errors ?? 0, h.wan.tx_errors ?? 0,
					h.wan.rx_dropped ?? 0, h.wan.tx_dropped ?? 0);
			if (dm)
				printf("DAEMON   uptime=%s  reconcile=%dms (max %dms, fails=%d/%d, rc=%d)  mihomo=%s  1m_buf=%d\n",
					fmt_dur(dm.uptime), dm.reconcile_ms ?? 0, dm.reconcile_max_ms ?? 0,
					dm.reconcile_fails ?? 0, dm.reconcile_total_fails ?? 0, dm.reconcile_last_rc ?? 0,
					dm.mihomo_reachable ? "ok" : "down", dm.samples_1m ?? 0);
			else
				print("DAEMON   prismd offline (disk fallback)\n");
			let qd = diag.qos_drops ?? {};
			printf("QOS DROP 1:10=%d  1:20=%d  1:30=%d  total=%d\n",
				qd["1:10"] ?? 0, qd["1:20"] ?? 0, qd["1:30"] ?? 0, qd.total ?? 0);
			for (let pair in [ [ "1H ", diag.window_1h ], [ "24H", diag.window_24h ] ]) {
				let w = pair[1];
				if (!w || !w.samples)
					continue;
				printf("WIN %s  n=%dm  peak=%s↓/%s↑  rtt=%d/%dms  canary=%d/%dms  cpu=%.1f/%.1f%%  temp=%s  mem_min=%dMB  healthy_min=%d  drops=%d\n",
					pair[0], w.samples, fmt_rate_cli(w.down_peak), fmt_rate_cli(w.up_peak),
					w.rtt_avg_ms ?? 0, w.rtt_max_ms ?? 0, w.canary_avg_ms ?? 0, w.canary_max_ms ?? 0,
					w.cpu_avg ?? 0, w.cpu_max ?? 0,
					w.temp_max != null ? sprintf("%.1fC", w.temp_max) : "n/a",
					w.mem_min_mb ?? 0, w.healthy_min ?? 0, w.qos_drops ?? 0);
			}
			printf("DOCTOR   %s (%d checks, fail=%d, warn=%d)%s\n",
				doc.ok ? "OK" : "FAIL", length(doc.checks ?? []), length(doc.fail ?? []), length(doc.warn ?? []),
				length(doc.fail ?? []) ? " -> " + join(", ", doc.fail) : "");
			printf("EVENTS   total=%d  1h=%d  24h=%d\n", ev.total ?? 0, ev.count_1h ?? 0, ev.count_24h ?? 0);
			for (let r in slice(ev.by_tag ?? [], 0, 10))
				printf("  %-10s 1h=%-4d 24h=%-4d tot=%-5d last=%s  %s\n",
					r.tag, r.c1h, r.c24h, r.total, fmt_ts(r.last_ts), r.last_msg);
			return 0;
		},
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
	led: {
		help: "led [status | mode <m> | bright <5-100> | night <on|off> | demo | color <r> <g> <b>]",
		run: (args) => {
			let sub = args[0] ?? "status", cfg = config.load();
			if (sub == "mode") {
				let m = args[1] ?? "";
				let res = config.store({ "led.mode": m });
				if (!res.ok) {
					warn("led mode: " + res.error + "\n");
					return 1;
				}
				system("ubus call prism reload >/dev/null 2>&1");
				if (!core.ok("ubus list | grep -qx prism"))
					led.tick(config.load(), {});
				printf("led mode -> %s\n", m);
				return 0;
			}
			if (sub == "bright") {
				let res = config.store({ "led.bright": int(args[1] ?? "80") });
				if (!res.ok) {
					warn("led bright: " + res.error + "\n");
					return 1;
				}
				system("ubus call prism reload >/dev/null 2>&1");
				printf("led bright -> %d%%\n", int(args[1] ?? "80"));
				return 0;
			}
			if (sub == "night") {
				let v = (args[1] == "0" || args[1] == "off") ? 0 : 1;
				config.store({ "led.night_dim": v });
				system("ubus call prism reload >/dev/null 2>&1");
				printf("led night_dim -> %d\n", v);
				return 0;
			}
			if (sub == "demo") {
				if (system("ubus call prism led_demo >/dev/null 2>&1") == 0) {
					print("led demo started (6s DSOTM rainbow sweep)\n");
					return 0;
				}
				for (let i = 0; i < 75; i++) {
					led.demo_frame(cfg, i);
					sleep(80);
				}
				led.clear_override();
				led.tick(cfg, {});
				return 0;
			}
			if (sub == "color" && length(args) >= 4) {
				let r = int(args[1]), g = int(args[2]), b = int(args[3]);
				let target = args[4] ?? "both", ttl = int(args[5] ?? "10") || 10;
				let payload = sprintf("%J", { r, g, b, target, ttl });
				if (system("ubus call prism led_color " + core.shq(payload) + " >/dev/null 2>&1") == 0) {
					printf("led color %d %d %d (%s, %ds)\n", r, g, b, target, ttl);
					return 0;
				}
				led.set_override(r, g, b, target, ttl);
				led.tick(cfg, {});
				return 0;
			}
			let info = live("led_view") ?? led.inspect(cfg);
			printf("mode=%-8s bright=%d%% night_dim=%d alert=%s quarantine=%d\n",
				info.mode, info.bright, info.night_dim, info.alert ?? "-", info.quarantine ?? 0);
			for (let role in [ "status", "network" ]) {
				let h = info.hw?.[role];
				if (h)
					printf("  %-8s (%s): trig=%-8s bright=%3d rgb=[%s] %s\n",
						role, h.name, h.trigger, h.brightness, join(",", h.rgb ?? []), h.hex ?? "");
			}
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
			system(sprintf("ip route replace default via %s dev %s metric 1", core.shq(s.gw), core.shq(s.dev)));
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

function sanitize_argv(list) {
	// Strip CR, NBSP, and zero-width chars often introduced by copy/paste into Windows SSH terminals.
	return map(list ?? [], (a, idx) => idx == 0 ? clean_tok(a) : replace("" + a, /[\r\n\u00a0\u200b-\u200d\ufeff]/g, ""));
}

let clean_argv = sanitize_argv(ARGV);
let cmd = COMMANDS[clean_argv[0]];
let rc = 1;
try {
	rc = cmd ? cmd.run(slice(clean_argv, 1)) : usage();
}
catch (e) {
	core.err("%s: %s\n%s", clean_argv[0], e.message, join("\n", map(e.stacktrace ?? [], (f) => sprintf("  at %s:%d", f.filename ?? "?", f.line ?? 0))));
	rc = 2;
}
exit(rc ?? 0);
