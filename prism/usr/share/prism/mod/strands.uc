// Strands: where we are, whether to aggregate, discovery, health and portal.
//
// A strand is one L3 device on the upstream network with its own address.
// Its identity (1..250) is the fwmark and conntrack mark of every flow woven
// onto it; routing table 1000+id sends those flows out through that device.
// Which strand a new flow takes is not decided here: see weave.uc.
//
// The uplink port is always a strand. The extra identities exist only while
// aggregating, and whether to aggregate follows the network we are plugged
// into: a site is recognised by its gateway's MAC address, so the router
// behaves like any other on an ordinary network and prisms on a known one
// without anyone flipping a switch.

import { cursor } from "uci";
import * as core from "../lib/core.uc";
import * as facts from "../lib/facts.uc";
import { path } from "../lib/config.uc";
import * as linkbroad from "../portal/linkbroad.uc";

// Portal plugins by name. A plugin exports login_cmd(dev, secret).
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

// --- site ------------------------------------------------------------------

// Which network is this? Answered by the MAC of the uplink's gateway.
//   { gateway, known, name, aggregate, portal, portal_secret }
// gateway is null while it cannot be resolved (no lease yet).
export function site(ctx) {
	let cfg = ctx.cfg, f = ctx.facts, st = ctx.st;
	let dev = facts.expand(cfg.strands.uplink, f.links)[0];
	let gw = dev ? f.netifd[dev]?.gw : null;
	let mac = gw ? facts.neighbour(dev, gw) : null;
	let here = { gateway: mac, known: false, name: "", portal: "", portal_secret: "" };
	for (let s in cfg.sites) {
		if (!mac || !(mac in s.gateway))
			continue;
		here = { gateway: mac, known: true, name: s.name, portal: s.portal, portal_secret: s.portal_secret, wants: !!s.aggregate };
		break;
	}
	if (here.known && length(here.portal)) {
		st.site_portals ??= {};
		st.site_portals[mac] = { portal: here.portal, portal_secret: here.portal_secret };
	}

	// auto follows the site. An unresolved gateway decides nothing: keep
	// whatever was in force, or a slow ARP reply would drop every identity.
	let mode = cfg.strands.aggregate;
	if (mode == "on" || mode == "off")
		here.aggregate = mode == "on";
	else if (mac)
		here.aggregate = !!here.wants;
	else
		here.aggregate = !!st.aggregate;
	if (here.aggregate != st.aggregate || mac != st.gateway) {
		core.event("SITE %s gateway=%s aggregate=%s", here.known ? here.name : "unknown", mac ?? "?", here.aggregate ? "on" : "off");
		st.aggregate = here.aggregate;
		st.gateway = mac;
	}
	return here;
};

// Bring the identity interfaces up or down to match. netifd owns them; we
// only say whether they should exist, and persist it so a reboot agrees.
export function steer(ctx) {
	let cfg = ctx.cfg, want = ctx.site.aggregate, uci = cursor(), cmds = [], dirty = false;
	uci.foreach("network", "interface", (s) => {
		if (!s.device || !length(filter(cfg.strands.identity, (p) => wildcard(s.device, p))))
			return;
		let name = s[".name"], up = (s.device in ctx.facts.links);
		if ((s.auto ?? "1") != (want ? "1" : "0")) {
			uci.set("network", name, "auto", want ? "1" : "0");
			dirty = true;
		}
		if (want != up)
			push(cmds, (want ? "ifup " : "ifdown ") + name);
	});
	if (!length(cmds) && !dirty)
		return;
	if (core.is_dry()) {
		warn(sprintf("identities: would run %d x %s\n", length(cmds), want ? "ifup" : "ifdown"));
		return;
	}
	if (dirty)
		uci.commit("network");
	if (length(cmds)) {
		core.sh(join("\n", cmds));
		core.event("IDENTITIES %s (%d interfaces)", want ? "up" : "down", length(cmds));
	}
};

// --- discovery -------------------------------------------------------------

