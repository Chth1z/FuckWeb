// prismd — the long-lived half of Prism. Three small jobs:
//
//   weave      each sample interval: read per-strand download and upload counters,
//              update each strand's virtual token-bucket credit, keep the
//              dedicated @vip_lane pinned to the lowest-TTFB strand, and
//              re-lay @pattern so new flows harvest charged burst buckets.
//   schedule   run `prism reconcile` on a timer and when asked.
//   serve      publish the ubus object the dashboard and CLI read.

import * as fs from "fs";
import * as uloop from "uloop";
import * as ubus from "ubus";
import * as core from "./lib/core.uc";
import * as config from "./lib/config.uc";
import * as series from "./lib/series.uc";
import * as weave from "./mod/weave.uc";
import * as devices from "./mod/devices.uc";
import * as tunnel from "./mod/tunnel.uc";
import * as identity from "./mod/identity.uc";
import * as host from "./mod/host.uc";
import * as led from "./mod/led.uc";
import * as api from "./mod/api.uc";

const PRISM = "/usr/sbin/prism";
const STATUS = core.RUN + "/status.json";
const QOS_BANDS = [ "1:10", "1:20", "1:30" ];
const DEBOUNCE_MS = 2000;
const HISTORY = 720;                    // samples kept (2s cadence -> 24 min window)
const METRICS_CAP = 1440;               // 1-minute rollup ring buffer (24h window)
const METRICS_CADENCE = 60;             // seconds per rollup sample
const SERIES_CADENCE = 1.9;
const PEAK_DECAY_PER_SEC = 0.999;       // ~0.998 per 2s
const SETTLE = 2;                       // slot changes needed to trigger an update
const TELEMETRY_INTERVAL = 4;           // seconds between dashboard/accounting snapshots

let cfg = config.load();
let snapshot = core.load_json(STATUS, null);
let pattern = weave.current();
let vip_lane = weave.current_vip();
let history = series.create(HISTORY);
let load = {};                          // dev -> { down, up, bucket }
let slow_at = 0, tunnel_flows = [], classify_rules = [];
let lan = { list: [], rate: {}, samples: 0, ts: {} };
let acct = {
	nft: {},
	nft_ts: 0,
	classify: { bytes: 0, packets: 0, bps: 0, _prev_bytes: null },
	cls_ts: 0,
	qos: { mode: "fq_codel", down_cap_mbps: 0, up_cap_mbps: 0, down: {}, up: {} },
	qos_ts: 0,
	mihomo: { reachable: false, down_bytes: 0, up_bytes: 0, down_bps: 0, up_bps: 0, conns: 0, ts: 0 },
};
let controller_busy = {}, proxies = null, selection_epoch = 0;
let sampled = 0, series_at = 0, pattern_at = 0, last_rate = 0, last_down = 0;
let running = false, again = false, first = true, tunnel_ready_for_sync = false;
let demo_active = false, demo_step = 0, demo_timer = null;
let reconcile_timer, sample_timer;
let kick_pending = false, kick, reconcile;
let cpu_prev = null;
let host_sys = null;
let alerts = { thermal: false, mem: false, ct: false, wan_down: false, wan_flaps: null };
let mihomo_down_strikes = 0, mihomo_alarm = false;
let daemon_stats = {
	started_ts: time(),
	sampled_ts: 0,
	reconcile_ms: 0,
	reconcile_max_ms: 0,
	reconcile_ok_ts: 0,
	reconcile_fails: 0,
	reconcile_total_fails: 0,
	reconcile_last_rc: 0,
	reconcile_count: 0,
};
let metrics_ring = { next: 0, rows: [] };
let minute_acc = null;
let prev_qos_drops = null;

function monotonic() {
	let c = clock(true);
	return c[0] + c[1] / 1000000000.0;
}

function healthy() {
	return filter(snapshot?.strands ?? [], (s) => s.healthy);
}

function pattern_diff(a, b) {
	if (length(a) != length(b))
		return { moved: length(b), edge: true };
	let ca = {}, cb = {};
	for (let id in a)
		ca[id] = (ca[id] ?? 0) + 1;
	for (let id in b)
		cb[id] = (cb[id] ?? 0) + 1;
	let moved = 0, edge = false;
	for (let id, n in ca) {
		let d = n - (cb[id] ?? 0);
		if (d > 0)
			moved += d;
		if ((cb[id] ?? 0) == 0)
			edge = true;
	}
	for (let id in cb)
		if ((ca[id] ?? 0) == 0)
			edge = true;
	return { moved, edge };
}

