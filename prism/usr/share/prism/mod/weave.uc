// The weave: which strand a new flow is laid onto.
//
// Three maps in the kernel:
//
//   @vip_lane "where do gaming and realtime control flows go?"
//             2 slots pinned to the single lowest-TTFB, zero-congestion strand
//             (with bit 0x100 set in ct mark), physically isolated from bulk
//             downloads so the hotel policer never tail-drops game packets.
//   @pattern  "where should the next regular flow go?"
//             slot -> strand, weighted by token-bucket burst credit (harvest)
//             or spare capacity (headroom), re-laid every 2 seconds.
//   @anchor   "where does this pair always go?"
//             slot -> strand, rendezvous hash of (client, server).

import { md5 } from "digest";
import * as core from "../lib/core.uc";

const NFT = "inet prism";
const PATTERN = core.RUN + "/pattern.json";
const VIP_FILE = core.RUN + "/vip.json";
const SLOTS_PER_STRAND = 6;
const MAX_SLOTS = 252;
const FLOOR = 0.05;                     // a saturated strand keeps 5% of a share
const MIN_CEILING = 125000;             // bytes/s: below 1 Mbit/s, load is noise
export const ANCHOR_SLOTS = 256;
export const MARK_VIP = 0x100;

// Per-MAC Token Bucket parameters measured on LinkBroad gateway:
//   CIR = 10.0 Mbps (1,250,000 B/s), Burst Bc = 8.0 Mbit (1,000,000 B).
//   Under active TCP congestion probing (>= 150 KB/s), micro-bursts drain Bc
//   rapidly; Bc only refills back to 1.0 MB when the strand is quiet.
export const CIR_BYTES_S = 1250000;
export const EFF_CIR_BYTES_S = 1050000; // ~8.4 Mbps steady-state TCP goodput under drop-tail policer
export const BURST_MAX = 1000000;
const IDLE_THRESH = 120000;             // < 960 Kbps: completely quiet, rapid full refill
const SAFE_SUSTAIN = 350000;            // < 2.8 Mbps: below micro-burst exhaustion knee
const CHARGED_THRESH = 750000;          // >= 750 KB: ready for full-speed 20 Mbps burst
const EMPTY_THRESH = 150000;            // <= 150 KB: burst exhausted, entering policer clamp
export const COOLDOWN_SEC = 2.0;

// --- measurement & token bucket state machine ------------------------------

export function counters(set) {
	let r = core.sh("nft -j list set " + NFT + " " + set);
	if (r.code != 0)
		return null;
	let out = {};
	try {
		for (let item in json(r.out).nftables)
			for (let e in item.set?.elem ?? [])
				if (e.elem?.counter)
					out[e.elem.val] = e.elem.counter.bytes;
	}
	catch (e) {
		return null;
	}
	return out;
};

// Count recently-active ESTABLISHED kernel flows per strand ID from nf_conntrack,
// ignoring long-lived idle TCP keepalives (>90s silent) so zombie sockets never
// penalize an idle 100% charged strand.
export function active_flows() {
	let raw = core.read("/proc/net/nf_conntrack");
	if (!raw)
		return {};
	let tcp_ttl_min = max(0, int(core.read("/proc/sys/net/netfilter/nf_conntrack_tcp_timeout_established") ?? "7200") - 90);
	let counts = {};
	for (let line in split(raw, "\n")) {
		let pe = index(line, " ESTABLISHED ");
		if (pe < 0)
			continue;
		if (index(line, " tcp ") >= 0 && tcp_ttl_min > 0) {
			let tail = split(trim(substr(line, max(0, pe - 8), 8)), / +/);
			let ttl = length(tail) ? int(pop(tail)) : tcp_ttl_min;
			if (ttl < tcp_ttl_min)
				continue;
		}
		let p = index(line, " mark=");
		if (p < 0)
			continue;
		let id = int(substr(line, p + 6, 8)) & 0xff;
		if (id > 0 && id < 250)
			counts[id] = (counts[id] ?? 0) + 1;
	}
	return counts;
};

