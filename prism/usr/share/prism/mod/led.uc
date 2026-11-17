// PRISM Optical LED Engine — drives the two front WS2812B RGB LEDs (`rgb:status`,
// `rgb:network`) via sysfs multicolor & kernel triggers (`pattern`, `netdev`).
//
// Modes:
//   prism    status: kernel-breathed health core + quarantine/fault alert
//            network: live 1s logarithmic DSOTM optical throughput spectrum
//   aurora   slow continuous dual-LED rainbow phase drift (accelerated by load)
//   tunnel   status: active tunnel/relay color code; network: canary + netdev
//   netdev   status: steady health hue; network: 20Hz hardware rx/tx activity
//   stealth  ultra-dim night-stand dot (status muted, network off)
//   off      both LEDs dark

import * as fs from "fs";
import * as core from "../lib/core.uc";

const LED_BASE_FILE = core.RUN + "/led.json";

// DSOTM 7-stop spectrum: 700nm Red -> Orange -> Yellow -> Green -> Cyan -> Blue -> 380nm Violet
const DSOTM_STOPS = [
	[ 239,  68,  68 ],
	[ 249, 115,  22 ],
	[ 250, 204,  21 ],
	[  34, 197,  94 ],
	[   6, 182, 212 ],
	[  59, 130, 246 ],
	[ 139,  92, 246 ],
];

// Live traffic spectrum stops: Obsidian Indigo -> Cyan -> Emerald -> Gold -> Orange -> Coral-Magenta
const FLUX_STOPS = [
	[  26,  48, 145 ],
	[   6, 195, 225 ],
	[  30, 215, 115 ],
	[ 245, 195,  20 ],
	[ 250,  95,  20 ],
	[ 230,  45, 165 ],
];

const NAMED_COLORS = {
	green:   [  18, 220, 110 ],
	yellow:  [ 230, 170,  12 ],
	orange:  [ 245,  88,  12 ],
	red:     [ 245,  20,  20 ],
	violet:  [ 185,  28, 235 ],
	cyan:    [  12, 195, 235 ],
	blue:    [  45, 140, 250 ],
	indigo:  [  32,  52, 160 ],
	amber:   [ 235, 130,  18 ],
	dim:     [  14, 110,  48 ],
	off:     [   0,   0,   0 ],
};

let hw_cache = {};
let last_mode = null;
let smooth_net = null;
let smooth_stat = null;
let aurora_phase = 0.0;
let base_cache = { mtime: -1, data: null };
let override_state = null; // { until, status_rgb, network_rgb, status_b, network_b, tag }
let view_state = {
	mode: "prism",
	bright: 80,
	night_dim: 1,
	alert: "ok",
	quarantine: 0,
	demo: false,
	status_rgb: [ 18, 220, 110 ],
	network_rgb: [ 26, 48, 145 ],
	status_bright: 40,
	network_bright: 20,
	status_trig: "none",
	network_trig: "none",
};

function clamp(v, lo, hi) {
	return v < lo ? lo : (v > hi ? hi : v);
}

function rgb_str(c) {
	return sprintf("%d %d %d", clamp(int(c[0] + 0.5), 0, 255), clamp(int(c[1] + 0.5), 0, 255), clamp(int(c[2] + 0.5), 0, 255));
}

function rgb_hex(c) {
	return sprintf("#%02x%02x%02x", clamp(int(c[0] + 0.5), 0, 255), clamp(int(c[1] + 0.5), 0, 255), clamp(int(c[2] + 0.5), 0, 255));
}

function lerp_stops(stops, t, wrap) {
	let n = length(stops);
	if (wrap) {
		t = t - int(t);
		if (t < 0) t += 1.0;
		let scaled = t * n;
		let i = int(scaled) % n;
		let j = (i + 1) % n;
		let f = scaled - int(scaled);
		let a = stops[i], b = stops[j];
		return [
			int(a[0] + (b[0] - a[0]) * f + 0.5),
			int(a[1] + (b[1] - a[1]) * f + 0.5),
			int(a[2] + (b[2] - a[2]) * f + 0.5),
		];
	}
	let u = clamp(t, 0.0, 1.0) * (n - 1);
	let i = min(n - 2, int(u));
	let f = u - i;
	let a = stops[i], b = stops[i + 1];
	return [
		int(a[0] + (b[0] - a[0]) * f + 0.5),
		int(a[1] + (b[1] - a[1]) * f + 0.5),
		int(a[2] + (b[2] - a[2]) * f + 0.5),
	];
}