// Every strand that exists right now, addressed or not. Gateway and subnet
// come from the strand's own DHCP lease, so nothing about the site is fixed.
export function discover(ctx) {
	let cfg = ctx.cfg.strands, f = ctx.facts, strands = [];
	let add = (devs, role, base) => {
		for (let i, dev in devs) {
			let a = f.addr4[dev], n = f.netifd[dev];
			push(strands, {
				dev, role,
				id: base + i + 1,
				ip: a?.ip,
				gw: n?.gw,
				subnet: a ? network(a.ip, a.prefix) : null,
				iface: n?.iface,
			});
		}
	};
	let primary = facts.expand([ ...cfg.uplink, ...(ctx.site.aggregate ? cfg.identity : []) ], f.links);
	add(primary, "primary", 0);
	add(filter(facts.expand(cfg.backup, f.links), (d) => !(d in primary)), "backup", BACKUP_BASE);
	return strands;
};

// --- health ----------------------------------------------------------------

// Stagger HTTP 204 probes across small waves to avoid gateway ARP/DNS thundering
// herds, and measure real data-plane TCP SYN/HTTP retransmit loss instead of
// gateway control-plane ICMP echo (which upstream switches rate-limit).
function probe(set, cfg) {
	let res = {};
	if (!length(set))
		return res;
	let cmds = [];
	const WAVE_SIZE = 7;
	for (let i = 0; i < length(set); i++) {
		if (i > 0 && i % WAVE_SIZE == 0)
			push(cmds, "ucode -e 'sleep(60)'");
		let s = set[i];
		push(cmds, sprintf(
			"curl -4 --interface %s -m %d --connect-timeout 2 -sS -o /dev/null -w '%s %%{http_code} %%{time_connect} %%{time_starttransfer} %%{time_namelookup}\\n' %s 2>/dev/null &",
			s.dev, cfg.probe_timeout, s.dev, core.shq(cfg.probe_url)));
	}
	push(cmds, "wait");
	for (let line in split(core.sh(join("\n", cmds)).out, "\n")) {
		let m = match(line, /^(\S+) ([0-9]+) ([0-9.]+) ([0-9.]+) ([0-9.]+)$/);
		if (m && !res[m[1]]) {
			let code = int(m[2]);
			let tcp_rtt = code > 0 ? max(0.005, (+m[3]) - (+m[5])) : 0;
			let pure = code > 0 ? max(0.005, (+m[4]) - (+m[5])) : 0;
			let sloss = 0.0;
			if (code != cfg.probe_expect)
				sloss = 1.0;
			else if (tcp_rtt >= 0.90)
				sloss = 0.50;
			else if (pure - tcp_rtt >= 0.50)
				sloss = 0.25;
			res[m[1]] = { code, ttfb: pure, tcp_rtt, loss: sloss };
		}
	}
	for (let s in set)
		res[s.dev] ??= { code: 0, ttfb: 0, tcp_rtt: 0, loss: 1.0 };
	return res;
}

function portal_login(devs, here, cfg) {
	let plugin = PORTALS[here.portal];
	let secret = plugin ? core.read(path(here.portal_secret)) : null;
	if (!secret || !length(devs))
		return false;
	if (core.is_dry()) {
		warn("would log in to portal '", here.portal, "' on: ", join(" ", devs), "\n");
		return false;
	}
	for (let i = 0; i < length(devs); i += cfg.auth_batch) {
		let batch = slice(devs, i, i + cfg.auth_batch);
		let cmds = map(batch, (d) => "( " + plugin.login_cmd(d, secret) + "\n) >/dev/null 2>&1 &");
		push(cmds, "wait");
		core.sh(join("\n", cmds));
	}
	return true;
}