// Advance each strand's virtual token bucket over elapsed `dt` seconds.
// Reflects true hardware policer + TCP micro-burst behavior:
//   - Quiet (< 960 Kbps): bucket refills rapidly toward 1.0 MB.
//   - Light steady (< 2.8 Mbps): bucket net-refills slowly up to a partial cap
//     instead of falsely collapsing into `depleted`.
//   - Heavy burst (>= 2.8 Mbps): micro-bursts drain Bc toward `depleted` before
//     CUBIC hits the drop-tail policer wall.
export function update_buckets(load, dt, now) {
	if (dt <= 0)
		return;
	for (let dev, l in load) {
		let b = (l.bucket ??= { tokens: BURST_MAX, state: "charged", cooldown_until: 0 });
		let down_now = l.down?.now ?? 0;
		let up_now = l.up?.now ?? 0;
		let down_ewma = l.down?.rate ?? 0;
		let up_ewma = l.up?.rate ?? 0;
		let rate_now = max(down_now, up_now * 1.2);
		let rate_eff = max(rate_now, down_ewma * 0.75, up_ewma * 0.9);

		if (rate_now < IDLE_THRESH && rate_eff < IDLE_THRESH) {
			let factor = now < (b.cooldown_until ?? 0) ? 0.45 : 0.85;
			let refilled = (CIR_BYTES_S - rate_eff) * dt * factor;
			b.tokens = min(BURST_MAX, int(b.tokens + refilled));
		}
		else if (rate_eff < SAFE_SUSTAIN) {
			let cap = int(BURST_MAX * (1.0 - 0.30 * rate_eff / (1.0 * EFF_CIR_BYTES_S)));
			let delta = int((SAFE_SUSTAIN - rate_eff) * dt * 0.65);
			b.tokens = max(0, min(cap, b.tokens + delta));
		}
		else {
			let drain = int(max(80000, rate_eff - 200000) * dt);
			let cap = int(BURST_MAX * max(0.0, 1.0 - (rate_eff / (1.0 * EFF_CIR_BYTES_S))));
			b.tokens = max(0, min(cap, b.tokens - drain));
			b.cooldown_until = now + COOLDOWN_SEC;
		}

		if (rate_eff >= EFF_CIR_BYTES_S * 0.72 || b.tokens <= EMPTY_THRESH) {
			b.state = rate_eff >= IDLE_THRESH ? "depleted" : "cooling";
		}
		else if (rate_eff < IDLE_THRESH && (now < (b.cooldown_until ?? 0) || b.tokens < CHARGED_THRESH)) {
			b.state = "cooling";
		}
		else if (b.tokens >= CHARGED_THRESH && rate_eff < SAFE_SUSTAIN) {
			b.state = "charged";
		}
		else {
			b.state = "draining";
		}
	}
};

// --- @vip_lane: dedicated low-latency gaming & realtime strand --------------

export function current_vip() {
	return core.load_json(VIP_FILE, []);
};

// Baseline first-hop ICMP loss across active strands. If every strand reads
// >= 90% loss (e.g. an upstream gateway that drops ICMP), disable loss
// penalties so we never falsely penalize healthy strands.
function loss_baseline(strands) {
	let floor = 1.0;
	for (let s in strands) {
		let l = s.loss ?? 0.0;
		if (l < floor)
			floor = l;
	}
	return { active: floor < 0.90, floor };
}

function rel_loss(lb, s) {
	return lb.active ? max(0.0, (s.loss ?? 0.0) - lb.floor * 0.5) : 0.0;
}

function loss_quality(rel) {
	return 1.0 / (1.0 + 18.0 * rel + 120.0 * rel * rel);
}

