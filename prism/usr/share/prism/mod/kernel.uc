// The kernel side: one nft table, policy rules and per-strand routing tables.
// This module only turns a plan into kernel state. It decides nothing.
//
// nft is applied as independent units, each with a digest in the state file.
// A pass sends only the units that changed, all in one atomic transaction.
// The skeleton ("base") is replaced only when its text changes; that is the
// one case that reloads the large sets and resets the strand counters.

import * as fs from "fs";
import * as core from "../lib/core.uc";
import * as facts from "../lib/facts.uc";
import { path } from "../lib/config.uc";
import * as weave from "./weave.uc";
import * as identity from "./identity.uc";
import * as guard from "./guard.uc";

export const MARK_DIVERTED = 0x4000;    // packet was handed to the tunnel
export const MARK_TUNNEL_OUT = 0x8000;  // the tunnel's own sockets (routing-mark)
const MARK_STRAND = 0xff;               // strand identity

const TABLE_TPROXY = 100;
const PREF_TPROXY = 50;
const TABLE_BASE = 1000;                // per-strand table = base + id
const PREF_MARK = 1000;                 // fwmark id -> table
const PREF_FROM = 2000;                 // from strand address -> table
const DEFAULT_PROTO = "99";             // tags the default route we own
const DEFAULT_METRIC = 5;

const NFT = "inet prism";

// --- nft units -------------------------------------------------------------

function unit(name, text) {
	return { name, digest: core.digest(text), text: () => text };
}

function chain_unit(name, rules) {
	let body = join("", map(rules, (r) => "\t\t" + r + "\n"));
	return unit(name, sprintf("flush chain %s %s\ntable %s {\n\tchain %s {\n%s\t}\n}\n", NFT, name, NFT, name, body));
}

function set_unit(kind, name, elems) {
	let text = sprintf("flush %s %s %s\n", kind, NFT, name);
	if (length(elems))
		text += sprintf("add element %s %s { %s }\n", NFT, name, join(", ", elems));
	return unit(name, text);
}

// Large list: the digest comes from stat so the file is read only on change.
function file_set_unit(name, file) {
	let st = fs.stat(file);
	return {
		name,
		digest: st ? sprintf("%d.%d", st.size, st.mtime) : "missing",
		text: () => set_unit("set", name, core.lines(file)).text(),
	};
}

function hex(n) {
	return sprintf("0x%x", n);
}