function relay(now) {
	let strands = healthy(), n = snapshot?.weave?.slots ?? 0;
	if (running || !length(strands) || n <= 0)
		return;
	let mptcp_ids = {};
	for (let e in snapshot?.mptcp?.endpoints ?? [])
		mptcp_ids[e.id] = true;
	let next_vip = weave.select_vip(strands, load, mptcp_ids, vip_lane);
	let next = weave.compose(cfg.weave, strands, load, n, next_vip);
	let vip_changed = (next_vip[0] ?? 0) != (vip_lane[0] ?? 0);
	let d = pattern_diff(pattern, next);
	if (!vip_changed && !d.edge) {
		if (d.moved <= SETTLE)
			return;
		if (d.moved < 10 && pattern_at && now - pattern_at < 5)
			return;
	}
	let lock = core.lock("reconcile");
	if (!lock)
		return;
	try {
		if (weave.program(next, vip_changed ? next_vip : null)) {
			if (vip_changed) {
				let prev_id = (vip_lane[0] ?? 0) & 0xff;
				let next_id = (next_vip[0] ?? 0) & 0xff;
				if (prev_id > 0 && next_id > 0 && prev_id != next_id) {
					let find_s = (id) => filter(snapshot?.strands ?? [], (s) => s.id == id)[0];
					let ps = find_s(prev_id), ns = find_s(next_id);
					let nms = int(((ns?.ttfb ?? 0) * 1000) + 0.5);
					core.event("VIP %s -> %s (%dms)", ps?.dev ?? ("#" + prev_id), ns?.dev ?? ("#" + next_id), nms);
				}
			}
			pattern = next;
			vip_lane = next_vip;
			pattern_at = now;
		}
		lock.close();
	}
	catch (e) {
		lock.close();
		core.err("weave relay: %s", e.message ?? e);
	}
}

function sample_devices(now) {
	for (let dir in [ "up", "down" ]) {
		let cur = weave.counters("dev_" + dir);
		if (!cur)
			continue;
		let dt = lan.ts[dir] ? now - lan.ts[dir] : 0;
		lan.ts[dir] = now;
		for (let ip, bytes in cur) {
			let r = (lan.rate[ip] ??= {}), prev = r[dir + "_bytes"];
			r[dir] = (prev != null && bytes >= prev && dt > 0) ? (bytes - prev) / dt : 0;
			r[dir + "_bytes"] = bytes;
		}
		for (let ip, r in lan.rate)
			if (cur[ip] == null) {
				delete r[dir + "_bytes"];
				r[dir] = 0;
				if (r.up_bytes == null && r.down_bytes == null)
					delete lan.rate[ip];
			}
	}
	if (lan.samples % 2 == 0)
		lan.list = devices.scan(cfg);
	lan.samples++;
}

function start_demo() {
	demo_active = true;
	demo_step = 0;
	if (demo_timer) {
		demo_timer.cancel();
		demo_timer = null;
	}
	let step_fn;
	step_fn = () => {
		if (!demo_active)
			return;
		if (demo_step >= 75) {
			demo_active = false;
			demo_timer = null;
			led.clear_override();
			led.tick(cfg, { rate_bytes: last_rate });
			return;
		}
		led.demo_frame(cfg, demo_step++);
		demo_timer.set(80);
	};
	demo_timer = uloop.timer(10, step_fn);
	return { ok: true, duration: 6 };
}

function sync_lan_cfg() {
	cfg = config.load();
	if (!demo_active)
		led.tick(cfg, { rate_bytes: last_rate });
	let known = {};
	for (let d in cfg.devices)
		known[d.mac] = d;
	let seen = {};
	for (let x in lan.list) {
		seen[x.mac] = true;
		let k = known[x.mac];
		x.policy = k?.policy ?? "auto";
		x.named = !!k?.name;
		x.name = k?.name || x.host || "";
	}
	for (let d in cfg.devices) {
		if (!seen[d.mac])
			push(lan.list, {
				mac: d.mac, ip: "", host: "", name: d.name || "",
				named: !!d.name, link: "wired", signal: 0, online: false,
				policy: d.policy ?? "auto",
			});
	}
}

function device_view() {
	let rate_map = {};
	for (let x in lan.list)
		if (x.ip && lan.rate[x.ip])
			rate_map[x.ip] = lan.rate[x.ip];
	let v = identity.view(cfg, map(lan.list, (x) => {
		let r = lan.rate[x.ip] ?? {};
		return { ...x, up: int(r.up ?? 0), down: int(r.down ?? 0), up_bytes: r.up_bytes ?? 0, down_bytes: r.down_bytes ?? 0 };
	}), rate_map);
	return v;
}

function acc_delta(slot, bytes, packets, dt) {
	let prev = slot._prev_bytes;
	slot.bps = (prev != null && bytes >= prev && dt > 0) ? (bytes - prev) / dt : 0;
	slot._prev_bytes = bytes;
	slot.bytes = bytes;
	slot.packets = packets;
}

