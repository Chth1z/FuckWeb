// braidd — the long-lived half of Braid. Three small jobs:
//
//   weave      every few seconds: read per-strand download counters, turn
//              them into load, and re-lay the pattern so new flows favour
//              strands with headroom
//   schedule   run `braid reconcile` on a timer and when asked (the ubus
//              method `reconcile`: that is what `braid kick` calls, and
//              procd calls that on interface and config events); one at a
//              time, bursts collapsed
//   serve      publish the ubus object the dashboard and CLI read
//
// It never probes, logs in, or touches routes: everything slow or fallible
// lives in the reconcile process. If braidd dies the kernel keeps forwarding
// on the last pattern and procd brings it back.

import * as uloop from "uloop";
import * as ubus from "ubus";
import * as core from "./lib/core.uc";
import * as config from "./lib/config.uc";
import * as series from "./lib/series.uc";
import * as weave from "./mod/weave.uc";
import * as devices from "./mod/devices.uc";
import * as api from "./mod/api.uc";

const BRAID = "/usr/sbin/braid";
const STATUS = core.RUN + "/status.json";
const DEBOUNCE_MS = 2000;
const HISTORY = 720;                    // samples kept: one hour at 5 s
const PEAK_DECAY = 0.998;               // per sample: a peak fades over ~30 min
const SETTLE = 2;                       // slots that may differ before a re-lay
const DEVICE_SCAN = 3;                  // look for devices every this many samples

let cfg = config.load();
let snapshot = core.load_json(STATUS, null);
let pattern = weave.current();
let history = series.create(HISTORY);
let load = {};                          // dev -> { rx, now, rate, peak }
let lan = { list: [], rate: {}, samples: 0 };   // devices and their per-address traffic
let sampled = 0;
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

// How many slots would change hands. Small moves are noise, not load.
function drift(a, b) {
	if (length(a) != length(b))
		return length(b);
	let count = {}, moved = 0;
	for (let id in a)
		count[id] = (count[id] ?? 0) + 1;
	for (let id in b)
		count[id] = (count[id] ?? 0) - 1;
	for (let id, n in count)
		moved += n > 0 ? n : 0;
	return moved;
}

function relay() {
	let strands = healthy(), n = snapshot?.weave?.slots ?? 0;
	if (!length(strands) || n <= 0)
		return;
	let next = weave.compose(cfg.weave, strands, load, n);
	if (drift(pattern, next) <= SETTLE)
		return;
	if (weave.program(next))
		pattern = next;
}

// Per-device rates from the two accounting sets, and now and then a fresh
// look at who is on the LAN.
function sample_devices(dt) {
	for (let dir in [ "up", "down" ]) {
		for (let ip, bytes in weave.counters("dev_" + dir) ?? {}) {
			let r = (lan.rate[ip] ??= {}), prev = r[dir + "_bytes"];
			r[dir] = (prev != null && bytes >= prev && dt > 0) ? (bytes - prev) / dt : 0;
			r[dir + "_bytes"] = bytes;
		}
	}
	if (lan.samples++ % DEVICE_SCAN == 0)
		lan.list = devices.scan(cfg);
}

function device_view() {
	return map(lan.list, (x) => {
		let r = lan.rate[x.ip] ?? {};
		return { ...x, up: int(r.up ?? 0), down: int(r.down ?? 0), up_bytes: r.up_bytes ?? 0, down_bytes: r.down_bytes ?? 0 };
	});
}

function sample() {
	sample_timer.set(max(1, cfg.weave.interval) * 1000);
	let rx = weave.counters("strands"), now = monotonic();
	if (!rx)
		return;
	sample_devices(sampled ? now - sampled : 0);
	let dt = now - sampled, alpha = cfg.weave.smoothing, total = 0, per = {};
	for (let dev, bytes in rx) {
		let l = (load[dev] ??= { rx: null, now: 0, rate: 0, peak: 0 });
		if (l.rx != null && bytes >= l.rx && sampled && dt > 0) {
			l.now = (bytes - l.rx) / dt;
			l.rate = alpha * l.now + (1 - alpha) * l.rate;
		}
		l.rx = bytes;
		l.peak = max(l.rate, l.peak * PEAK_DECAY);
		per[dev] = l.now;
		total += l.now;
	}
	for (let dev in keys(load))
		if (rx[dev] == null)
			delete load[dev];
	sampled = now;
	series.add(history, time(), total, per);
	relay();
}

// kick and reconcile call each other; strict mode wants the name declared first.
let reconcile;

// Run a pass soon. Asks that arrive while one is already pending fold into it.
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
	uloop.process(BRAID, args, {}, () => {
		running = false;
		cfg = config.load();
		snapshot = core.load_json(STATUS, snapshot);
		pattern = weave.current();
		relay();
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

// A burst of asks (every strand renewing its lease at once) is one pass.
uloop.signal("USR1", () => kick(DEBOUNCE_MS));
uloop.signal("TERM", () => uloop.end());

let bus = ubus.connect();
let published = bus.publish("braid", api.methods({
	cfg: () => cfg,
	snapshot: () => snapshot,
	load: () => load,
	pattern: () => pattern,
	history: () => history,
	devices: device_view,
	interval: () => cfg.weave.interval,
	kick: () => kick(DEBOUNCE_MS / 4),
	reload: () => (cfg = config.load()),
}));
if (!published)
	core.err("cannot publish ubus object: %s", ubus.error());

uloop.run();