function build(ctx) {
	let cfg = ctx.cfg, c = cfg.classify, tun = ctx.tunnel;
	let doh_seen = {}, cn_doh_ips = [];
	for (let u in (cfg.dns?.cn_upstream ?? [])) {
		let m = match(u, /([0-9]+\.[0-9]+\.[0-9]+\.[0-9]+)/);
		if (m && !doh_seen[m[1]]) {
			doh_seen[m[1]] = true;
			push(cn_doh_ips, m[1]);
		}
	}

	let base = render(core.SHARE + "/tpl/prism.nft.ut", {
		lan: cfg.main.lan_dev,
		strands: map(ctx.strands, (s) => s.dev),
		ipv6: cfg.main.ipv6,
		mss: cfg.main.mss,
		listen_addr: cfg.tunnel.listen_addr,
		tproxy_port: cfg.tunnel.tproxy_port,
		mark_diverted: hex(MARK_DIVERTED),
		mark_tunnel_out: hex(MARK_TUNNEL_OUT),
		cn_doh_ips,
	});

	// Each rule carries a counter and a tag; the dashboard reads both to show
	// where traffic actually goes (api.uc: rules).
	let rule = (test, verdict, tag) => trim(sprintf('%s counter %s comment "%s"', test, verdict, tag));

	// Order is the policy. Block & Mode A MAC+IP anti-spoof gate sit at the very top,
	// then per-device choices, then forced-tunnel ranges before domestic sets.
	let idp = ctx.identity;
	let classify = [ rule("ether saddr @dev_block", "drop", "device-block") ];
	push(classify, rule("ether saddr . ip saddr != @verified_pairs", "drop", "unverified-drop"));
	if (tun.on)
		push(classify, rule("ip daddr . meta l4proto . th dport @relay_ports", "goto direct_ok", "relay"));
	if (c.quic == "reject")
		push(classify, rule("udp dport 443", "reject with icmpx type admin-prohibited", "quic"));
	if (tun.on) {
		push(classify, rule("ether saddr @dev_direct", "goto direct_ok", "device-direct"));
		push(classify, rule("ether saddr @dev_tunnel", "goto divert", "device-tunnel"));
		push(classify, rule("ip daddr @relay4", "goto divert", "relay-other-port"));
		push(classify, rule("ip daddr @tunnel4", "goto divert", "tunnel-range"));
		push(classify, rule("ip daddr @tunnel4_dns", "goto divert", "tunnel-domain"));
		push(classify, rule("ip daddr @domestic4", "goto direct_ok", "domestic"));
		push(classify, rule("ip daddr @domestic4_dns", "goto direct_ok", "domestic-domain"));
		if (length(c.tunnel_udp_port))
			push(classify, rule(sprintf("udp dport { %s }", join(", ", c.tunnel_udp_port)), "goto divert", "tunnel-port"));
		push(classify, rule("", "goto divert", "rest-tunnel"));
	}

	// Per-device TProxy isolation: each enrolled profile goes strictly to its bound listener port.
	let divert = [];
	let sorted_prof = sort(slice(idp.profiles ?? []), (a, b) => (a.port ?? 0) - (b.port ?? 0));
	for (let p in sorted_prof) {
		if (p.policy == "block" || !p.port)
			continue;
		if (!core.is_dry() && tun.ready_ports && !tun.ready_ports["" + p.port])
			continue;
		let macs = identity.all_profile_macs(p);
		if (!length(macs))
			continue;
		push(divert, sprintf(
			'ether saddr { %s } meta l4proto { tcp, udp } tproxy ip to %s:%d meta mark set %s ct mark set %s counter name "tun_up" accept comment "dev:%s"',
			join(", ", macs), cfg.tunnel.listen_addr, p.port, hex(MARK_DIVERTED), hex(MARK_DIVERTED), p.uid));
	}
	push(divert, 'counter drop comment "unmapped-divert-drop"');

	// See weave.uc for what the maps mean.
	// Low byte of conntrack mark = strand ID (1..21); bit 0x100 = VIP realtime lane.
	let w = ctx.weave, lay = [], lay_out = [];
	if (w.slots > 0) {
		// Demote bulky >50 MB flows out of 1:10 VIP QoS without altering the strand byte (preserves NAT).
		let evict = "ct mark and 0x100 != 0 ct bytes >= 50000000 ct mark set ct mark and 0xfffffeff";
		let known = "ct mark and 0xff != 0 meta mark set ct mark and 0xff return";
		let apply = "meta mark set ct mark and 0xff";
		let spread = sprintf("ct mark set numgen inc mod %d map @pattern", w.slots);
		let pin = sprintf("ct mark set jhash ip saddr . ip daddr mod %d map @anchor", weave.ANCHOR_SLOTS);
		let spill = max(1, cfg.weave.spill);
		push(lay, evict, known);
		if (length(w.vip) > 0) {
			let vip_set = sprintf("ct mark set numgen inc mod %d map @vip_lane", length(w.vip));
			push(lay,
				"ct state new ether saddr @dev_game " + vip_set,
				"ct state new meta l4proto udp th dport != { 80, 443 } meta length < 800 " + vip_set,
				"ct state new ip dscp { ef, cs4, cs5, cs6, cs7 } " + vip_set,
				"ct state new meta l4proto tcp th dport 22 " + vip_set
			);
		}
		if (cfg.weave.affinity == "flow") {
			push(lay, "ct state new ct mark and 0xff == 0 " + spread);
		}
		else if (cfg.weave.affinity == "dest") {
			push(lay, "ct state new ct mark and 0xff == 0 " + pin);
		}
		else {
			push(lay, sprintf("ct state new ct mark and 0xff == 0 add @bursty { ip saddr . ip daddr limit rate over %d/minute burst %d packets } %s", spill * 2, spill, spread));
			push(lay, "ct state new ct mark and 0xff == 0 " + pin);
		}
		push(lay, apply);
		// Let kernel MPTCP MP_JOIN subflows keep mark 0 -> PREF_FROM routes out each endpoint strand;
		// spread initial MP_CAPABLE, direct, and DoH router sockets across @pattern.
		lay_out = [
			"ct state new tcp option mptcp subtype 1 meta mark set 0 return",
			known,
			"ct state new " + spread,
			apply,
		];
	}

	let dev = idp.sets;
	return [
		unit("base", base),
		file_set_unit("domestic4", path(c.domestic4)),
		set_unit("set", "tunnel4", core.lines(path(c.tunnel4))),
		set_unit("set", "relay_ports", ctx.relay_ports),
		set_unit("set", "relay4", uniq([ ...tun.relay_ips, ...cfg.tunnel.guard_ssh4 ])),
		set_unit("set", "dev_direct", dev.direct),
		set_unit("set", "dev_tunnel", dev.tunnel),
		set_unit("set", "dev_block", dev.block),
		set_unit("set", "dev_game", dev.game),
		set_unit("set", "verified_pairs", idp.pairs),
		{
			name: "anchor",
			digest: join(",", w.anchor_ids),
			text: () => weave.script("anchor", weave.anchor(w.anchor_ids)),
		},
		chain_unit("classify", classify),
		chain_unit("divert", divert),
		chain_unit("weave", lay),
		chain_unit("weave_out", lay_out),
	];
}