function read_tc_htb(dev) {
	if (!length(dev))
		return null;
	let r = core.sh("exec tc -j -s class show dev " + core.shq(dev) + " parent 1:");
	if (r.code != 0 || !length(trim(r.out)))
		return null;
	try {
		let arr = json(r.out), out = { cap_mbps: 0, bands: {} };
		for (let item in (type(arr) == "array" ? arr : [])) {
			if (item.class != "htb")
				continue;
			if (item.handle == "1:1")
				out.cap_mbps = int(((item.ceil ?? 0) * 8) / 1000000 + 0.5);
			else if (item.handle in QOS_BANDS) {
				let s = item.stats ?? {};
				out.bands[item.handle] = {
					bytes: s.bytes ?? 0,
					packets: s.packets ?? 0,
					drops: s.drops ?? 0,
					overlimits: s.overlimits ?? 0,
				};
			}
		}
		if (!length(keys(out.bands)))
			return null;
		let leaves = core.sh("exec tc -j -s qdisc show dev " + core.shq(dev));
		if (leaves.code != 0)
			return null;
		for (let q in json(leaves.out))
			if (out.bands[q.parent])
				out.bands[q.parent].drops = q.drops;
		return out;
	}
	catch (e) {
		core.err("tc statistics for %s: %s", dev, e.message);
		return null;
	}
}

function sample_qos_dir(dir_map, raw, dt) {
	for (let b in QOS_BANDS) {
		let slot = (dir_map[b] ??= { bytes: 0, packets: 0, drops: 0, overlimits: 0, bps: 0, _prev_bytes: null });
		let s = raw?.bands?.[b];
		if (s) {
			acc_delta(slot, s.bytes, s.packets, dt);
			slot.drops = s.drops;
			slot.overlimits = s.overlimits;
		}
		else {
			slot.bps = 0;
			slot._prev_bytes = null;
		}
	}
}

function sample_counters_and_qos(now) {
	let nc = weave.named_counters();
	if (nc) {
		let dt_nft = acct.nft_ts > 0 ? now - acct.nft_ts : 0;
		acct.nft_ts = now;
		for (let name, c in nc) {
			let slot = (acct.nft[name] ??= { bytes: 0, packets: 0, bps: 0, _prev_bytes: null });
			acc_delta(slot, c.bytes ?? 0, c.packets ?? 0, dt_nft);
		}
	}
	let rules = weave.classify_counters();
	if (length(rules)) {
		classify_rules = rules;
		let dt_cls = acct.cls_ts > 0 ? now - acct.cls_ts : 0;
		acct.cls_ts = now;
		let b = 0, p = 0;
		for (let r in rules) {
			b += r.bytes ?? 0;
			p += r.packets ?? 0;
		}
		acc_delta(acct.classify, b, p, dt_cls);
	}
	let htb_down = read_tc_htb(cfg.main.lan_dev?.[0] ?? "");
	let htb_up = read_tc_htb(cfg.shaper?.device ?? "");
	let dt_qos = acct.qos_ts > 0 ? now - acct.qos_ts : 0;
	acct.qos_ts = now;
	if (htb_down || htb_up) {
		acct.qos.mode = "htb";
		acct.qos.down_cap_mbps = htb_down?.cap_mbps ?? 0;
		acct.qos.up_cap_mbps = htb_up?.cap_mbps ?? 0;
		sample_qos_dir(acct.qos.down, htb_down, dt_qos);
		sample_qos_dir(acct.qos.up, htb_up, dt_qos);
	}
	else {
		acct.qos.mode = "fq_codel";
		acct.qos.down_cap_mbps = 0;
		acct.qos.up_cap_mbps = 0;
		for (let dir_map in [ acct.qos.down, acct.qos.up ])
			for (let b in QOS_BANDS)
				if (dir_map[b]) {
					dir_map[b].bps = 0;
					dir_map[b]._prev_bytes = null;
				}
	}
}

function poll_controller(resource, callback) {
	if (controller_busy[resource] || !snapshot?.lan_ip)
		return;
	let file = fs.mkstemp();
	assert(file, fs.error());
	let path = fs.realpath("/proc/self") + "/fd/" + file.fileno();
	let url = sprintf("http://%s:%d/%s", snapshot.lan_ip, cfg.tunnel.controller_port, resource);
	controller_busy[resource] = true;
	let child = uloop.process("/usr/bin/curl", [ "-4", "--noproxy", "*", "-fsS", "-m", "2",
		"-H", "Authorization: Bearer " + (core.read(core.ETC + "/controller.secret") ?? ""), "-o", path, url ], {}, (code) => {
		delete controller_busy[resource];
		let payload = null;
		if (code == 0) {
			try {
				file.seek(0);
				let raw = file.read("all");
				payload = length(raw) ? json(raw) : null;
			}
			catch (e) { core.err("controller /%s: %s", resource, e.message); }
		}
		file.close();
		callback(payload);
	});
	if (!child) {
		core.err("cannot start controller /%s poll: %s", resource, uloop.error());
		delete controller_busy[resource];
		file.close();
		callback(null);
	}
}