function blend_rgb(prev, target, alpha) {
	if (!prev)
		return [ target[0], target[1], target[2] ];
	return [
		int(prev[0] + (target[0] - prev[0]) * alpha + 0.5),
		int(prev[1] + (target[1] - prev[1]) * alpha + 0.5),
		int(prev[2] + (target[2] - prev[2]) * alpha + 0.5),
	];
}

// Perceptual 0..1 curve mapping bits/s into the optical flux spectrum.
function flux_level(bps) {
	if (bps <= 25000)
		return 0.0;
	if (bps <= 500000)
		return 0.08 + 0.16 * (bps - 25000) / 475000.0;
	if (bps <= 5000000)
		return 0.24 + 0.26 * (bps - 500000) / 4500000.0;
	if (bps <= 25000000)
		return 0.50 + 0.24 * (bps - 5000000) / 20000000.0;
	if (bps <= 75000000)
		return 0.74 + 0.18 * (bps - 25000000) / 50000000.0;
	return min(1.0, 0.92 + 0.08 * (bps - 75000000) / 50000000.0);
}

// Compute effective peak brightness (0..255) factoring in user scale and night dimming.
export function target_bright(cfg) {
	let led_cfg = cfg?.led ?? cfg ?? {};
	let pct = clamp(int(led_cfg.bright ?? 80), 5, 100);
	let tod = 1.0;
	if (led_cfg.night_dim ?? 1) {
		let h = localtime().hour;
		if (h >= 23 || h < 7)
			tod = 0.22;
		else if (h == 7 || h == 22)
			tod = 0.55;
	}
	return clamp(int(255 * (pct / 100.0) * tod + 0.5), 4, 255);
};

// Write a target spec to sysfs only when properties actually differ from cache.
function write_led(led, spec) {
	let sys = "/sys/class/leds/" + led;
	if (!length(led) || !fs.stat(sys) || core.is_dry())
		return;
	let prev = hw_cache[led] ?? {};
	let trig = spec.trig ?? "none";
	let bright = clamp(int(spec.bright ?? 0), 0, 255);
	if (bright <= 0) {
		trig = "none";
		bright = 0;
	}
	let mi = rgb_str(spec.rgb ?? NAMED_COLORS.off);

	if (prev.trig != trig) {
		fs.writefile(sys + "/trigger", trig);
		prev = { trig };
	}

	if (trig == "pattern") {
		if (prev.mi != mi)
			fs.writefile(sys + "/multi_intensity", mi);
		if (!prev.pat_repeat)
			fs.writefile(sys + "/repeat", "-1");
		let pat = spec.pattern ?? "20 1600 180 1600 20 1600";
		if (prev.pattern != pat)
			fs.writefile(sys + "/pattern", pat);
		prev.mi = mi;
		prev.pat_repeat = true;
		prev.pattern = pat;
	}
	else if (trig == "netdev") {
		let dev = spec.netdev || "br-lan";
		if (prev.netdev != dev)
			fs.writefile(sys + "/device_name", dev);
		if (!prev.nd_cfg) {
			fs.writefile(sys + "/link", "1");
			fs.writefile(sys + "/rx", "1");
			fs.writefile(sys + "/tx", "1");
			fs.writefile(sys + "/interval", "50");
			prev.nd_cfg = true;
		}
		if (prev.mi != mi)
			fs.writefile(sys + "/multi_intensity", mi);
		if (prev.bright != bright)
			fs.writefile(sys + "/brightness", "" + bright);
		prev.netdev = dev;
		prev.mi = mi;
		prev.bright = bright;
	}
	else {
		if (bright > 0 && prev.mi != mi) {
			fs.writefile(sys + "/multi_intensity", mi);
			prev.mi = mi;
		}
		if (prev.bright != bright) {
			fs.writefile(sys + "/brightness", "" + bright);
			prev.bright = bright;
		}
	}
	hw_cache[led] = prev;
}

function load_base() {
	let st = fs.stat(LED_BASE_FILE);
	if (!st)
		return base_cache.data;
	let mk = st.mtime + ":" + st.size;
	if (base_cache.mtime == mk && base_cache.data)
		return base_cache.data;
	let d = core.load_json(LED_BASE_FILE, null);
	if (d)
		base_cache = { mtime: mk, data: d };
	return d;
}