// SmartDNS only adds an address when it resolves the name, so carry the live
// entries across a skeleton rebuild.
function carry_dynamic_set(name) {
	let r = core.sh("nft -j list set " + NFT + " " + name);
	assert(r.code == 0, "cannot carry live DNS set " + name + ": " + r.out);
	let elems = [];
	for (let item in json(r.out).nftables)
		for (let e in item.set?.elem ?? [])
			if (e.elem?.expires != null)
				push(elems, sprintf("%s timeout %ds", e.elem.val, max(1, int(e.elem.expires))));
	return length(elems) ? sprintf("add element %s %s { %s }\n", NFT, name, join(", ", elems)) : "";
}

function carry_dynamic() {
	return join("", map([ "tunnel4_dns", "domestic4_dns" ], carry_dynamic_set));
}

function apply_nft(ctx) {
	let units = build(ctx);
	let seen = ctx.st.nft ?? {};
	let alive = core.ok("nft list chain " + NFT + " prerouting");
	let full = ctx.force || !alive || seen.base != units[0].digest;

	let script = "", changed = [], digests = {};
	if (full) {
		script += "table " + NFT + "\ndelete table " + NFT + "\n" + units[0].text();
		if (alive)
			script += carry_dynamic();
	}
	for (let u in units) {
		digests[u.name] = u.digest;
		if (u.name == "base" || !(full || seen[u.name] != u.digest))
			continue;
		script += u.text();
		push(changed, u.name);
	}
	// The pattern and vip_lane maps belong to the weave. They ride along only
	// when emptied by a rebuild or no longer valid for the healthy set.
	let lay_pattern = full || ctx.weave.repair;
	if (lay_pattern) {
		script += weave.script("pattern", ctx.weave.pattern);
		script += weave.script("vip_lane", ctx.weave.vip);
	}
	let guard_text = guard.plan(ctx);
	script += guard_text;
	if (!length(script))
		return true;

	let file = core.outpath("ruleset.nft");
	assert(core.write_atomic(file, script), "cannot stage nft transaction");
	let r = core.sh((core.is_dry() ? "nft -c -f " : "nft -f ") + file);
	if (r.code != 0) {
		core.err("nft rejected %s: %s", file, trim(r.out));
		return false;
	}
	if (core.is_dry()) {
		warn(sprintf("nft: %s valid (%s) -> %s\n", full ? "full rebuild" : "update", join(" ", changed), file));
		return true;
	}
	if (length(guard_text)) {
		assert(core.write_atomic(core.RUN + "/guard.nft", guard_text), "cannot record applied guard");
		core.event("GUARD updated (fail_open=0)");
	}
	ctx.st.nft = digests;
	if (lay_pattern)
		weave.remember(ctx.weave.pattern, ctx.weave.vip);
	if (full)
		core.event("NFT rebuilt");
	else if (length(changed))
		core.event("NFT updated %s", join(" ", changed));
	return true;
}

// --- policy routing --------------------------------------------------------

function managed_pref(p) {
	return p == PREF_TPROXY || (p > PREF_MARK && p <= PREF_MARK + 255) || (p > PREF_FROM && p <= PREF_FROM + 255);
}

function rule_spec(r) {
	return sprintf("pref %d%s%s lookup %s", r.pref,
		r.mark ? " fwmark " + r.mark + "/" + r.mask : "",
		r.src ? " from " + r.src : "", r.table);
}

function routed(ctx) {
	return filter(ctx.strands, (l) => l.ip && l.gw);
}