// Pick the lowest-loss, lowest-TTFB, uncongested strand for @vip_lane with
// tight hysteresis: stays sticky during an active session while loss remains
// clean, latency stays within max(best + 40ms, 1.45 * best_ttfb), and sustained
// stray load stays well below the policer knee (2 Mbps). Prefers non-wan vwan*
// strands when >= 4 strands are healthy, and gently avoids active MPTCP endpoints
// when electing a fresh VIP so @vip_lane and MPTCP stay disjoint.
export function select_vip(healthy, load, mptcp_ids) {
	if (!length(healthy))
		return [];
	let candidates = filter(healthy, (s) => !s.http || s.http == 204);
	if (!length(candidates))
		candidates = healthy;
	let lb = loss_baseline(candidates);
	let best = candidates[0], best_score = 1e9, min_ttfb = 10.0;
	let prefer_vwan = length(candidates) >= 4;
	for (let s in candidates) {
		let ttfb = (s.ttfb && s.ttfb >= 0.008) ? s.ttfb : 0.25;
		let rate = max(load?.[s.dev]?.down?.now ?? 0, load?.[s.dev]?.down?.rate ?? 0, (load?.[s.dev]?.up?.now ?? 0) * 1.2);
		if (rate < IDLE_THRESH && ttfb < min_ttfb)
			min_ttfb = ttfb;
		let loss_pen = rel_loss(lb, s) * 2500.0; // +25 ms score per 1% relative loss
		let wan_pen = (prefer_vwan && s.id == 1) ? 15.0 : 0.0;
		let mp_pen = (mptcp_ids?.[s.id] || mptcp_ids?.["" + s.id]) ? 6.0 : 0.0;
		let score = ttfb * 1000.0 + loss_pen + (rate / 4096.0) + wan_pen + mp_pen;
		if (score < best_score) {
			best_score = score;
			best = s;
		}
	}
	if (min_ttfb >= 10.0)
		min_ttfb = 0.035;

	let prev_raw = current_vip()[0] ?? 0;
	let prev_id = prev_raw & 0xff;
	if (prev_id > 0) {
		let cur = filter(healthy, (s) => s.id == prev_id)[0];
		if (cur && (!cur.http || cur.http == 204)) {
			let ttfb = (cur.ttfb && cur.ttfb >= 0.008) ? cur.ttfb : 0.25;
			let cur_now = max(load?.[cur.dev]?.down?.now ?? 0, (load?.[cur.dev]?.up?.now ?? 0) * 1.2);
			let cur_ewma = max(load?.[cur.dev]?.down?.rate ?? 0, (load?.[cur.dev]?.up?.rate ?? 0) * 1.2);
			let limit = max(min_ttfb + 0.040, min_ttfb * 1.45);
			let loss_ok = rel_loss(lb, cur) <= max(0.05, lb.floor * 0.5 + 0.04);
			let load_ok = !(cur_ewma >= 250000 && cur_now >= 200000) && cur_now < 650000;
			let role_ok = !prefer_vwan || cur.id != 1 || best.id == 1;
			if (loss_ok && ttfb <= limit && load_ok && role_ok)
				return [ cur.id | MARK_VIP, cur.id | MARK_VIP ];
		}
	}
	let mark = best.id | MARK_VIP;
	return [ mark, mark ];
};

export function harvest_pool(healthy, vip) {
	let vip_id = (vip?.[0] ?? 0) & 0xff;
	if (length(healthy) >= 4 && vip_id > 0)
		return filter(healthy, (s) => s.id != vip_id);
	return healthy;
};

// --- @pattern: strands + load -> weights -> interleaved slots ---------------

// Largest-remainder apportionment. Strands with share <= 0 receive 0 slots
// when at least one strand has share > 0, completely shielding policed/depleted
// strands from new TCP flows while they cool down.
function apportion(shares, nslots) {
	let n = length(shares), total = 0, active = 0;
	if (n <= 0)
		return [];
	for (let s in shares) {
		if (s > 0) {
			total += s;
			active++;
		}
	}
	if (active == 0) {
		active = n;
		shares = map(shares, () => 1);
		total = n;
	}
	let weight = [], rest = [], used = 0, rem_slots = max(0, nslots - active);
	for (let i = 0; i < n; i++) {
		if (shares[i] <= 0) {
			weight[i] = 0;
			continue;
		}
		let exact = total > 0 ? shares[i] / total * rem_slots : rem_slots / active;
		weight[i] = 1 + int(exact);
		used += weight[i];
		push(rest, { i, frac: exact - int(exact) });
	}
	rest = sort(rest, (a, b) => a.frac > b.frac ? -1 : (a.frac < b.frac ? 1 : a.i - b.i));
	let rlen = length(rest);
	for (let k = 0; used < nslots && rlen > 0; used++)
		weight[rest[k++ % rlen].i]++;
	return weight;
}

