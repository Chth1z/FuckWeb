// The weave: which strand a new flow is laid onto.
//
// Two maps in the kernel, two questions:
//
//   @pattern  "where should the next flow go?"   slot -> strand, weighted by
//             spare capacity, re-laid every few seconds. Read round-robin.
//   @anchor   "where does this pair always go?"  slot -> strand, even and
//             stable: it changes only when a strand comes or goes, and then
//             only the slots of that strand move. Read by a hash of
//             (client, server).
//
// affinity picks between them per flow (see kernel.uc):
//   flow  always @pattern: every connection spreads
//   dest  always @anchor: a client and a server always share a strand
//   auto  @anchor, so sites that pin a session to the first address they saw
//         keep working, until a pair opens connections in a burst (a download
//         manager, a speed test): the burst spills onto @pattern and adds up
//
// Two callers share this module. reconcile guarantees both maps are valid
// for the healthy set; braidd only re-lays @pattern from measured load. A
// dead daemon costs optimality, never correctness.

import { md5 } from "digest";
import * as core from "../lib/core.uc";

const NFT = "inet braid";
const PATTERN = core.RUN + "/pattern.json";
const SLOTS_PER_STRAND = 6;
const MAX_SLOTS = 252;
const FLOOR = 0.05;                     // a saturated strand keeps 5% of a share
const MIN_CEILING = 125000;             // bytes/s: below 1 Mbit/s, load is noise
export const ANCHOR_SLOTS = 256;

// --- measurement -----------------------------------------------------------

// Bytes per element of one of the counting sets (@strands, @dev_up,
// @dev_down). Returns { key: bytes } or null when the table is not there.
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

// --- @pattern: strands + load -> weights -> interleaved slots ---------------

// Largest-remainder apportionment with at least one slot per strand.
function apportion(shares, nslots) {
	let n = length(shares), total = 0;
	for (let s in shares)
		total += s;
	let weight = [], rest = [], used = 0;
	for (let i = 0; i < n; i++) {
		let exact = total > 0 ? shares[i] / total * (nslots - n) : (nslots - n) / n;
		weight[i] = 1 + int(exact);
		used += weight[i];
		push(rest, { i, frac: exact - int(exact) });
	}
	rest = sort(rest, (a, b) => a.frac > b.frac ? -1 : (a.frac < b.frac ? 1 : a.i - b.i));
	for (let k = 0; used < nslots; used++)
		weight[rest[k++ % n].i]++;
	return weight;
}

const POLICIES = {
	// Share new flows by spare capacity. Every strand is throttled to about
	// the same ceiling upstream, so headroom = ceiling - current rate. An idle
	// braid weaves evenly; a strand running flat out stops attracting flows
	// within a sample or two instead of after minutes.
	headroom: function(strands, load, nslots, cfg) {
		let ceiling = cfg.strand_kbit * 125;
		if (ceiling <= 0) {
			ceiling = MIN_CEILING;
			for (let s in strands)
				ceiling = max(ceiling, load[s.dev]?.peak ?? 0);
		}
		return apportion(map(strands, (s) => max(ceiling - (load[s.dev]?.rate ?? 0), ceiling * FLOOR)), nslots);
	},

	even: function(strands, load, nslots) {
		return apportion(map(strands, () => 1), nslots);
	},
};

// Smooth weighted round-robin: spread each strand's slots as far apart as its
// weight allows, so consecutive flows land on different strands.
function interleave(strands, weight, nslots) {
	let n = length(strands), credit = map(strands, () => 0), pattern = [];
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

// load: { dev: { rate, peak } } in bytes per second, or {} when unknown.
export function compose(cfg, healthy, load, n) {
	if (!length(healthy))
		return [];
	let policy = POLICIES[cfg.policy] ?? POLICIES.headroom;
	return interleave(healthy, policy(healthy, load ?? {}, n, cfg), n);
};

// --- @anchor: rendezvous hashing -------------------------------------------

// Each slot goes to the strand with the highest hash(slot, strand). Losing a
// strand moves only the slots it held; gaining one takes an even share from
// everyone. No pair changes strands unless it has to.
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

export function remember(pattern) {
	core.save_json(PATTERN, pattern);
};

// One atomic transaction; flows in flight keep the strand they already have.
export function program(pattern) {
	let file = core.RUN + "/pattern.nft";
	core.write_atomic(file, script("pattern", pattern));
	if (!core.ok("nft -f " + file))
		return false;
	remember(pattern);
	return true;
};

// For reconcile. One healthy strand needs no weave at all.
//   { slots, pattern, repair, anchor }
// repair: the daemon's pattern is no longer valid for the healthy set and
// the one returned here must be written.
export function plan(ctx) {
	let healthy = ctx.health.healthy;
	if (length(healthy) < 2)
		return { slots: 0, pattern: [], repair: length(current()) > 0, anchor: [] };
	let n = nslots(ctx.cfg.weave, healthy), have = current();
	let ids = {};
	for (let s in healthy)
		ids[s.id] = true;
	let valid = length(have) == n && length(uniq(have)) == length(healthy);
	for (let id in have)
		if (!ids[id])
			valid = false;
	return {
		slots: n,
		pattern: valid ? have : compose(ctx.cfg.weave, healthy, {}, n),
		repair: !valid,
		anchor: anchor(healthy),
	};
};