function poll_mihomo_stats() {
	if (!snapshot?.tunnel?.running) {
		proxies = null;
		tunnel_flows = [];
		acct.mihomo.conns = 0;
		acct.mihomo.reachable = false;
		acct.mihomo.down_bps = 0;
		acct.mihomo.up_bps = 0;
		return;
	}
	let epoch = selection_epoch, pid = snapshot.tunnel.pid;
	if (!running && tunnel_ready_for_sync)
		poll_controller("proxies", (j) => {
			if (running || epoch != selection_epoch)
				return;
			if (core.read("/proc/" + pid + "/comm") != "mihomo") {
				proxies = null;
				tunnel_ready_for_sync = false;
				kick(100);
				return;
			}
			proxies = j?.proxies;
			if (proxies)
				tunnel.persist_selected(proxies);
		});
	poll_controller("connections", (j) => {
		if (j?.downloadTotal == null || j?.uploadTotal == null) {
			acct.mihomo.reachable = false;
			acct.mihomo.down_bps = acct.mihomo.up_bps = acct.mihomo.conns = 0;
			tunnel_flows = [];
			if (snapshot?.tunnel?.running && !running) {
				mihomo_down_strikes++;
				if (mihomo_down_strikes == 3 && !mihomo_alarm) {
					mihomo_alarm = true;
					core.event("MIHOMO controller unreachable");
				}
			}
			return;
		}
		mihomo_down_strikes = 0;
		if (mihomo_alarm) {
			mihomo_alarm = false;
			core.event("MIHOMO controller restored");
		}
		let dl = j.downloadTotal, ul = j.uploadTotal, conns = length(j.connections);
		tunnel_flows = api.tunnel_flows(j.connections);
		let now_ts = monotonic(), prev_ts = acct.mihomo.ts, dt = prev_ts > 0 ? now_ts - prev_ts : 0;
		if (dt > 0) {
			acct.mihomo.down_bps = dl >= acct.mihomo.down_bytes ? (dl - acct.mihomo.down_bytes) / dt : 0;
			acct.mihomo.up_bps = ul >= acct.mihomo.up_bytes ? (ul - acct.mihomo.up_bytes) / dt : 0;
		}
		acct.mihomo.down_bytes = dl;
		acct.mihomo.up_bytes = ul;
		acct.mihomo.conns = conns;
		acct.mihomo.reachable = true;
		acct.mihomo.ts = now_ts;
	});
}

function branch_pair(pfx) {
	let u = acct.nft[pfx + "_up"] ?? {}, d = acct.nft[pfx + "_down"] ?? {};
	let down_bps = int(d.bps ?? 0), up_bps = int(u.bps ?? 0);
	let down_bytes = d.bytes ?? 0, up_bytes = u.bytes ?? 0;
	return {
		down_bps,
		up_bps,
		bps: down_bps + up_bps,
		down_bytes,
		up_bytes,
		bytes: down_bytes + up_bytes,
		packets: (d.packets ?? 0) + (u.packets ?? 0),
	};
}

function telemetry_view() {
	let vip = branch_pair("vip");
	let dom = branch_pair("dom");
	let ktun = branch_pair("tun");
	let m = acct.mihomo;
	let m_down_bps = m.reachable ? int(m.down_bps) : ktun.down_bps;
	let m_up_bps = m.reachable ? int(m.up_bps) : ktun.up_bps;
	let m_down_b = m.reachable ? m.down_bytes : ktun.down_bytes;
	let m_up_b = m.reachable ? m.up_bytes : ktun.up_bytes;
	let bands = {};
	for (let b in QOS_BANDS) {
		if (acct.qos.mode == "htb") {
			let ld = acct.qos.down[b] ?? {}, wu = acct.qos.up[b] ?? {};
			let db = int(ld.bps ?? 0), ub = int(wu.bps ?? 0);
			bands[b] = {
				bps: db + ub,
				down_bps: db,
				up_bps: ub,
				bytes: (ld.bytes ?? 0) + (wu.bytes ?? 0),
				packets: (ld.packets ?? 0) + (wu.packets ?? 0),
				drops: (ld.drops ?? 0) + (wu.drops ?? 0),
				overlimits: (ld.overlimits ?? 0) + (wu.overlimits ?? 0),
			};
		}
		else {
			let q = acct.nft["qos_" + split(b, ":")[1]] ?? {};
			bands[b] = {
				bps: int(q.bps ?? 0),
				down_bps: 0,
				up_bps: 0,
				bytes: q.bytes ?? 0,
				packets: q.packets ?? 0,
				drops: 0,
				overlimits: 0,
			};
		}
	}
	return {
		branches: {
			vip,
			tunnel: {
				down_bps: m_down_bps,
				up_bps: m_up_bps,
				bps: m_down_bps + m_up_bps,
				down_bytes: m_down_b,
				up_bytes: m_up_b,
				bytes: m_down_b + m_up_b,
				conns: m.conns ?? 0,
				reachable: !!m.reachable,
				k_down_bps: ktun.down_bps,
				k_up_bps: ktun.up_bps,
				k_bps: ktun.bps,
				k_down_bytes: ktun.down_bytes,
				k_up_bytes: ktun.up_bytes,
				k_bytes: ktun.bytes,
				k_packets: ktun.packets,
			},
			direct: dom,
		},
		classify: {
			bps: int(acct.classify.bps ?? 0),
			packets: acct.classify.packets ?? 0,
			bytes: acct.classify.bytes ?? 0,
		},
		qos: {
			mode: acct.qos.mode,
			down_cap_mbps: acct.qos.down_cap_mbps,
			up_cap_mbps: acct.qos.up_cap_mbps,
			bands,
		},
	};
}

