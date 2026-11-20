// The weave: which strand a new flow is laid onto.
//
// Three maps in the kernel:
//
//   @vip_lane "where do gaming and realtime control flows go?"
//             Both slots pin to one healthy strand, selected by probe quality
//             and load, with bit 0x100 in the conntrack mark.
//   @pattern  "where should the next regular flow go?"
//             slot -> strand, weighted by token-bucket burst credit (harvest)
//             or spare capacity (headroom), updated on material share changes.
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

// Per-strand CIR and burst allowance. Kernel counters measure delivered bytes.
export const CIR_BYTES_S = 1250000;
export const BURST_MAX = 1000000;
const IDLE_THRESH = 120000;

// --- measurement & token bucket state machine ------------------------------

function nft_rows(query) {
	let r = core.sh("exec nft -j " + query);
	if (r.code != 0)
		return null;
	try {
		return json(r.out).nftables;
	}
	catch (e) {
		core.err("nft %s: %s", query, e.message);
		return null;
	}
}

export function counters(set) {
	let rows = nft_rows("list set " + NFT + " " + set);
	if (!rows)
		return null;
	let out = {};
	for (let item in rows)
		for (let e in item.set?.elem ?? [])
			out[e.elem.val] = e.elem.counter.bytes;
	return out;
};

export function named_counters() {
	let rows = nft_rows("list counters table " + NFT);
	if (!rows)
		return null;
	let out = {};
	for (let item in rows)
		if (item.counter)
			out[item.counter.name] = item.counter;
	return out;
};

export function classify_counters() {
	let out = [];
	for (let item in nft_rows("list chain " + NFT + " classify") ?? [])
		for (let expr in item.rule?.expr ?? [])
			if (expr.counter && item.rule.comment)
				push(out, { tag: item.rule.comment, packets: expr.counter.packets, bytes: expr.counter.bytes });
	return out;
};

// Integrate each direction independently. TCP headroom below CIR remains
// available after a burst. The busier direction limits a new bidirectional flow.
export function update_buckets(load, dt, cir) {
	for (let l in values(load)) {
		let b = l.bucket;
		for (let dir in [ "down", "up" ])
			b[dir] = min(BURST_MAX, max(0, (b[dir] ?? BURST_MAX) + (cir - l[dir].now) * dt));
		let prev = b.tokens;
		b.tokens = int(min(b.down, b.up));
		b.state = b.tokens >= BURST_MAX * 0.75 ? "charged" :
			(b.tokens > prev ? "cooling" : (b.tokens <= BURST_MAX * 0.15 ? "depleted" : "draining"));
	}
};

// --- @vip_lane: dedicated low-latency gaming & realtime strand --------------

export function current_vip() {
	return core.load_json(VIP_FILE, []);
};

