// Uplink legs: discovery, health, portal login, and the slot schedule that
// spreads new connections across healthy legs.
//
// A leg is one L3 device on the upstream network with its own address. Its
// identity (1..250) is the fwmark and conntrack mark of every flow pinned to
// it; routing table 1000+id sends those flows out through that device.

import * as core from "../lib/core.uc";
import * as facts from "../lib/facts.uc";
import * as linkbroad from "../portal/linkbroad.uc";

const PORTALS = { linkbroad };
const BACKUP_BASE = 200;

function network(ip, prefix) {
	let a = iptoarr(ip), n = [];
	for (let i = 0; i < 4; i++) {
		let bits = max(0, min(8, prefix - i * 8));
		push(n, a[i] & (0xff << (8 - bits)) & 0xff);
	}
	return arrtoip(n) + "/" + prefix;
}

// Every configured leg that exists, addressed or not.
export function discover(cfg, f) {
	let legs = [];
	let add = (devs, role, base) => {
		for (let i, dev in devs) {
			let a = f.addr4[dev], n = f.netifd[dev];
			push(legs, {
				dev, role,
				id: base + i + 1,
				ip: a?.ip,
				gw: n?.gw,
				subnet: a ? network(a.ip, a.prefix) : null,
				iface: n?.iface,
			});
		}
	};
	let primary = facts.expand(cfg.uplink.device, f.links);
	add(primary, "primary", 0);
	add(filter(facts.expand(cfg.uplink.backup, f.links), (d) => !(d in primary)), "backup", BACKUP_BASE);
	return legs;
};

// --- health ----------------------------------------------------------------

function probe(devs, cfg) {
	let res = {};
	if (!length(devs))
		return res;
	let cmds = map(devs, (d) => sprintf(
		"curl -4 --interface %s -m %d -sS -o /dev/null -w '%s %%{http_code} %%{time_starttransfer}\\n' %s 2>/dev/null &",
		d, cfg.probe_timeout, d, core.shq(cfg.probe_url)));
	push(cmds, "wait");
	for (let line in split(core.sh(join("\n", cmds)).out, "\n")) {
		let m = match(line, /^(\S+) ([0-9]+) ([0-9.]+)/);
		if (m && !res[m[1]])
			res[m[1]] = { code: int(m[2]), ttfb: +m[3] };
	}
	return res;
}

function portal_login(devs, cfg) {
	let plugin = PORTALS[cfg.portal];
	let secret = plugin ? core.read(cfg.portal_secret) : null;
	if (!secret || !length(devs))
		return;
	if (core.is_dry()) {
		warn("would log in to portal '", cfg.portal, "' on: ", join(" ", devs), "\n");
		return;
	}
	for (let i = 0; i < length(devs); i += cfg.auth_batch) {
		let batch = slice(devs, i, i + cfg.auth_batch);
		let cmds = map(batch, (d) => "( " + plugin.login_cmd(d, secret) + "\n) >/dev/null 2>&1 &");
		push(cmds, "wait");
		core.sh(join("\n", cmds));
	}
	core.event("PORTAL login %s on %s", cfg.portal, join(" ", devs));
}

// Updates per-leg health in st and returns the healthy legs of the active role.
function check(legs, cfg, st, now) {
	let usable = filter(legs, (l) => l.ip && l.gw);
	let state = (l) => (st.legs[l.dev] ??= { code: 0, ttfb: 0, probed: 0, strikes: 0, logins: 0, parked: 0 });
	let good = (l) => state(l).code == cfg.probe_expect;

	let due = filter(usable, (l) => !good(l) || now - state(l).probed >= cfg.probe_interval);
	let run = (set) => {
		let res = probe(map(set, (l) => l.dev), cfg);
		for (let l in set) {
			let s = state(l), r = res[l.dev] ?? { code: 0, ttfb: 0 };
			s.code = r.code;
			s.ttfb = r.ttfb;
			s.probed = now;
		}
	};
	run(due);

	// Two batches per tick at most: a dead upstream must not hold the tick
	// (and its lock) for minutes while every leg times out at the portal.
	let failing = filter(due, (l) => !good(l));
	let login = [];
	for (let l in failing) {
		let s = state(l);
		if (length(login) >= cfg.auth_batch * 2 || (s.parked && now - s.parked < cfg.park_sec))
			continue;
		s.parked = 0;
		if (++s.logins >= cfg.park_fails)
			s.parked = now;
		push(login, l);
	}
	if (length(login) && PORTALS[cfg.portal]) {
		portal_login(map(login, (l) => l.dev), cfg);
		run(login);
	}

	// A leg survives fail_keep-1 bad rounds so one lost probe does not flap it.
	let healthy = [];
	for (let l in usable) {
		let s = state(l);
		if (good(l)) {
			s.strikes = 0;
			s.logins = 0;
			s.parked = 0;
		}
		else if (l in due) {
			s.strikes++;
		}
		if (s.strikes < cfg.fail_keep)
			push(healthy, l);
	}
	for (let dev in keys(st.legs))
		if (!length(filter(legs, (l) => l.dev == dev)))
			delete st.legs[dev];

	let primary = filter(healthy, (l) => l.role == "primary");
	return length(primary) ? primary : filter(healthy, (l) => l.role == "backup");
}