function qos_drops_now() {
	let out = { "1:10": 0, "1:20": 0, "1:30": 0, total: 0 };
	if (acct.qos.mode != "htb")
		return out;
	for (let b in QOS_BANDS) {
		let d = (acct.qos.down[b]?.drops ?? 0) + (acct.qos.up[b]?.drops ?? 0);
		out[b] = d;
		out.total += d;
	}
	return out;
}

function sample_host() {
	let la = host.loadavg();
	let mem = host.mem_info();
	let ct = host.conntrack();
	let tc = host.temp_c();
	let cs = host.cpu_sample();
	let cpu_pct = host_sys?.cpu_pct ?? 0;
	let softirq_pct = host_sys?.softirq_pct ?? 0;
	if (cs && cpu_prev) {
		let dt = cs.total - cpu_prev.total;
		if (dt > 0) {
			let busy = max(0, dt - max(0, cs.idle - cpu_prev.idle));
			let sirq = max(0, cs.softirq - cpu_prev.softirq);
			cpu_pct = +(sprintf("%.1f", min(100.0, busy * 100.0 / dt)));
			softirq_pct = +(sprintf("%.1f", min(100.0, sirq * 100.0 / dt)));
		}
	}
	if (cs)
		cpu_prev = cs;

	let wan_dev = cfg.shaper?.device ?? cfg.strands?.uplink?.[0] ?? "wan";
	let wan = host.wan_stats(wan_dev);
	let now_ts = time();

	host_sys = {
		conntrack: ct,
		load1: la.load1,
		load5: la.load5,
		load15: la.load15,
		mem_available_kb: mem.available_kb,
		mem_total_kb: mem.total_kb,
		mem_free_kb: mem.free_kb,
		mem_cached_kb: mem.cached_kb,
		cpu_pct,
		softirq_pct,
		temp_c: tc,
		uptime: core.uptime(),
		wan,
		sampled_ts: now_ts,
	};

	// Hysteresis-guarded anomaly edge alerts (logs only on state transitions).
	if (tc != null) {
		if (!alerts.thermal && tc >= 78.0) {
			alerts.thermal = true;
			core.event("SYS thermal high %.1fC", tc);
		}
		else if (alerts.thermal && tc <= 72.0) {
			alerts.thermal = false;
			core.event("SYS thermal normal %.1fC", tc);
		}
	}
	let mem_mb = int((mem.available_kb ?? 0) / 1024);
	if (mem.total_kb > 0) {
		if (!alerts.mem && mem_mb < 40) {
			alerts.mem = true;
			core.event("SYS memory low %dMB free", mem_mb);
		}
		else if (alerts.mem && mem_mb >= 56) {
			alerts.mem = false;
			core.event("SYS memory normal %dMB free", mem_mb);
		}
	}
	if (ct.max > 0) {
		let ct_pct = int(ct.count * 100 / ct.max);
		if (!alerts.ct && ct_pct >= 80) {
			alerts.ct = true;
			core.event("SYS conntrack high %d%% (%d/%d)", ct_pct, ct.count, ct.max);
		}
		else if (alerts.ct && ct_pct <= 70) {
			alerts.ct = false;
			core.event("SYS conntrack normal %d%%", ct_pct);
		}
	}
	if (wan) {
		if (!alerts.wan_down && !wan.carrier) {
			alerts.wan_down = true;
			core.event("WAN link down (%s)", wan.dev);
		}
		else if (alerts.wan_down && wan.carrier) {
			alerts.wan_down = false;
			core.event("WAN link up (%s %dM)", wan.dev, wan.speed);
		}
		if (alerts.wan_flaps != null && wan.carrier_changes > alerts.wan_flaps)
			core.event("WAN carrier flap #%d (%s %dM)", wan.carrier_changes, wan.dev, wan.speed);
		alerts.wan_flaps = wan.carrier_changes;
	}
}

function mean_healthy_rtt_ms() {
	let sum = 0, n = 0;
	for (let s in snapshot?.strands ?? []) {
		if (s.healthy && (s.ttfb ?? 0) > 0) {
			sum += s.ttfb * 1000.0;
			n++;
		}
	}
	return n > 0 ? int(sum / n + 0.5) : 0;
}

function make_minute_row(acc, now_ts) {
	let n = max(1, acc.samples);
	let qd = qos_drops_now().total;
	let drop_delta = (prev_qos_drops != null && qd >= prev_qos_drops) ? (qd - prev_qos_drops) : 0;
	prev_qos_drops = qd;
	return {
		ts: now_ts,
		down_avg: int(acc.down_sum / n),
		down_peak: int(acc.down_peak),
		up_avg: int(acc.up_sum / n),
		up_peak: int(acc.up_peak),
		healthy: acc.healthy_min,
		rtt_ms: mean_healthy_rtt_ms(),
		canary_ms: snapshot?.tunnel?.canary_ms ?? 0,
		cpu_pct: +(sprintf("%.1f", acc.cpu_sum / max(1, acc.host_samples))),
		cpu_max: acc.cpu_max,
		softirq_max: acc.softirq_max,
		temp_c: acc.temp_max,
		mem_min_mb: acc.mem_min_mb,
		ct_max: acc.ct_max,
		qos_drops: drop_delta,
	};
}

