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
import * as devices from "./devices.uc";

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

const NFT = "inet braid";

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

	let base = render(core.SHARE + "/tpl/braid.nft.ut", {
		lan: cfg.main.lan_dev,
		strands: map(ctx.strands, (s) => s.dev),
		ipv6: cfg.main.ipv6,
		mss: cfg.main.mss,
		listen_addr: cfg.tunnel.listen_addr,
		tproxy_port: cfg.tunnel.tproxy_port,
		mark_diverted: hex(MARK_DIVERTED),
		mark_tunnel_out: hex(MARK_TUNNEL_OUT),
	});

	// Each rule carries a counter and a tag; the dashboard reads both to show
	// where traffic actually goes (api.uc: rules).
	let rule = (test, verdict, tag) => trim(sprintf('%s counter %s comment "%s"', test, verdict, tag));

	// Order is the policy. Devices first, because a per-device choice
	// overrides everything; then forced-tunnel ranges before the domestic
	// set, or Cloudflare's mainland ranges would slip out direct.
	let classify = [ rule("ether saddr @dev_block", "drop", "device-block") ];
	if (tun.on) {
		push(classify, rule("ether saddr @dev_direct", "goto direct_ok", "device-direct"));
		push(classify, rule("ip daddr @relay4", "goto direct_ok", "relay"));
		push(classify, rule("ether saddr @dev_tunnel", "goto divert", "device-tunnel"));
		push(classify, rule("ip daddr @tunnel4", "goto divert", "tunnel-range"));
		push(classify, rule("ip daddr @tunnel4_dns", "goto divert", "tunnel-domain"));
		if (length(c.tunnel_udp_port))
			push(classify, rule(sprintf("udp dport { %s }", join(", ", c.tunnel_udp_port)), "goto divert", "tunnel-port"));
		push(classify, rule("ip daddr @domestic4", "goto direct_ok", "domestic"));
		if (c.quic == "reject")
			push(classify, rule("udp dport 443", "reject", "quic"));
		push(classify, c.remainder == "tunnel" ? rule("", "goto divert", "rest-tunnel") : rule("", "goto direct_ok", "rest-direct"));
	}

	// See weave.uc for what the two maps mean. In auto, a pair's first
	// connections follow @anchor; once it opens them faster than the burst
	// allowance, the overflow takes the next @pattern slot instead.
	// The strand lives in the low byte of the conntrack mark.
	let w = ctx.weave, lay = [], lay_out = [];
	if (w.slots > 0) {
		let known = "ct mark and 0xff != 0 meta mark set ct mark and 0xff return";
		let apply = "meta mark set ct mark and 0xff";
		let spread = sprintf("ct mark set numgen inc mod %d map @pattern", w.slots);
		let pin = sprintf("ct mark set jhash ip saddr . ip daddr mod %d map @anchor", weave.ANCHOR_SLOTS);
		let spill = max(1, cfg.weave.spill);
		push(lay, known);
		if (cfg.weave.affinity == "flow") {
			push(lay, "ct state new " + spread);
		}
		else if (cfg.weave.affinity == "dest") {
			push(lay, "ct state new " + pin);
		}
		else {
			push(lay, sprintf("ct state new add @bursty { ip saddr . ip daddr limit rate over %d/minute burst %d packets } %s", spill * 2, spill, spread));
			push(lay, "ct state new ct mark and 0xff == 0 " + pin);
		}
		push(lay, apply);
		// The tunnel's own connections always spread. The far end of those is
		// a relay, which neither knows nor cares which strand a packet took;
		// pinning them would squeeze the whole tunnel through one identity.
		lay_out = [ known, "ct state new " + spread, apply ];
	}

	let dev = devices.policy_sets(cfg);
	return [
		unit("base", base),
		file_set_unit("domestic4", path(c.domestic4)),
		set_unit("set", "tunnel4", core.lines(path(c.tunnel4))),
		set_unit("set", "relay4", tun.relay_ips ?? []),
		set_unit("set", "dev_direct", dev.direct),
		set_unit("set", "dev_tunnel", dev.tunnel),
		set_unit("set", "dev_block", dev.block),
		unit("anchor", weave.script("anchor", w.anchor)),
		chain_unit("classify", classify),
		chain_unit("weave", lay),
		chain_unit("weave_out", lay_out),
	];
}

// SmartDNS only adds an address when it resolves the name, so carry the live
// entries across a skeleton rebuild.
function carry_dynamic() {
	let r = core.sh("nft -j list set " + NFT + " tunnel4_dns");
	if (r.code != 0)
		return "";
	let elems = [];
	try {
		for (let item in json(r.out).nftables)
			for (let e in item.set?.elem ?? [])
				if (e.elem?.expires > 0)
					push(elems, sprintf("%s timeout %ds", e.elem.val, e.elem.expires));
	}
	catch (e) {
		return "";
	}
	return length(elems) ? sprintf("add element %s tunnel4_dns { %s }\n", NFT, join(", ", elems)) : "";
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
	// The pattern map belongs to the weave. It rides along only when the map
	// was just emptied by a rebuild or is no longer valid for the healthy set.
	let lay_pattern = full || ctx.weave.repair;
	if (lay_pattern)
		script += weave.script("pattern", ctx.weave.pattern);
	if (!length(script))
		return true;

	let file = core.outpath("ruleset.nft");
	fs.writefile(file, script);
	let r = core.sh((core.is_dry() ? "nft -c -f " : "nft -f ") + file);
	if (r.code != 0) {
		core.err("nft rejected %s: %s", file, trim(r.out));
		return false;
	}
	if (core.is_dry()) {
		warn(sprintf("nft: %s valid (%s) -> %s\n", full ? "full rebuild" : "update", join(" ", changed), file));
		return true;
	}
	ctx.st.nft = digests;
	if (lay_pattern)
		weave.remember(ctx.weave.pattern);
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
	let r = core.sh(join("\n", cmds));
	if (r.code != 0 || length(trim(r.out)))
		core.err("%s: %s", what, trim(r.out));
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
	run("default route", cmds);
	return apply_nft(ctx);
};

// Back to a plain router: fw4 NAT through netifd's default route.
export function teardown(ctx) {
	let cmds = [];
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
	weave.remember([]);
	core.event("KERNEL state removed");
};

export function alive() {
	return core.ok("nft list chain " + NFT + " prerouting");
};