// --- scheduling ------------------------------------------------------------

// Download bytes per leg, from the per-element counters of nft set @legs.
function rx_bytes() {
	let r = core.sh("nft -j list set inet hotel legs");
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
}

function update_scores(healthy, cfg, st, now) {
	let rx = rx_bytes();
	let dt = now - (st.sched.scored ?? 0);
	if (!rx || dt <= 0)
		return;
	for (let l in healthy) {
		let s = st.legs[l.dev], cur = rx[l.dev] ?? 0;
		let delta = (s.rx == null || cur < s.rx) ? 0 : cur - s.rx;
		let rate = delta / dt;
		s.rate = (s.rate == null || cfg.ewma <= 0 || cfg.ewma >= 1)
			? rate : cfg.ewma * rate + (1 - cfg.ewma) * s.rate;
		s.rx = cur;
	}
	st.sched.scored = now;
}

const SCHEDULERS = {
	// One slot each; spare slots go round-robin to the idlest half, so new
	// connections lean toward legs that carried the least download lately.
	idle: function(healthy, nslots, st) {
		let rate = (l) => st.legs[l.dev].rate ?? 0;
		let order = sort(slice(healthy), (a, b) =>
			rate(a) < rate(b) ? -1 : (rate(a) > rate(b) ? 1 : a.id - b.id));
		let n = length(order), weight = map(order, () => 1);
		let idle_half = max(1, int((n + 1) / 2));
		for (let k = 0; k < nslots - n; k++)
			weight[k % idle_half]++;
		let slots = [];
		while (length(slots) < nslots) {
			let progress = false;
			for (let i = 0; i < n && length(slots) < nslots; i++) {
				if (weight[i] <= 0)
					continue;
				weight[i]--;
				push(slots, order[i].id);
				progress = true;
			}
			if (!progress)
				push(slots, order[0].id);
		}
		return slots;
	},

	even: function(healthy, nslots) {
		let slots = [];
		for (let i = 0; i < nslots; i++)
			push(slots, healthy[i % length(healthy)].id);
		return slots;
	},
};

// --- entry point -----------------------------------------------------------

// Returns the uplink plan for this tick:
//   legs     every configured leg that exists
//   routed   legs with an address and gateway (get a routing table)
//   healthy  legs that carry new connections
//   slots    identity per slot, empty when not balancing
export function observe(ctx) {
	let cfg = ctx.cfg.uplink, st = ctx.st, now = ctx.now;
	st.legs ??= {};
	st.sched ??= {};

	let legs = ctx.legs;
	let healthy = check(legs, cfg, st, now);
	let ids = join(" ", map(healthy, (l) => l.id));
	let slots = [];

	if (cfg.mode == "multi" && length(healthy)) {
		let due = now - (st.sched.scored ?? 0) >= cfg.reweigh;
		if (due)
			update_scores(healthy, cfg, st, now);
		if (due || ids != st.sched.ids || length(st.sched.slots ?? []) != cfg.slots) {
			let schedule = SCHEDULERS[cfg.scheduler] ?? SCHEDULERS.idle;
			st.sched.slots = schedule(healthy, cfg.slots, st);
		}
		slots = st.sched.slots;
	}
	else {
		st.sched.slots = [];
	}

	if (ids != st.sched.ids) {
		core.event("UPLINK mode=%s healthy=%d/%d ids=%s", cfg.mode, length(healthy), length(legs), ids);
		st.sched.ids = ids;
	}

	return {
		legs,
		routed: filter(legs, (l) => l.ip && l.gw),
		healthy,
		slots,
		role: healthy[0]?.role ?? "none",
	};
};