function record_minute(now_mono, down_now, up_now) {
	let now_ts = time();
	let h_cnt = length(healthy());
	let hs = host_sys;
	let mem_mb = hs ? int((hs.mem_available_kb ?? 0) / 1024) : 0;
	let ct_cnt = hs?.conntrack?.count ?? 0;
	if (!minute_acc) {
		minute_acc = {
			started_mono: now_mono,
			samples: 0, host_samples: 0,
			down_sum: 0, up_sum: 0, down_peak: 0, up_peak: 0,
			healthy_min: h_cnt,
			cpu_sum: 0, cpu_max: 0, softirq_max: 0,
			temp_max: hs?.temp_c,
			mem_min_mb: mem_mb,
			ct_max: ct_cnt,
		};
	}
	let a = minute_acc;
	a.samples++;
	a.down_sum += down_now;
	a.up_sum += up_now;
	if (down_now > a.down_peak) a.down_peak = down_now;
	if (up_now > a.up_peak) a.up_peak = up_now;
	if (h_cnt < a.healthy_min) a.healthy_min = h_cnt;
	if (hs) {
		a.host_samples++;
		a.cpu_sum += hs.cpu_pct ?? 0;
		if ((hs.cpu_pct ?? 0) > a.cpu_max) a.cpu_max = hs.cpu_pct;
		if ((hs.softirq_pct ?? 0) > a.softirq_max) a.softirq_max = hs.softirq_pct;
		if (hs.temp_c != null && (a.temp_max == null || hs.temp_c > a.temp_max)) a.temp_max = hs.temp_c;
		if (mem_mb > 0 && (a.mem_min_mb == 0 || mem_mb < a.mem_min_mb)) a.mem_min_mb = mem_mb;
		if (ct_cnt > a.ct_max) a.ct_max = ct_cnt;
	}
	if (now_mono - a.started_mono >= METRICS_CADENCE) {
		let row = make_minute_row(a, now_ts);
		metrics_ring.rows[metrics_ring.next] = row;
		metrics_ring.next = (metrics_ring.next + 1) % METRICS_CAP;
		minute_acc = null;
	}
}

function dump_metrics(window_sec) {
	let n = length(metrics_ring.rows), now_ts = time(), cutoff = now_ts - window_sec;
	let out = [];
	if (n > 0) {
		let start = n < METRICS_CAP ? 0 : metrics_ring.next;
		for (let i = 0; i < n; i++) {
			let r = metrics_ring.rows[(start + i) % n];
			if (r && r.ts >= cutoff)
				push(out, r);
		}
	}
	if (minute_acc && minute_acc.samples > 0) {
		let a = minute_acc, s = max(1, a.samples);
		push(out, {
			ts: now_ts,
			down_avg: int(a.down_sum / s),
			down_peak: int(a.down_peak),
			up_avg: int(a.up_sum / s),
			up_peak: int(a.up_peak),
			healthy: a.healthy_min,
			rtt_ms: mean_healthy_rtt_ms(),
			canary_ms: snapshot?.tunnel?.canary_ms ?? 0,
			cpu_pct: +(sprintf("%.1f", a.cpu_sum / max(1, a.host_samples))),
			cpu_max: a.cpu_max,
			softirq_max: a.softirq_max,
			temp_c: a.temp_max,
			mem_min_mb: a.mem_min_mb,
			ct_max: a.ct_max,
			qos_drops: 0,
		});
	}
	return out;
}

function summarize_window(window_sec) {
	let rows = dump_metrics(window_sec);
	if (!length(rows))
		return { samples: 0, span_sec: 0 };
	let down_peak = 0, up_peak = 0, rtt_sum = 0, rtt_n = 0, rtt_max = 0;
	let can_sum = 0, can_n = 0, can_max = 0;
	let cpu_sum = 0, cpu_max = 0, softirq_max = 0;
	let temp_sum = 0, temp_n = 0, temp_max = null;
	let mem_min = 0, ct_max = 0, healthy_min = null, qos_drops = 0;
	for (let r in rows) {
		if (r.down_peak > down_peak) down_peak = r.down_peak;
		if (r.up_peak > up_peak) up_peak = r.up_peak;
		if (r.rtt_ms > 0) {
			rtt_sum += r.rtt_ms;
			rtt_n++;
			if (r.rtt_ms > rtt_max) rtt_max = r.rtt_ms;
		}
		if (r.canary_ms > 0) {
			can_sum += r.canary_ms;
			can_n++;
			if (r.canary_ms > can_max) can_max = r.canary_ms;
		}
		cpu_sum += r.cpu_pct ?? 0;
		if ((r.cpu_max ?? 0) > cpu_max) cpu_max = r.cpu_max;
		if ((r.softirq_max ?? 0) > softirq_max) softirq_max = r.softirq_max;
		if (r.temp_c != null) {
			temp_sum += r.temp_c;
			temp_n++;
			if (temp_max == null || r.temp_c > temp_max) temp_max = r.temp_c;
		}
		if (r.mem_min_mb > 0 && (mem_min == 0 || r.mem_min_mb < mem_min)) mem_min = r.mem_min_mb;
		if ((r.ct_max ?? 0) > ct_max) ct_max = r.ct_max;
		if (healthy_min == null || r.healthy < healthy_min) healthy_min = r.healthy;
		qos_drops += r.qos_drops ?? 0;
	}
	let n = length(rows);
	return {
		samples: n,
		span_sec: max(0, rows[n - 1].ts - rows[0].ts),
		down_peak,
		up_peak,
		rtt_avg_ms: rtt_n > 0 ? int(rtt_sum / rtt_n + 0.5) : 0,
		rtt_max_ms: rtt_max,
		canary_avg_ms: can_n > 0 ? int(can_sum / can_n + 0.5) : 0,
		canary_max_ms: can_max,
		cpu_avg: +(sprintf("%.1f", cpu_sum / n)),
		cpu_max,
		softirq_max,
		temp_avg: temp_n > 0 ? +(sprintf("%.1f", temp_sum / temp_n)) : null,
		temp_max,
		mem_min_mb: mem_min,
		ct_max,
		healthy_min: healthy_min ?? 0,
		qos_drops,
	};
}

