// prismd — the long-lived half of Prism. Three small jobs:
//
//   weave      every 2 seconds: read per-strand download and upload counters,
//              update each strand's virtual token-bucket credit, keep the
//              dedicated @vip_lane pinned to the lowest-TTFB strand, and
//              re-lay @pattern so new flows harvest charged burst buckets.
//   schedule   run `prism reconcile` on a timer and when asked.
//   serve      publish the ubus object the dashboard and CLI read.

import * as uloop from "uloop";
import * as ubus from "ubus";
import * as core from "./lib/core.uc";
import * as config from "./lib/config.uc";
import * as series from "./lib/series.uc";
import * as weave from "./mod/weave.uc";
import * as devices from "./mod/devices.uc";
import * as tunnel from "./mod/tunnel.uc";
import * as identity from "./mod/identity.uc";
import * as api from "./mod/api.uc";

const PRISM = "/usr/sbin/prism";
const STATUS = core.RUN + "/status.json";
const DEBOUNCE_MS = 2000;
const HISTORY = 720;                    // samples kept (2s cadence -> 24 min window)
const SERIES_CADENCE = 1.9;
const PEAK_DECAY_PER_SEC = 0.999;       // ~0.998 per 2s
const SETTLE = 2;                       // slot changes needed to trigger an update
const DEVICE_SCAN = 3;                  // look for devices every ~6s (~2s/sample * 3)

let cfg = config.load();
let snapshot = core.load_json(STATUS, null);
let pattern = weave.current();
let vip_lane = weave.current_vip();
let history = series.create(HISTORY);
let load = {};                          // dev -> { down, up, bucket, flows }
let flow_counts = {};                   // strand id -> ESTABLISHED flow count
let lan = { list: [], rate: {}, samples: 0 };
let sampled = 0, series_at = 0, pattern_at = 0;
let running = false, again = false, first = true;
let reconcile_timer, sample_timer;
let kick_pending = false;

function monotonic() {
	let c = clock(true);
	return c[0] + c[1] / 1000000000;
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
	if (!length(strands) || n <= 0)
		return;
	let mptcp_ids = {};
	for (let e in snapshot?.mptcp?.endpoints ?? [])
		mptcp_ids[e.id] = true;
	let next_vip = weave.select_vip(strands, load, mptcp_ids);
	let next = weave.compose(cfg.weave, strands, load, n, next_vip);
	let vip_changed = (next_vip[0] ?? 0) != (vip_lane[0] ?? 0);
	let d = pattern_diff(pattern, next);
	if (!vip_changed && !d.edge) {
		if (d.moved <= SETTLE)
			return;
		if (d.moved < 10 && pattern_at && now - pattern_at < 5)
			return;
	}
	if (weave.program(next, vip_changed ? next_vip : null)) {
		pattern = next;
		vip_lane = next_vip;
		pattern_at = now;
	}
}

function sample_devices(dt) {
	for (let dir in [ "up", "down" ]) {
		for (let ip, bytes in weave.counters("dev_" + dir) ?? {}) {
			let r = (lan.rate[ip] ??= {}), prev = r[dir + "_bytes"];
			r[dir] = (prev != null && bytes >= prev && dt > 0) ? (bytes - prev) / dt : 0;
			r[dir + "_bytes"] = bytes;
		}
	}
	if (lan.samples % DEVICE_SCAN == 0)
		lan.list = devices.scan(cfg);
	if (lan.samples % 5 == 1 && snapshot?.tunnel?.running && !running)
		tunnel.sync_selected(cfg, snapshot?.lan_ip ?? "192.168.16.1", identity.load_store()?.profiles ?? []);
	lan.samples++;
}