function health_color_name(base, cfg) {
	let n = int(base.healthy ?? 0);
	if (!base.aggregate)
		return n > 0 ? "green" : "red";
	if (n >= (cfg.green ?? 18))
		return "green";
	if (n >= (cfg.yellow ?? 8))
		return "yellow";
	if (n >= 1)
		return "orange";
	return "red";
}

function relay_rgb(relay_name) {
	let r = lc(relay_name ?? "");
	if (index(r, "tw") >= 0 || index(r, "台湾") >= 0 || index(r, "台灣") >= 0)
		return [ 16, 225, 130 ];
	if (index(r, "jp") >= 0)
		return [ 35, 165, 255 ];
	if (index(r, "us") >= 0)
		return [ 155, 80, 255 ];
	return [ 30, 200, 210 ];
}

// Compute status alert level & color for the left core LED.
function resolve_status_spec(base, led_cfg, max_b) {
	let q = int(base.quarantine ?? 0);
	if (base.ap_dead)
		return { alert: "ap_dead", rgb: NAMED_COLORS.red, pat: sprintf("0 220 %d 220 0 220", max_b), trig: "pattern", bright: max_b };
	if (q > 0)
		return { alert: "quarantine", rgb: NAMED_COLORS.violet, pat: sprintf("%d 600 %d 600 %d 600", max(4, int(max_b * 0.14)), max_b, max(4, int(max_b * 0.14))), trig: "pattern", bright: max_b };
	if (base.tun_down)
		return { alert: "tunnel_down", rgb: NAMED_COLORS.orange, pat: sprintf("%d 420 %d 420 %d 420", max(4, int(max_b * 0.15)), max_b, max(4, int(max_b * 0.15))), trig: "pattern", bright: max_b };
	if (base.fail_cnt > 0)
		return { alert: "doctor_fail", rgb: NAMED_COLORS.amber, pat: sprintf("%d 700 %d 700 %d 700", max(4, int(max_b * 0.18)), max_b, max(4, int(max_b * 0.18))), trig: "pattern", bright: max_b };

	let cname = health_color_name(base, led_cfg);
	let lo = max(4, int(max_b * 0.26));
	let hi = max(lo + 4, int(max_b * 0.85));
	return {
		alert: "ok",
		cname,
		rgb: NAMED_COLORS[cname] ?? NAMED_COLORS.green,
		pat: sprintf("%d 1800 %d 1800 %d 1800", lo, hi, lo),
		trig: "pattern",
		bright: hi,
	};
}

function update_view(mode, led_cfg, st_spec, net_spec, alert, q, is_demo) {
	view_state = {
		mode,
		bright: clamp(int(led_cfg.bright ?? 80), 5, 100),
		night_dim: int(led_cfg.night_dim ?? 1),
		alert,
		quarantine: q,
		demo: !!is_demo,
		status_rgb: st_spec.rgb ?? NAMED_COLORS.off,
		network_rgb: net_spec.rgb ?? NAMED_COLORS.off,
		status_hex: (st_spec.bright ?? 0) > 0 ? rgb_hex(st_spec.rgb) : "#000000",
		network_hex: (net_spec.bright ?? 0) > 0 ? rgb_hex(net_spec.rgb) : "#000000",
		status_bright: st_spec.bright ?? 0,
		network_bright: net_spec.bright ?? 0,
		status_trig: st_spec.trig ?? "none",
		network_trig: net_spec.trig ?? "none",
	};
}

// Render one frame of the 6s DSOTM rainbow chase demo.
export function demo_frame(cfg, step_idx) {
	let led_cfg = cfg?.led ?? {};
	let max_b = max(60, target_bright(cfg));
	let t1 = ((step_idx * 4) % 100) / 100.0;
	let t2 = ((step_idx * 4 + 28) % 100) / 100.0;
	let c1 = lerp_stops(DSOTM_STOPS, t1, true);
	let c2 = lerp_stops(DSOTM_STOPS, t2, true);
	let pulse = 0.65 + 0.35 * ((step_idx % 12 < 6) ? (step_idx % 6) / 5.0 : (5 - (step_idx % 6)) / 5.0);
	let b = clamp(int(max_b * pulse + 0.5), 24, 255);
	let s_spec = { trig: "none", rgb: c1, bright: b };
	let n_spec = { trig: "none", rgb: c2, bright: b };
	write_led(led_cfg.status, s_spec);
	write_led(led_cfg.network, n_spec);
	update_view(led_cfg.mode ?? "prism", led_cfg, s_spec, n_spec, "demo", 0, true);
};