function plan_rules(ctx, cmds) {
	let want = {};
	let add = (r) => (want[rule_spec(r)] = true);
	if (ctx.cfg.tunnel.enabled)
		add({ pref: PREF_TPROXY, mark: hex(MARK_DIVERTED), mask: hex(MARK_DIVERTED), table: TABLE_TPROXY });
	for (let l in routed(ctx)) {
		add({ pref: PREF_MARK + l.id, mark: hex(l.id), mask: hex(MARK_STRAND), table: TABLE_BASE + l.id });
		add({ pref: PREF_FROM + l.id, src: l.ip, table: TABLE_BASE + l.id });
	}

	let have = {};
	for (let r in facts.ip("-4 rule show")) {
		if (!managed_pref(r.priority))
			continue;
		have[rule_spec({
			pref: r.priority,
			mark: r.fwmark,
			mask: r.fwmask ?? "0xffffffff",
			src: r.src == "all" ? null : r.src,
			table: r.table,
		})] = true;
	}
	// Add before delete so a replaced rule never leaves a gap.
	for (let spec in keys(want))
		if (!have[spec])
			push(cmds, "ip rule add " + spec);
	for (let spec in keys(have))
		if (!want[spec])
			push(cmds, "ip rule del " + spec);
}

function plan_tables(ctx, cmds) {
	let want = {};
	for (let l in routed(ctx)) {
		let t = TABLE_BASE + l.id;
		want[t] = {
			keys: [ `default|${l.gw}|${l.dev}|${l.ip}`, `${l.subnet}||${l.dev}|${l.ip}` ],
			cmds: [
				`ip route replace ${l.subnet} dev ${l.dev} src ${l.ip} scope link table ${t}`,
				`ip route replace default via ${l.gw} dev ${l.dev} src ${l.ip} table ${t}`,
			],
		};
	}
	let have = {};
	for (let r in facts.ip("-4 route show table all")) {
		let t = int(r.table);
		if (t > TABLE_BASE && t <= TABLE_BASE + 255)
			push(have[t] ??= [], join("|", [ r.dst, r.gateway ?? "", r.dev, r.prefsrc ?? "" ]));
	}
	for (let t in keys(have))
		if (!want[t])
			push(cmds, "ip route flush table " + t);
	for (let t, w in want) {
		if (join(",", sort(have[t] ?? [])) == join(",", sort(slice(w.keys))))
			continue;
		if (have[t])
			push(cmds, "ip route flush table " + t);
		push(cmds, ...w.cmds);
	}
}

function plan_tproxy(ctx, cmds) {
	if (!ctx.cfg.tunnel.enabled)
		return;
	let addr = ctx.cfg.tunnel.listen_addr;
	if (!(addr in (ctx.facts.addr4.lo?.all ?? [])))
		push(cmds, sprintf("ip addr add %s/32 dev lo", addr));
	if (!length(facts.ip("-4 route show table " + TABLE_TPROXY)))
		push(cmds, "ip route replace local default dev lo table " + TABLE_TPROXY);
}

// Router-originated traffic follows netifd's default route. Override it only
// while that device is not a healthy strand.
function plan_default(ctx, cmds) {
	let first = ctx.health.healthy[0];
	let ours = null, stock = null;
	for (let r in facts.ip("-4 route show default")) {
		if ("" + r.protocol == DEFAULT_PROTO)
			ours = r;
		else if (!stock || (r.metric ?? 0) < (stock.metric ?? 0))
			stock = r;
	}
	let healthy = (dev) => length(filter(ctx.health.healthy, (l) => l.dev == dev)) > 0;
	if (first && !(stock && healthy(stock.dev))) {
		if (!ours || ours.dev != first.dev || ours.gateway != first.gw)
			push(cmds, sprintf("ip route replace default via %s dev %s src %s metric %d proto %s",
				first.gw, first.dev, first.ip, DEFAULT_METRIC, DEFAULT_PROTO));
	}
	else if (ours) {
		push(cmds, sprintf("ip route del default metric %d proto %s", DEFAULT_METRIC, DEFAULT_PROTO));
	}
}