const POLICIES = {
	// Burst-Harvest 2.0: prioritize strands with a full 1.0 MB token bucket
	// (18~70 Mbps first-second burst window), and evict depleted strands (0 slots)
	// into cooldown before the hotel gateway's drop-tail policer collapses TCP cwnd.
	harvest: function(strands, load, nslots, cfg) {
		let lb = loss_baseline(strands);
		let min_ttfb = 10.0, clean_active = 0;
		for (let s in strands) {
			if (s.ttfb && s.ttfb > 0 && s.ttfb < min_ttfb)
				min_ttfb = s.ttfb;
			let l = load[s.dev] ?? {}, b = l.bucket ?? { tokens: BURST_MAX, state: "charged" };
			let rate = max(l.down?.now ?? 0, l.down?.rate ?? 0, (l.up?.now ?? 0) * 1.2, (l.up?.rate ?? 0) * 1.2);
			let rl = rel_loss(lb, s);
			if (b.state != "depleted" && rate < EFF_CIR_BYTES_S * 0.65 && rl < 0.12)
				clean_active++;
		}
		if (min_ttfb >= 10.0)
			min_ttfb = 0.15;

		return apportion(map(strands, (s) => {
			let l = load[s.dev] ?? {};
			let b = l.bucket ?? { tokens: BURST_MAX, state: "charged" };
			let ttfb = (s.ttfb && s.ttfb > 0) ? s.ttfb : 0.035;
			let d = min(8.0, max(0.0, ttfb - min_ttfb) / 0.10);
			let q = 1.0 / (1.0 + 0.55 * d);
			let rl = rel_loss(lb, s);
			let lq = loss_quality(rl);
			let rate = max(l.down?.now ?? 0, l.down?.rate ?? 0, (l.up?.now ?? 0) * 1.2, (l.up?.rate ?? 0) * 1.2);
			let ratio = b.tokens / (1.0 * BURST_MAX);

			// Shield heavily losing (>=12% relative loss) or depleted strands when
			// healthier clean alternatives exist, avoiding CUBIC SYN/CWND stalls.
			if (b.state == "depleted" || rate >= EFF_CIR_BYTES_S * 0.65 || rl >= 0.12)
				return clean_active > 0 ? 0 : max(FLOOR, (1.0 - rate / (1.5 * EFF_CIR_BYTES_S)) * lq);
			let af = l.flows ?? 0;
			let flow_bias = 1.0 / (1.0 + 0.08 * af);
			let idle_bias = 1.0 / (1.0 + rate / 160000.0);
			if (b.state == "cooling")
				return max(FLOOR, 1.8 * ratio * q * lq * idle_bias * flow_bias);
			if (b.state == "charged")
				return max(FLOOR, 10.0 * ratio * ratio * q * lq * idle_bias * flow_bias);
			let rem = max(0.10, 1.0 - rate / (1.0 * EFF_CIR_BYTES_S));
			return max(FLOOR, 3.5 * rem * q * lq * idle_bias * flow_bias);
		}), nslots);
	},

	headroom: function(strands, load, nslots, cfg) {
		let lb = loss_baseline(strands);
		let top = { down: MIN_CEILING, up: MIN_CEILING };
		for (let dir in [ "down", "up" ]) {
			if (cfg.strand_kbit > 0) {
				top[dir] = cfg.strand_kbit * 125;
				continue;
			}
			for (let s in strands)
				top[dir] = max(top[dir], load[s.dev]?.[dir]?.peak ?? 0);
		}
		return apportion(map(strands, (s) => {
			let l = load[s.dev] ?? {};
			let lq = loss_quality(rel_loss(lb, s));
			let used = max((l.down?.rate ?? 0) / top.down, (l.up?.rate ?? 0) / top.up);
			return max(1 - used, FLOOR) * lq;
		}), nslots);
	},

	even: function(strands, load, nslots) {
		return apportion(map(strands, () => 1), nslots);
	},
};