export function set_override(r, g, b, target, ttl_sec) {
	let rgb = [ clamp(int(r), 0, 255), clamp(int(g), 0, 255), clamp(int(b), 0, 255) ];
	let ttl = max(1, min(300, int(ttl_sec ?? 10)));
	override_state = {
		until: time() + ttl,
		target: (target == "status" || target == "network") ? target : "both",
		rgb,
		tag: "custom",
	};
};

export function clear_override() {
	override_state = null;
	hw_cache = {};
};

// Called every ~1s from prismd sample() (or immediately after reconcile).
export function tick(cfg, opts) {
	let led_cfg = cfg?.led ?? {};
	let base = opts?.base ?? load_base() ?? {
		healthy: 0, total: 0, aggregate: false, ap_dead: false,
		fail_cnt: 0, quarantine: 0, tun_down: false, canary_ms: 0, relay: "TW-HOME",
	};
	if (opts?.quarantine != null)
		base.quarantine = int(opts.quarantine);

	let max_b = target_bright(cfg);
	let mode = led_cfg.mode ?? "prism";
	if (last_mode != null && last_mode != mode) {
		hw_cache = {};
		smooth_net = null;
		smooth_stat = null;
	}
	last_mode = mode;

	if (override_state) {
		if (time() < override_state.until) {
			let s_spec = {
				trig: "none",
				rgb: override_state.target != "network" ? override_state.rgb : view_state.status_rgb,
				bright: override_state.target != "network" ? max_b : view_state.status_bright,
			};
			let n_spec = {
				trig: "none",
				rgb: override_state.target != "status" ? override_state.rgb : view_state.network_rgb,
				bright: override_state.target != "status" ? max_b : view_state.network_bright,
			};
			write_led(led_cfg.status, s_spec);
			write_led(led_cfg.network, n_spec);
			update_view(mode, led_cfg, s_spec, n_spec, "override", base.quarantine, false);
			return;
		}
		override_state = null;
		hw_cache = {};
	}

	let st_info = resolve_status_spec(base, led_cfg, max_b);
	let total_bps = max(0, (+(opts?.rate_bytes ?? 0)) * 8.0);
	let lv = flux_level(total_bps);
	let s_spec = { trig: st_info.trig, rgb: st_info.rgb, bright: st_info.bright, pattern: st_info.pat };
	let n_spec = { trig: "none", rgb: NAMED_COLORS.off, bright: 0 };

	if (mode == "off") {
		s_spec = { trig: "none", rgb: NAMED_COLORS.off, bright: 0 };
		n_spec = { trig: "none", rgb: NAMED_COLORS.off, bright: 0 };
	}
	else if (mode == "stealth") {
		let sb = clamp(int(max_b * 0.14 + 0.5), 3, 24);
		if (st_info.alert != "ok")
			s_spec = { trig: "pattern", rgb: st_info.rgb, pattern: sprintf("2 800 %d 800 2 800", sb), bright: sb };
		else
			s_spec = { trig: "none", rgb: [ 45, 70, 145 ], bright: max(3, int(sb * 0.7)) };
		n_spec = { trig: "none", rgb: NAMED_COLORS.off, bright: 0 };
	}
	else if (mode == "netdev") {
		s_spec = { trig: "none", rgb: st_info.rgb, bright: max(8, int(max_b * 0.7)) };
		let ndev = cfg?.shaper?.device || "br-lan";
		n_spec = { trig: "netdev", netdev: ndev, rgb: NAMED_COLORS.cyan, bright: max_b };
	}
	else if (mode == "tunnel") {
		let r_rgb = base.tun_down ? NAMED_COLORS.red : relay_rgb(base.relay);
		if (st_info.alert != "ok")
			s_spec = { trig: st_info.trig, rgb: st_info.rgb, bright: st_info.bright, pattern: st_info.pat };
		else
			s_spec = { trig: "none", rgb: r_rgb, bright: max(10, int(max_b * 0.85)) };
		let ms = int(base.canary_ms ?? 0);
		let lat_rgb = base.tun_down ? NAMED_COLORS.red : (ms > 0 && ms < 150 ? NAMED_COLORS.green : (ms < 260 ? NAMED_COLORS.blue : NAMED_COLORS.amber));
		n_spec = { trig: "netdev", netdev: "br-lan", rgb: lat_rgb, bright: max(10, int(max_b * 0.9)) };
	}
	else if (mode == "aurora") {
		aurora_phase += 0.025 + lv * 0.055;
		if (aurora_phase >= 1.0) aurora_phase -= int(aurora_phase);
		let target_s = lerp_stops(DSOTM_STOPS, aurora_phase, true);
		let target_n = lerp_stops(DSOTM_STOPS, aurora_phase + 0.35, true);
		if (st_info.alert != "ok") {
			s_spec = { trig: st_info.trig, rgb: st_info.rgb, bright: st_info.bright, pattern: st_info.pat };
			smooth_stat = null;
		}
		else {
			smooth_stat = blend_rgb(smooth_stat, target_s, 0.5);
			s_spec = { trig: "none", rgb: smooth_stat, bright: max(8, int(max_b * 0.78)) };
		}
		smooth_net = blend_rgb(smooth_net, target_n, 0.5);
		n_spec = { trig: "none", rgb: smooth_net, bright: max(8, int(max_b * (0.45 + 0.50 * lv))) };
	}
	else {
		// Default "prism" mode: left LED kernel-breathes health/alerts; right LED tracks 1s live optical throughput.
		let target_n = lerp_stops(FLUX_STOPS, lv, false);
		smooth_net = blend_rgb(smooth_net, target_n, 0.5);
		let nb = max(6, int(max_b * (0.28 + 0.72 * lv) + 0.5));
		n_spec = { trig: "none", rgb: smooth_net, bright: nb };
	}

	write_led(led_cfg.status, s_spec);
	write_led(led_cfg.network, n_spec);
	update_view(mode, led_cfg, s_spec, n_spec, st_info.alert, base.quarantine, false);
};