// Probe what is due, log failing strands in, and return the health picture:
//   routed   strands with an address and gateway (they get a routing table)
//   healthy  strands that may carry new flows
//   role     primary | backup | none
export function check(ctx) {
	let cfg = ctx.cfg.strands, st = ctx.st, now = ctx.now, strands = ctx.strands;
	st.strands ??= {};
	let routed = filter(strands, (s) => s.ip && s.gw);
	let state = (s) => (st.strands[s.dev] ??= { code: 0, ttfb: 0, loss: 0, probed: 0, strikes: 0, logins: 0, parked: 0 });
	let good = (s) => state(s).code == cfg.probe_expect;

	// The dashboard's "log in again" clears every park and forces a full round.
	if (ctx.request?.relogin)
		for (let s in routed)
			state(s).probed = state(s).parked = state(s).logins = 0;

	let due = filter(routed, (s) => !good(s) || now - state(s).probed >= cfg.probe_interval);
	let run = (set) => {
		let res = probe(set, cfg);
		for (let s in set) {
			let h = state(s), r = res[s.dev] ?? { code: 0, ttfb: 0, loss: h.loss ?? 0 };
			h.code = r.code;
			let sloss = r.loss ?? 0.0;
			if (!h.probed || h.loss == null)
				h.loss = sloss;
			else if (sloss >= 0.5)
				h.loss = max(0.45 * sloss + 0.55 * h.loss, sloss * 0.7);
			else if (sloss > 0)
				h.loss = 0.40 * sloss + 0.60 * h.loss;
			else
				h.loss = h.loss * 0.35;
			if (h.loss < 0.002)
				h.loss = 0.0;
			if (r.code == cfg.probe_expect && r.ttfb > 0) {
				let sample = (h.ttfb > 0 && h.ttfb < 0.45 && r.ttfb > h.ttfb * 1.8) ? (h.ttfb * 1.25) : r.ttfb;
				h.ttfb = (h.ttfb > 0 && h.ttfb < 0.45) ? (0.35 * sample + 0.65 * h.ttfb) : sample;
			}
			else {
				h.ttfb = max(0.45, (h.ttfb ?? 0.20) * 1.5);
			}
			h.probed = now;
		}
	};
	run(due);

	// Up to 3 batches per pass so mass portal drops recover quickly without
	// blocking forever on an unresponsive upstream.
	let login = [], backlog = false;
	for (let s in filter(due, (s) => !good(s))) {
		let h = state(s);
		if (h.parked && now - h.parked < cfg.park_sec)
			continue;
		if (length(login) >= cfg.auth_batch * 3) {
			backlog = true;
			continue;
		}
		h.parked = 0;
		if (++h.logins >= cfg.park_fails)
			h.parked = now;
		push(login, s);
	}
	// The re-probe, not the portal's answer, says whether a login worked:
	// log both outcomes so a portal that stops accepting us is visible.
	let failed_login = {};
	if (length(login) && portal_login(map(login, (s) => s.dev), ctx.site, cfg)) {
		run(login);
		let back = filter(login, good), down = filter(login, (s) => !good(s));
		for (let s in down)
			failed_login[s.dev] = true;
		let devs = (set) => join(" ", map(set, (s) => s.dev + (!good(s) && state(s).parked ? " (parked)" : "")));
		core.event("PORTAL %s login: %s%s", ctx.site.portal,
			length(back) ? "back " + devs(back) : "",
			length(down) ? (length(back) ? "; " : "") + "still down " + devs(down) : "");
	}
	if (backlog)
		ctx.want_rescan = true;

	// A strand survives fail_keep-1 transient timeouts so one lost probe does
	// not flap it, whereas captive-portal HTTP answers or failed re-logins are
	// evicted immediately to avoid blackholing client flows.
	let healthy = [];
	for (let s in routed) {
		let h = state(s);
		s.ttfb = h.ttfb ?? 0;
		s.http = h.code ?? 0;
		s.loss = +(sprintf("%.3f", h.loss ?? 0));
		let captive = (h.code >= 200 && h.code != cfg.probe_expect);
		if (good(s))
			h.strikes = h.logins = h.parked = 0;
		else if (s in due)
			h.strikes = (failed_login[s.dev] || captive) ? max(h.strikes + 1, cfg.fail_keep) : h.strikes + 1;
		if (h.strikes < cfg.fail_keep)
			push(healthy, s);
	}
	for (let dev in keys(st.strands))
		if (!length(filter(strands, (s) => s.dev == dev)))
			delete st.strands[dev];

	let primary = filter(healthy, (s) => s.role == "primary");
	healthy = length(primary) ? primary : filter(healthy, (s) => s.role == "backup");

	let ids = join(" ", map(healthy, (s) => s.id));
	if (ids != st.healthy_ids) {
		core.event("STRANDS %d of %d healthy: %s", length(healthy), length(strands), ids);
		st.healthy_ids = ids;
	}
	return { routed, healthy, role: healthy[0]?.role ?? "none" };
};
