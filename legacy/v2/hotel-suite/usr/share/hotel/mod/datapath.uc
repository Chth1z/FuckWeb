// The kernel side: one nft table, policy rules and per-leg routing tables.
// This module only turns a plan into kernel state. It decides nothing.
//
// nft is applied as independent units, each with a digest in the state file.
// A tick sends only the units that changed, all in one atomic transaction.
// The skeleton ("base") is replaced only when its text changes; that is the
// one case that reloads the large sets and resets the leg counters.

import * as fs from "fs";
import * as core from "../lib/core.uc";
import * as facts from "../lib/facts.uc";
import { path } from "../lib/config.uc";

export const MARK_TPROXY = 0x4000;      // packet was handed to mihomo
export const MARK_OUT = 0x8000;         // mihomo's own sockets (routing-mark)
const MARK_ID = 0xff;                   // uplink identity

const TABLE_TPROXY = 100;
const PREF_TPROXY = 50;
const TABLE_BASE = 1000;                // per-leg table = base + id
const PREF_MARK = 1000;                 // fwmark id -> table
const PREF_FROM = 2000;                 // from leg address -> table
const DEFAULT_PROTO = "99";             // tags the default route we own
const DEFAULT_METRIC = 5;

const NFT = "inet hotel";
const LEGACY_TABLES = [ "hotel_split", "hotel_sqm", "hotel_sb" ];

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
	let cfg = ctx.cfg, up = ctx.uplink, px = ctx.proxy;

	let base = render(core.SHARE + "/tpl/ruleset.ut", {
		lan: cfg.main.lan_dev,
		legs: map(up.legs, (l) => l.dev),
		ipv6: cfg.main.ipv6,
		mss: cfg.main.mss,
		tproxy_addr: cfg.proxy.tproxy_addr,
		tproxy_port: cfg.proxy.tproxy_port,
		mark_tproxy: hex(MARK_TPROXY),
		mark_out: hex(MARK_OUT),
	});

	let proxy = [];
	if (px.on) {
		push(proxy, "ip daddr @node4 return");
		push(proxy, "ip daddr @proxy4 goto divert");
		push(proxy, "ip daddr @proxy4_dyn goto divert");
		if (length(cfg.split.proxy_udp_port))
			push(proxy, sprintf("udp dport { %s } goto divert", join(", ", cfg.split.proxy_udp_port)));
		push(proxy, "ip daddr @direct4 return");
		if (cfg.split.quic == "reject")
			push(proxy, "udp dport 443 reject");
		if (cfg.split.remainder == "proxy")
			push(proxy, "goto divert");
	}

	let balance = [];
	if (length(up.slots)) {
		push(balance, "ct mark != 0 meta mark set ct mark return");
		push(balance, sprintf("ct state new ct mark set numgen inc mod %d map @slot", length(up.slots)));
		push(balance, "meta mark set ct mark");
	}

	let slots = [];
	for (let i, id in up.slots)
		push(slots, i + " : " + id);

	return [
		unit("base", base),
		file_set_unit("direct4", path(cfg.split.direct4)),
		set_unit("set", "proxy4", core.lines(path(cfg.split.proxy4))),
		set_unit("set", "node4", px.node_ips ?? []),
		set_unit("map", "slot", slots),
		chain_unit("proxy", proxy),
		chain_unit("balance", balance),
	];
}

// SmartDNS only adds an address when it resolves the name, so carry the live
// entries across a skeleton rebuild.
function carry_dynamic() {
	let r = core.sh("nft -j list set " + NFT + " proxy4_dyn");
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
	return length(elems) ? sprintf("add element %s proxy4_dyn { %s }\n", NFT, join(", ", elems)) : "";
}

function apply_nft(ctx) {
	let units = build(ctx);
	let seen = ctx.st.nft ?? {};
	let alive = core.ok("nft list chain " + NFT + " prerouting");
	let full = ctx.force || !alive || seen.base != units[0].digest;

	let script = "", changed = [], digests = {};
	if (full) {
		for (let t in LEGACY_TABLES)
			if (core.ok("nft list table inet " + t))
				script += "delete table inet " + t + "\n";
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
	if (full)
		core.event("NFT rebuilt");
	else if (length(filter(changed, (n) => n != "slot")))
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
	return filter(ctx.legs, (l) => l.ip && l.gw);
}

function plan_rules(ctx, cmds) {
	let want = {};
	let add = (r) => (want[rule_spec(r)] = true);
	if (ctx.cfg.proxy.enabled)
		add({ pref: PREF_TPROXY, mark: hex(MARK_TPROXY), mask: hex(MARK_TPROXY), table: TABLE_TPROXY });
	for (let l in routed(ctx)) {
		add({ pref: PREF_MARK + l.id, mark: hex(l.id), mask: hex(MARK_ID), table: TABLE_BASE + l.id });
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
	if (!ctx.cfg.proxy.enabled)
		return;
	let addr = ctx.cfg.proxy.tproxy_addr;
	if (!(addr in (ctx.facts.addr4.lo?.all ?? [])))
		push(cmds, sprintf("ip addr add %s/32 dev lo", addr));
	if (!length(facts.ip("-4 route show table " + TABLE_TPROXY)))
		push(cmds, "ip route replace local default dev lo table " + TABLE_TPROXY);
}

// Router-originated traffic follows netifd's default route. Override it only
// while that device is not a healthy leg.
function plan_default(ctx, cmds) {
	let first = ctx.uplink.healthy[0];
	let ours = null, stock = null;
	for (let r in facts.ip("-4 route show default")) {
		if ("" + r.protocol == DEFAULT_PROTO)
			ours = r;
		else if (!stock || (r.metric ?? 0) < (stock.metric ?? 0))
			stock = r;
	}
	let healthy = (dev) => length(filter(ctx.uplink.healthy, (l) => l.dev == dev)) > 0;
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
function leg_sysctl(ctx) {
	for (let l in ctx.legs) {
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

// mihomo binds its tproxy listener to this address; it has to exist before
// the daemon starts or the listener is silently missing.
export function listen_addr(cfg) {
	let addr = cfg.proxy.tproxy_addr;
	if (cfg.proxy.enabled && !core.ok(sprintf("ip -4 addr show dev lo | grep -q ' %s/'", addr)))
		core.act(sprintf("ip addr add %s/32 dev lo", addr));
};

// Step 1, before any leg is probed: every addressed leg gets its routing
// table and rules. A probe bound to a leg only works once these exist.
export function plumb(ctx) {
	let cmds = [];
	leg_sysctl(ctx);
	plan_tproxy(ctx, cmds);
	plan_tables(ctx, cmds);
	plan_rules(ctx, cmds);
	return run("routes", cmds);
};

// Step 2, once health and the proxy state are known.
export function apply(ctx) {
	let cmds = [];
	plan_default(ctx, cmds);
	run("default route", cmds);
	return apply_nft(ctx);
};

// Back to a plain router: fw4 NAT through netifd's default route.
export function teardown(ctx) {
	let cmds = [];
	for (let t in [ "hotel", ...LEGACY_TABLES ])
		if (core.ok("nft list table inet " + t))
			push(cmds, "nft delete table inet " + t);
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
	let addr = ctx.cfg.proxy.tproxy_addr;
	if (addr in (ctx.facts.addr4.lo?.all ?? []))
		push(cmds, sprintf("ip addr del %s/32 dev lo", addr));
	cmds = uniq(cmds);
	if (length(cmds))
		core.act(join("\n", cmds));
	delete ctx.st.nft;
	core.event("DATAPATH off");
};

export function alive() {
	return core.ok("nft list chain " + NFT + " prerouting");
};