// Pick up to 6 clean, non-VIP primary vwan* strands as MPTCP in-kernel
// path-manager endpoints with sticky hysteresis so active MP_JOIN subflows
// never churn on minor 45s RTT jitter and never touch @vip_lane.
export function mptcp_candidates(ctx, current_eps) {
	if (!ctx.site?.aggregate)
		return [];
	let vip_id = (ctx.weave?.vip?.[0] ?? 0) & 0xff;
	let healthy = filter(ctx.health?.healthy ?? [], (l) => l.role == "primary" && !l.parked && l.ip && l.gw);
	if (length(healthy) >= 4 && vip_id > 0)
		healthy = filter(healthy, (l) => l.id != vip_id);
	if (length(healthy) >= 7)
		healthy = filter(healthy, (l) => l.id != 1);
	if (length(healthy) < 2)
		return [];

	let lb_floor = 1.0;
	for (let l in healthy)
		if ((l.loss ?? 0.0) < lb_floor)
			lb_floor = l.loss ?? 0.0;
	let rel_loss = (l) => (lb_floor < 0.90) ? max(0.0, (l.loss ?? 0.0) - lb_floor * 0.5) : 0.0;
	let score = (l) => rel_loss(l) * 100.0 + ((l.ttfb && l.ttfb >= 0.008) ? l.ttfb : 0.25);
	let sorted = sort(slice(healthy), (a, b) => {
		let sa = score(a), sb = score(b);
		return sa < sb ? -1 : (sa > sb ? 1 : a.id - b.id);
	});
	// Separate entry (<12% rel loss) and eviction (<30% rel loss) thresholds
	// so a single transient HTTP probe timeout (loss=0.25) or normal upstream
	// CDN wave jitter never churns live MP_JOIN subflows.
	let clean = filter(sorted, (l) => rel_loss(l) < 0.12);
	let pool = length(clean) >= 2 ? clean : sorted;
	let keepable = filter(sorted, (l) => rel_loss(l) < 0.30);
	let keep_pool = length(keepable) >= 2 ? keepable : sorted;
	let min_ttfb = 10.0;
	for (let l in pool) {
		let t = (l.ttfb && l.ttfb >= 0.008) ? l.ttfb : 0.25;
		if (t < min_ttfb)
			min_ttfb = t;
	}
	let ttfb_ceil = max(min_ttfb + 0.250, min_ttfb * 3.0);

	let by_id = {};
	for (let l in keep_pool)
		by_id["" + l.id] = l;
	let selected = [], picked = {};
	for (let e in (current_eps ?? facts.ip("mptcp endpoint show"))) {
		if (e.id == null || !e.subflow)
			continue;
		let cand = by_id["" + e.id];
		if (!cand || cand.ip != e.address || cand.dev != e.dev)
			continue;
		let t = (cand.ttfb && cand.ttfb >= 0.008) ? cand.ttfb : 0.25;
		if (t <= ttfb_ceil && !picked["" + cand.id] && length(selected) < 6) {
			push(selected, cand);
			picked["" + cand.id] = true;
		}
	}
	for (let l in pool) {
		if (length(selected) >= 6)
			break;
		if (!picked["" + l.id]) {
			push(selected, l);
			picked["" + l.id] = true;
		}
	}
	return selected;
};

function plan_mptcp(ctx, cmds) {
	if (!fs.stat("/proc/sys/net/mptcp/enabled"))
		return;
	let cur_eps = ctx.mptcp_eps;
	let eps = mptcp_candidates(ctx, cur_eps);
	let want_subflows = length(eps) >= 2 ? min(5, length(eps) - 1) : 0;

	let lr = core.sh("ip mptcp limits show");
	let cur_sub = int(match(lr.out, /subflows\s+([0-9]+)/)?.[1] ?? "-1");
	let cur_acc = int(match(lr.out, /add_addr_accepted\s+([0-9]+)/)?.[1] ?? "-1");
	if (cur_sub != want_subflows || cur_acc != 0)
		push(cmds, sprintf("ip mptcp limits set subflows %d add_addr_accepted 0", want_subflows));

	let want = {};
	for (let l in eps)
		want[l.id] = { ip: l.ip, dev: l.dev };

	let have = {};
	for (let e in cur_eps) {
		if (e.id == null)
			continue;
		have["" + e.id] = e;
		let w = want[e.id];
		if (!w || e.address != w.ip || e.dev != w.dev || !e.subflow)
			push(cmds, "ip mptcp endpoint delete id " + e.id);
	}
	for (let l in eps) {
		let cur = have["" + l.id];
		if (!cur || cur.address != l.ip || cur.dev != l.dev || !cur.subflow)
			push(cmds, sprintf("ip mptcp endpoint add %s dev %s id %d subflow", l.ip, l.dev, l.id));
	}
}