// Smooth weighted round-robin: spread each strand's slots as far apart as its
// weight allows, so consecutive flows land on different strands.
function interleave(strands, weight, nslots) {
	let n = length(strands), credit = map(strands, () => 0), pattern = [];
	if (n <= 0)
		return pattern;
	for (let k = 0; k < nslots; k++) {
		let best = 0;
		for (let i = 0; i < n; i++) {
			credit[i] += weight[i];
			if (credit[i] > credit[best])
				best = i;
		}
		credit[best] -= nslots;
		push(pattern, strands[best].id);
	}
	return pattern;
}

export function nslots(cfg, healthy) {
	let n = cfg.slots > 0 ? cfg.slots : length(healthy) * SLOTS_PER_STRAND;
	return max(length(healthy), min(n, MAX_SLOTS));
};

export function compose(cfg, healthy, load, n, vip, mptcp_ids) {
	if (!length(healthy))
		return [];
	let pool = harvest_pool(healthy, vip ?? select_vip(healthy, load, mptcp_ids));
	let policy = POLICIES[cfg.policy] ?? POLICIES.harvest;
	return interleave(pool, policy(pool, load ?? {}, n, cfg), n);
};

// --- @anchor: rendezvous hashing -------------------------------------------

export function anchor(healthy) {
	let out = [];
	for (let slot = 0; slot < ANCHOR_SLOTS && length(healthy); slot++) {
		let best = null, top = "";
		for (let s in healthy) {
			let score = md5(slot + ":" + s.id);
			if (score > top) {
				top = score;
				best = s.id;
			}
		}
		push(out, best);
	}
	return out;
};

// --- the kernel maps -------------------------------------------------------

export function current() {
	return core.load_json(PATTERN, []);
};

export function script(name, slots) {
	let elems = [];
	for (let i, id in slots)
		push(elems, i + " : " + id);
	let s = sprintf("flush map %s %s\n", NFT, name);
	if (length(elems))
		s += sprintf("add element %s %s { %s }\n", NFT, name, join(", ", elems));
	return s;
};

export function remember(pattern, vip) {
	core.save_json(PATTERN, pattern);
	if (vip != null)
		core.save_json(VIP_FILE, vip);
};

// One atomic transaction; flows in flight keep the strand they already have.
export function program(pattern, vip) {
	let file = core.RUN + "/pattern.nft";
	let body = script("pattern", pattern);
	if (vip && length(vip))
		body += script("vip_lane", vip);
	core.write_atomic(file, body);
	if (!core.ok("nft -f " + file))
		return false;
	remember(pattern, vip);
	return true;
};

export function plan(ctx) {
	let healthy = ctx.health.healthy;
	if (length(healthy) < 2) {
		let vip = length(healthy) == 1 ? [ healthy[0].id | MARK_VIP, healthy[0].id | MARK_VIP ] : [];
		return { slots: 0, pattern: [], vip, repair: length(current()) > 0, anchor: [] };
	}
	let have = current(), have_vip = current_vip();
	let vip = select_vip(healthy, ctx.load ?? {}, ctx.mptcp_ids);
	let pool = harvest_pool(healthy, vip);
	let n = nslots(ctx.cfg.weave, healthy);
	let pool_ids = {};
	for (let s in pool)
		pool_ids[s.id] = true;
	let valid = !ctx.force && length(have) == n && length(uniq(have)) > 0 &&
		length(have_vip) == length(vip) && have_vip[0] == vip[0];
	for (let id in have)
		if (!pool_ids[id])
			valid = false;
	return {
		slots: n,
		pattern: valid ? have : compose(ctx.cfg.weave, healthy, ctx.load ?? {}, n, vip),
		vip,
		repair: !valid,
		anchor: anchor(healthy),
	};
};