function sync_lan_cfg() {
	cfg = config.load();
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

function sample() {
	sample_timer.set(max(1, cfg.weave.interval) * 1000);
	let counted = { down: weave.counters("strands"), up: weave.counters("strands_up") }, now = monotonic();
	if (!counted.down)
		return;
	let dt = sampled ? now - sampled : 0, alpha = cfg.weave.smoothing;
	let record_series = !series_at || (now - series_at >= SERIES_CADENCE);
	if (record_series) {
		sample_devices(series_at ? now - series_at : dt);
		flow_counts = weave.active_flows();
	}
	let id_by_dev = {};
	for (let s in snapshot?.strands ?? [])
		id_by_dev[s.dev] = s.id;
	let decay = dt > 0 ? max(0.90, 1.0 - (1.0 - PEAK_DECAY_PER_SEC) * dt) : PEAK_DECAY_PER_SEC;
	let total = { down: 0, up: 0 }, per = {}, per_up = {};
	for (let dev in keys(counted.down)) {
		let l = (load[dev] ??= {
			down: { bytes: null, now: 0, rate: 0, peak: 0 },
			up: { bytes: null, now: 0, rate: 0, peak: 0 },
			bucket: { tokens: weave.BURST_MAX, state: "charged", cooldown_until: 0 },
			flows: 0,
		});
		for (let dir in [ "down", "up" ]) {
			let d = l[dir], bytes = counted[dir]?.[dev] ?? 0;
			if (d.bytes != null && bytes >= d.bytes && dt > 0) {
				d.now = (bytes - d.bytes) / dt;
				d.rate = alpha * d.now + (1 - alpha) * d.rate;
			}
			d.bytes = bytes;
			d.peak = max(d.rate, d.peak * decay);
			total[dir] += d.now;
		}
		l.flows = flow_counts[id_by_dev[dev]] ?? 0;
		per[dev] = l.down.now;
		per_up[dev] = l.up.now;
	}
	for (let dev in keys(load))
		if (counted.down[dev] == null)
			delete load[dev];
	weave.update_buckets(load, dt, now);
	sampled = now;
	if (record_series) {
		series_at = now;
		series.add(history, time(), total.down, total.up, per, per_up);
	}
	relay(now);
}

let reconcile;

function kick(delay_ms) {
	if (kick_pending)
		return;
	kick_pending = true;
	uloop.timer(delay_ms, () => {
		kick_pending = false;
		reconcile();
	});
}

reconcile = function() {
	reconcile_timer.set(max(10, cfg.main.tick) * 1000);
	if (running) {
		again = true;
		return;
	}
	running = true;
	let args = first ? [ "reconcile", "--boot" ] : [ "reconcile" ];
	first = false;
	uloop.process(PRISM, args, {}, () => {
		running = false;
		cfg = config.load();
		snapshot = core.load_json(STATUS, snapshot);
		pattern = weave.current();
		vip_lane = weave.current_vip();
		relay(monotonic());
		if (again) {
			again = false;
			kick(DEBOUNCE_MS);
		}
	});
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
	devices: device_view,
	interval: () => cfg.weave.interval,
	series_interval: () => max(2, cfg.weave.interval),
	now: monotonic,
	kick: () => kick(DEBOUNCE_MS / 4),
	reload: sync_lan_cfg,
	set_device: (a) => {
		let mac = lc(a.mac ?? ""), name = a.name ?? "", policy = a.policy || "auto";
		let res = config.device_store(mac, name, policy);
		if (res.ok) {
			let p = identity.update_profile_policy(mac, name, policy, cfg);
			if (!p && (policy != "block" || length(trim(name))))
				identity.claim({ mac, action: "new", alias: name, policy }, cfg);
			core.event("DEVICE %s policy=%s name=%s", mac, policy, name);
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
	dhcp_event: (a) => {
		let res = identity.on_dhcp_event(a);
		if (res.kick) {
			lan.list = devices.scan(cfg);
			kick(150);
		}
		return res;
	},
}));
if (!published)
	core.err("cannot publish ubus object: %s", ubus.error());

uloop.run();