export function mptcp_state(ctx) {
	let enabled = core.read("/proc/sys/net/mptcp/enabled") == "1";
	if (!enabled)
		return { enabled: false, subflows: 0, endpoints: [] };
	let lr = core.sh("ip mptcp limits show");
	let subflows = int(match(lr.out, /subflows\s+([0-9]+)/)?.[1] ?? "0");
	let eps = map(facts.ip("mptcp endpoint show"), (e) => ({ id: e.id, dev: e.dev ?? "", ip: e.address ?? "" }));
	return { enabled, subflows, endpoints: eps };
};

// Several addresses on one L2 segment: answer ARP only on the owning device
// and accept the asymmetric return path.
function strand_sysctl(ctx) {
	for (let l in ctx.strands) {
		let conf = "/proc/sys/net/ipv4/conf/" + l.dev + "/";
		core.knob(conf + "arp_ignore", 1);
		core.knob(conf + "arp_announce", 2);
		core.knob(conf + "arp_filter", 1);
		core.knob(conf + "rp_filter", 0);
	}
	core.knob("/proc/sys/net/ipv4/conf/lo/rp_filter", 0);
}

function run(what, cmds) {
	if (!length(cmds))
		return true;
	if (core.is_dry()) {
		warn(sprintf("%s: %d changes\n  %s\n", what, length(cmds), join("\n  ", cmds)));
		return true;
	}
	let r = core.sh("set -e\n" + join("\n", cmds));
	if (r.code != 0) {
		core.err("%s: %s", what, trim(r.out));
		return false;
	}
	core.event("%s %d changes", uc(what), length(cmds));
	return r.code == 0;
}

// --- entry points ----------------------------------------------------------

// The tunnel binds its tproxy listener to this address; it has to exist before
// the daemon starts or the listener is silently missing.
export function listen_addr(cfg) {
	let addr = cfg.tunnel.listen_addr;
	if (cfg.tunnel.enabled && !core.ok(sprintf("ip -4 addr show dev lo | grep -q ' %s/'", addr)))
		core.act(sprintf("ip addr add %s/32 dev lo", addr));
};

// Step 1, before any strand is probed: every addressed strand gets its
// routing table and rules. A probe bound to a strand only works once these exist.
export function plumb(ctx) {
	let cmds = [];
	strand_sysctl(ctx);
	plan_tproxy(ctx, cmds);
	plan_tables(ctx, cmds);
	plan_rules(ctx, cmds);
	return run("routes", cmds);
};

// Step 2, once health, the tunnel state and the weave are known.
export function apply(ctx) {
	let cmds = [];
	plan_default(ctx, cmds);
	if (!run("default route", cmds))
		return false;
	let mcmds = [];
	plan_mptcp(ctx, mcmds);
	return run("mptcp", mcmds) && apply_nft(ctx);
};

// Back to a plain router: fw4 NAT through netifd's default route.
export function teardown(ctx) {
	let cmds = [];
	if (fs.stat("/proc/sys/net/mptcp/enabled")) {
		push(cmds, "ip mptcp endpoint flush");
		push(cmds, "ip mptcp limits set subflows 2 add_addr_accepted 0");
	}
	if (core.ok("nft list table " + NFT))
		push(cmds, "nft delete table " + NFT);
	for (let r in facts.ip("-4 rule show")) {
		if (!managed_pref(r.priority))
			continue;
		push(cmds, "ip rule del " + rule_spec({
			pref: r.priority, mark: r.fwmark, mask: r.fwmask ?? "0xffffffff",
			src: r.src == "all" ? null : r.src, table: r.table,
		}));
	}
	for (let r in facts.ip("-4 route show table all")) {
		let t = int(r.table);
		if ((t > TABLE_BASE && t <= TABLE_BASE + 255) || t == TABLE_TPROXY)
			push(cmds, "ip route flush table " + t);
	}
	for (let r in facts.ip("-4 route show default"))
		if ("" + r.protocol == DEFAULT_PROTO)
			push(cmds, sprintf("ip route del default metric %d proto %s", DEFAULT_METRIC, DEFAULT_PROTO));
	let addr = ctx.cfg.tunnel.listen_addr;
	if (addr in (ctx.facts.addr4.lo?.all ?? []))
		push(cmds, sprintf("ip addr del %s/32 dev lo", addr));
	cmds = uniq(cmds);
	if (length(cmds))
		core.act(join("\n", cmds));
	delete ctx.st.nft;
	weave.remember([], []);
	core.event("KERNEL state removed");
};

export function alive() {
	return core.ok("nft list chain " + NFT + " prerouting");
};