// Baseline HTTP probe failure rate across active strands. If every strand reads
// >= 90% loss (e.g. a shared probe destination outage), disable loss
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
// clean, latency stays within max(best + 120ms, 2.2 * best_ttfb), and sustained
// stray load stays well below the policer knee (2 Mbps). Prefers non-wan vwan*
// strands when >= 4 strands are healthy, and gently avoids active MPTCP endpoints
// when electing a fresh VIP so @vip_lane and MPTCP stay disjoint.
export function select_vip(healthy, load, mptcp_ids, previous) {
	if (!length(healthy))
		return [];
	let candidates = filter(healthy, (s) => s.http > 0);
	if (!length(candidates))
		candidates = healthy;
	let lb = loss_baseline(candidates);
	let best = candidates[0], best_score = 1e9, min_ttfb = 10.0;
	let prefer_vwan = length(candidates) >= 4;
	let free = filter(candidates, (s) => !mptcp_ids?.[s.id] && (!prefer_vwan || s.id != 1));
	if (length(free))
		candidates = free;
	for (let s in candidates) {
		let ttfb = (s.ttfb && s.ttfb >= 0.008) ? s.ttfb : 0.25;
		let rate = max(load?.[s.dev]?.down?.now ?? 0, load?.[s.dev]?.down?.rate ?? 0, (load?.[s.dev]?.up?.now ?? 0) * 1.2);
		if (rate < IDLE_THRESH && ttfb < min_ttfb)
			min_ttfb = ttfb;
		let loss_pen = rel_loss(lb, s) * 2500.0; // +25 ms score per 1% relative loss
		let wan_pen = (prefer_vwan && s.id == 1) ? 15.0 : 0.0;
		let score = ttfb * 1000.0 + loss_pen + (rate / 4096.0) + wan_pen;
		if (score < best_score) {
			best_score = score;
			best = s;
		}
	}
	if (min_ttfb >= 10.0)
		min_ttfb = 0.035;

	let prev_raw = previous?.[0] ?? 0;
	let prev_id = prev_raw & 0xff;
	if (prev_id > 0) {
		let cur = filter(candidates, (s) => s.id == prev_id)[0];
		if (cur) {
			let ttfb = (cur.ttfb && cur.ttfb >= 0.008) ? cur.ttfb : 0.25;
			let cur_now = max(load?.[cur.dev]?.down?.now ?? 0, (load?.[cur.dev]?.up?.now ?? 0) * 1.2);
			let cur_ewma = max(load?.[cur.dev]?.down?.rate ?? 0, (load?.[cur.dev]?.up?.rate ?? 0) * 1.2);
			let limit = max(min_ttfb + 0.120, min_ttfb * 2.2);
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
		let exact = shares[i] * (1.0 * rem_slots) / total;
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
	harvest: function(strands, load, nslots, cfg) {
		let cir = cfg.strand_kbit > 0 ? cfg.strand_kbit * 125 : CIR_BYTES_S;
		return apportion(map(strands, (s) => {
			let l = load[s.dev], used = max(l?.down?.rate ?? 0, l?.up?.rate ?? 0);
			let spare = max(0, 1.0 - used / (1.0 * cir));
			let credit = (l?.bucket?.tokens ?? BURST_MAX) / (1.0 * BURST_MAX);
			return max(FLOOR, spare * (1.0 + credit)) * loss_quality(s.loss ?? 0);
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
			let used = max((l.down?.rate ?? 0) / (1.0 * top.down), (l.up?.rate ?? 0) / (1.0 * top.up));
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

export function compose(cfg, healthy, load, n, vip) {
	if (!length(healthy))
		return [];
	let pool = harvest_pool(healthy, vip);
	let policy = POLICIES[cfg.policy] ?? POLICIES.harvest;
	return interleave(pool, policy(pool, load ?? {}, n, cfg), n);
};

// --- @anchor: rendezvous hashing -------------------------------------------

export function anchor(ids) {
	let out = [];
	for (let slot = 0; slot < ANCHOR_SLOTS && length(ids); slot++) {
		let best = null, top = "";
		for (let id in ids) {
			let score = md5(slot + ":" + id);
			if (score > top) {
				top = score;
				best = id;
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
	assert(core.write_atomic(file, body), "cannot stage weave maps");
	if (!core.ok("nft -f " + file))
		return false;
	remember(pattern, vip);
	return true;
};

export function plan(ctx) {
	let healthy = ctx.health.healthy;
	if (length(healthy) < 2) {
		let vip = length(healthy) == 1 ? [ healthy[0].id | MARK_VIP, healthy[0].id | MARK_VIP ] : [];
		return { slots: 0, pattern: [], vip, repair: length(current()) > 0 || (current_vip()[0] ?? 0) != (vip[0] ?? 0), anchor_ids: [] };
	}
	let have = current(), have_vip = current_vip();
	let vip = select_vip(healthy, ctx.load ?? {}, ctx.mptcp_ids, have_vip);
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
		anchor_ids: ctx.cfg.weave.affinity == "flow" ? [] : map(healthy, (s) => s.id),
	};
};