function daemon_health() {
	return {
		version: core.VERSION,
		started_ts: daemon_stats.started_ts,
		uptime: max(0, time() - daemon_stats.started_ts),
		sampled_ts: daemon_stats.sampled_ts,
		reconcile_ms: daemon_stats.reconcile_ms,
		reconcile_max_ms: daemon_stats.reconcile_max_ms,
		reconcile_ok_ts: daemon_stats.reconcile_ok_ts,
		reconcile_fails: daemon_stats.reconcile_fails,
		reconcile_total_fails: daemon_stats.reconcile_total_fails,
		reconcile_last_rc: daemon_stats.reconcile_last_rc,
		reconcile_count: daemon_stats.reconcile_count,
		mihomo_reachable: !!acct.mihomo.reachable,
		samples_1m: length(metrics_ring.rows),
	};
}

function diagnostics_view() {
	return {
		ts: time(),
		host: host_sys ?? snapshot?.sys ?? {},
		daemon: daemon_health(),
		window_1h: summarize_window(3600),
		window_24h: summarize_window(86400),
		qos_drops: qos_drops_now(),
		events: core.events_summary(86400),
	};
}

function sample() {
	sample_timer.set(max(1, cfg.weave.interval) * 1000);
	let counted = { down: weave.counters("strands"), up: weave.counters("strands_up") }, now = monotonic();
	if (!slow_at || now - slow_at >= TELEMETRY_INTERVAL) {
		slow_at = now;
		sample_host();
		sample_counters_and_qos(now);
		sample_devices(now);
		poll_mihomo_stats();
	}
	daemon_stats.sampled_ts = time();
	if (!counted.down || !counted.up)
		return;
	let dt = sampled ? now - sampled : 0, alpha = cfg.weave.smoothing;
	let record_series = !series_at || (now - series_at >= SERIES_CADENCE);
	let decay = dt > 0 ? max(0.90, 1.0 - (1.0 - PEAK_DECAY_PER_SEC) * dt) : PEAK_DECAY_PER_SEC;
	let total = { down: 0, up: 0 }, per = {}, per_up = {};
	for (let dev in keys(counted.down)) {
		let l = (load[dev] ??= {
			down: { bytes: null, now: 0, rate: 0, peak: 0 },
			up: { bytes: null, now: 0, rate: 0, peak: 0 },
			bucket: { tokens: weave.BURST_MAX, state: "charged" },
		});
		for (let dir in [ "down", "up" ]) {
			let d = l[dir], bytes = counted[dir]?.[dev] ?? 0;
			if (d.bytes != null && bytes >= d.bytes && dt > 0) {
				d.now = (bytes - d.bytes) / dt;
				d.rate = alpha * d.now + (1 - alpha) * d.rate;
				if (d.rate < 0.5)
					d.rate = 0;
			}
			else {
				d.now = d.rate = 0;
			}
			d.bytes = bytes;
			d.peak = max(d.rate, d.peak * decay);
			if (d.peak < 0.5)
				d.peak = 0;
			total[dir] += d.now;
		}
		per[dev] = l.down.now;
		per_up[dev] = l.up.now;
	}
	for (let dev in keys(load))
		if (counted.down[dev] == null)
			delete load[dev];
	weave.update_buckets(load, dt, cfg.weave.strand_kbit > 0 ? cfg.weave.strand_kbit * 125 : weave.CIR_BYTES_S);
	sampled = now;
	last_down = total.down;
	last_rate = total.down + total.up;
	if (!demo_active)
		led.tick(cfg, { rate_bytes: last_rate });
	if (record_series) {
		series_at = now;
		series.add(history, time(), total.down, total.up, per, per_up);
	}
	record_minute(now, total.down, total.up);
	relay(now);
}

