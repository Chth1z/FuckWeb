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
import * as led from "./mod/led.uc";
import * as api from "./mod/api.uc";

const PRISM = "/usr/sbin/prism";
const STATUS = core.RUN + "/status.json";
const QOS_BANDS = [ "1:10", "1:20", "1:30" ];
const DEBOUNCE_MS = 2000;
const HISTORY = 720;                    // samples kept (2s cadence -> 24 min window)
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
	if (weave.program(next, vip_changed ? next_vip : null)) {
		pattern = next;
		vip_lane = next_vip;
		pattern_at = now;
	}
	lock.close();
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
	if (controller_busy[resource])
		return;
	let file = fs.mkstemp();
	assert(file, fs.error());
	let path = fs.realpath("/proc/self") + "/fd/" + file.fileno();
	let url = sprintf("http://%s:%d/%s", snapshot.lan_ip, cfg.tunnel.controller_port, resource);
	controller_busy[resource] = true;
	let child = uloop.process("/usr/bin/curl", [ "-4", "--noproxy", "*", "-fsS", "-m", "2",
		"-H", "Authorization: Bearer " + core.read(core.ETC + "/controller.secret"), "-o", path, url ], {}, (code) => {
		delete controller_busy[resource];
		let payload = null;
		if (code == 0) {
			try { payload = json(file); }
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
			return;
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

function sample() {
	sample_timer.set(max(1, cfg.weave.interval) * 1000);
	let counted = { down: weave.counters("strands"), up: weave.counters("strands_up") }, now = monotonic();
	if (!slow_at || now - slow_at >= TELEMETRY_INTERVAL) {
		slow_at = now;
		sample_counters_and_qos(now);
		sample_devices(now);
		poll_mihomo_stats();
	}
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
			}
			else {
				d.now = d.rate = 0;
			}
			d.bytes = bytes;
			d.peak = max(d.rate, d.peak * decay);
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
	let args = first ? [ "reconcile", "--boot" ] : [ "reconcile" ];
	let child = uloop.process(PRISM, args, {}, (code) => {
		running = false;
		cfg = config.load();
		reconcile_timer.set(max(10, cfg.main.tick) * 1000);
		if (code == 0) {
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
			tunnel_ready_for_sync = false;
			core.err("reconcile exited %d", code);
		}
		if (again) {
			again = false;
			kick(DEBOUNCE_MS);
		}
	});
	assert(child, "cannot start reconciler: " + uloop.error());
};

core.init_dirs();
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