// Reconcile entry point: computes authoritative system state and saves base snapshot.
export function apply(ctx, report) {
	let cfg = ctx.cfg, led_cfg = cfg.led, n = length(ctx.health?.healthy ?? []);
	let failed = map(filter(report?.checks ?? [], (c) => !c.ok && c.level == "fail"), (c) => c.id);
	let ap_dead = length(filter(failed, (id) => index(id, "ap:") == 0)) > 0;
	let relays = core.load_json(core.STATE_DIR + "/device_relays.json", {});
	let base = {
		healthy: n,
		total: length(ctx.strands ?? []),
		aggregate: !!ctx.site?.aggregate,
		ap_dead,
		fail_cnt: length(failed),
		quarantine: length(ctx.identity?.quarantine ?? []),
		tun_down: !!cfg.tunnel?.enabled && (!ctx.tunnel?.running || !!ctx.tunnel?.fail_open),
		canary_ms: int(ctx.st?.tunnel?.delay ?? 0),
		relay: relays?._tw_home ?? "TW-HOME",
	};
	if (!core.is_dry())
		core.write_atomic(LED_BASE_FILE, sprintf("%J\n", base), 0o600);
	if (!core.ok("ubus list | grep -qx prism"))
		tick(cfg, { base, rate_bytes: 0 });
	return health_color_name(base, led_cfg);
};

// Read live hardware RGB/trigger telemetry for API & CLI `prism led status`.
export function inspect(cfg) {
	let led_cfg = cfg?.led ?? {};
	let read_hw = (name) => {
		let sys = "/sys/class/leds/" + name;
		if (!length(name) || !fs.stat(sys))
			return null;
		let trig_raw = trim(fs.readfile(sys + "/trigger") ?? "");
		let m = match(trig_raw, /\[([^\]]+)\]/);
		let rgb_txt = trim(fs.readfile(sys + "/multi_intensity") ?? "0 0 0");
		let parts = map(split(rgb_txt, " "), (v) => int(v));
		return {
			name,
			trigger: m ? m[1] : trig_raw,
			rgb: parts,
			hex: rgb_hex(parts),
			brightness: int(trim(fs.readfile(sys + "/brightness") ?? "0")),
		};
	};
	return {
		mode: led_cfg.mode ?? "prism",
		bright: int(led_cfg.bright ?? 80),
		night_dim: int(led_cfg.night_dim ?? 1),
		alert: view_state.alert,
		quarantine: view_state.quarantine,
		demo: view_state.demo,
		status_rgb: view_state.status_rgb,
		network_rgb: view_state.network_rgb,
		status_hex: view_state.status_hex,
		network_hex: view_state.network_hex,
		status_bright: view_state.status_bright,
		network_bright: view_state.network_bright,
		status_trig: view_state.status_trig,
		network_trig: view_state.network_trig,
		hw: {
			status: read_hw(led_cfg.status),
			network: read_hw(led_cfg.network),
		},
	};
};

export function live_view() {
	return view_state;
};