kick = function(delay_ms) {
	if (kick_pending)
		return;
	kick_pending = true;
	uloop.timer(delay_ms, () => {
		kick_pending = false;
		reconcile();
	});
};

reconcile = function() {
	if (running) {
		again = true;
		return;
	}
	running = true;
	selection_epoch++;
	let started = monotonic();
	let args = first ? [ "reconcile", "--boot" ] : [ "reconcile" ];
	let child = uloop.process(PRISM, args, {}, (code) => {
		running = false;
		let dur_ms = int((monotonic() - started) * 1000);
		daemon_stats.reconcile_ms = dur_ms;
		if (dur_ms > daemon_stats.reconcile_max_ms)
			daemon_stats.reconcile_max_ms = dur_ms;
		daemon_stats.reconcile_last_rc = code;
		daemon_stats.reconcile_count++;
		cfg = config.load();
		reconcile_timer.set(max(10, cfg.main.tick) * 1000);
		if (code == 0) {
			let prev_fails = daemon_stats.reconcile_fails;
			daemon_stats.reconcile_fails = 0;
			daemon_stats.reconcile_ok_ts = time();
			if (prev_fails > 0)
				core.event("RECONCILE recovered (%dms after %df)", dur_ms, prev_fails);
			else if (dur_ms >= 20000)
				core.event("RECONCILE slow %.1fs", dur_ms / 1000.0);
			first = false;
			snapshot = core.load_json(STATUS, snapshot);
			tunnel_ready_for_sync = !!(snapshot?.tunnel?.running && snapshot?.tunnel?.restored);
			pattern = weave.current();
			vip_lane = weave.current_vip();
			relay(monotonic());
			if (!demo_active)
				led.tick(cfg, { rate_bytes: last_rate });
		}
		else {
			daemon_stats.reconcile_fails++;
			daemon_stats.reconcile_total_fails++;
			tunnel_ready_for_sync = false;
			core.err("reconcile exited %d (%dms)", code, dur_ms);
			if (daemon_stats.reconcile_fails == 1 || daemon_stats.reconcile_fails % 5 == 0)
				core.event("RECONCILE failed rc=%d (%dms, #%d)", code, dur_ms, daemon_stats.reconcile_fails);
		}
		if (again) {
			again = false;
			kick(DEBOUNCE_MS);
		}
	});
	assert(child, "cannot start reconciler: " + uloop.error());
};

core.init_dirs();
if (!core.is_dry())
	core.event("DAEMON started v%s", core.VERSION);
sample_host();
uloop.init();

reconcile_timer = uloop.timer(1, reconcile);
sample_timer = uloop.timer(1000, sample);

uloop.signal("USR1", () => kick(DEBOUNCE_MS));
uloop.signal("TERM", () => uloop.end());

let bus = ubus.connect();
let published = bus.publish("prism", api.methods({
	cfg: () => cfg,
	snapshot: () => snapshot,
	load: () => load,
	pattern: () => pattern,
	vip: () => vip_lane,
	history: () => history,
	telemetry: telemetry_view,
	host_sys: () => host_sys,
	daemon_health,
	diagnostics: diagnostics_view,
	rate_peak: () => {
		let pk = int(last_down);
		for (let v in history.total)
			if (v > pk)
				pk = v;
		return pk;
	},
	devices: device_view,
	led_view: () => led.inspect(cfg),
	led_demo: start_demo,
	led_color: (a) => {
		demo_active = false;
		if (demo_timer) {
			demo_timer.cancel();
			demo_timer = null;
		}
		led.set_override(a.r ?? 0, a.g ?? 0, a.b ?? 0, a.target ?? "both", a.ttl ?? 10);
		led.tick(cfg, { rate_bytes: last_rate });
		return { ok: true };
	},
	interval: () => cfg.weave.interval,
	series_interval: () => max(2, cfg.weave.interval),
	proxies: () => proxies,
	selected: (group, name) => {
		selection_epoch++;
		if (proxies?.[group])
			proxies[group].now = name;
	},
	rules: () => classify_rules,
	tunnel_flows: () => tunnel_flows,
	tunnel_sampled: () => acct.mihomo.ts,
	now: monotonic,
	kick: () => kick(DEBOUNCE_MS / 4),
	reload: sync_lan_cfg,
	set_device: (a) => {
		let mac = lc(a.mac ?? ""), name = a.name ?? "", policy = a.policy || "auto";
		let anchor = identity.mac_anchor(mac);
		let res = config.device_store(anchor, name, policy);
		if (res.ok) {
			let p = identity.update_profile_policy(anchor, name, policy, cfg);
			if (!p && (policy != "block" || length(trim(name))))
				identity.claim({ mac: anchor, action: "new", alias: name, policy }, cfg);
			core.event("DEVICE %s policy=%s name=%s", anchor, policy, name);
			sync_lan_cfg();
			kick(100);
		}
		return res;
	},
	claim: (a) => {
		let res = identity.claim(a, cfg);
		if (res.ok) {
			sync_lan_cfg();
			kick(100);
		}
		return res;
	},
}));
if (!published)
	core.err("cannot publish ubus object: %s", ubus.error());

uloop.run();
