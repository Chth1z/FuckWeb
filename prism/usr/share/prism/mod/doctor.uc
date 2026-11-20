// Health report. Every check is one row: { id, level, ok, detail }.
// A failed "fail" row makes the report not ok; "warn" rows are visible only.
// Checks look at the live system, never at what a module believes it did.

import * as fs from "fs";
import { cursor } from "uci";
import * as core from "../lib/core.uc";
import * as facts from "../lib/facts.uc";
import { path } from "../lib/config.uc";
import { ap_forwarding } from "./wifi.uc";
import { responsive as dns_responsive } from "./dns.uc";

function nft_has(what, pattern) {
	let r = core.sh("nft list " + what);
	return r.code == 0 && (pattern == null || index(r.out, pattern) >= 0);
}

function section_has(tbl_res, section, pattern) {
	if (!tbl_res || tbl_res.code != 0)
		return false;
	let tag = "\t" + section + " {\n";
	let a = index(tbl_res.out, tag);
	if (a < 0)
		return false;
	let rest = substr(tbl_res.out, a + length(tag));
	let b = index(rest, "\n\t}");
	let block = b >= 0 ? substr(rest, 0, b) : rest;
	return pattern == null || index(block, pattern) >= 0;
}

function listening(pattern) {
	return core.ok("netstat -lntup | grep -q " + core.shq(pattern));
}

function private_file(file) {
	let st = fs.stat(file);
	return !st || (st.perm.group_read == false && st.perm.other_read == false);
}

export function run(ctx) {
	let cfg = ctx.cfg, health = ctx.health, tun = ctx.tunnel, uci = cursor();
	let checks = [];
	let check = (level, id, ok, detail) => push(checks, { id, level, ok: !!ok, detail: detail ?? "" });
	let fail = (id, ok, detail) => check("fail", id, ok, detail);
	let caution = (id, ok, detail) => check("warn", id, ok, detail);
	let n = length(health.healthy);
	let tbl_prism = core.sh("nft -t list table inet prism");
	let tbl_guard = core.sh("nft list table inet prism_guard");

	// --- forwarding and the prism
	fail("ip_forward", core.read("/proc/sys/net/ipv4/ip_forward") == "1");
	fail("nft_table", section_has(tbl_prism, "chain prerouting", "jump classify"));
	fail("dns_hijack", section_has(tbl_prism, "chain dns_hijack", "redirect"));
	fail("privacy_guard", section_has(tbl_guard, "chain forward", "blocked-fallback"));
	fail("privacy_verified_pairs", section_has(tbl_guard, "chain forward", "@verified_pairs") &&
		section_has(tbl_prism, "chain classify", "@verified_pairs"));
	fail("privacy_guard_persistent", fs.stat(core.is_dry() ? core.outpath("guard.nft") : path("guard.nft")) &&
		fs.stat("/usr/share/nftables.d/ruleset-post/30-prism-guard.nft") &&
		uci.get("firewall", "@defaults[0]", "auto_includes") != "0");
	fail("privacy_direct_mark", section_has(tbl_prism, "chain direct_ok", "0x20000000"));
	let no_offload = uci.get("firewall", "@defaults[0]", "flow_offloading") != "1" &&
		uci.get("firewall", "@defaults[0]", "flow_offloading_hw") != "1";
	fail("privacy_no_offload", no_offload, no_offload ? "" : "offload would bypass per-packet privacy checks");
	fail("strands_healthy", n > 0, sprintf("%d of %d", n, length(ctx.strands)));
	if (n > 1) {
		fail("weave", section_has(tbl_prism, "chain weave", "ct state new"));
		fail("pattern", nft_has("map inet prism pattern", " : "));
		if (ctx.site.aggregate && fs.stat("/proc/sys/net/mptcp/enabled")) {
			let mptcp_on = core.read("/proc/sys/net/mptcp/enabled") == "1";
			caution("mptcp_enabled", mptcp_on, mptcp_on ? "" : "net.mptcp.enabled != 1");
			let mlim = core.sh("ip mptcp limits show").out;
			let eps = facts.ip("mptcp endpoint show");
			caution("mptcp_pool", int(match(mlim, /subflows\s+([0-9]+)/)?.[1] ?? "0") >= 1 && length(eps) >= 2,
				sprintf("%d endpoints, %s", length(eps), trim(mlim)));
		}
	}
	if (ctx.site.aggregate)
		caution("strands_low", n >= length(ctx.strands) * 0.85, sprintf("%d of %d", n, length(ctx.strands)));
	let first_cidr = core.lines(path(cfg.classify.domestic4))[0];
	fail("domestic4_loaded", first_cidr && core.ok(sprintf("nft get element inet prism domestic4 '{ %s }'", split(first_cidr, "/")[0])));

	// Every strand must leave through a masquerading firewall zone.
	let masq = {};
	uci.foreach("firewall", "zone", (z) => {
		if (z.masq == "1")
			for (let net in (type(z.network) == "array" ? z.network : [ z.network ]))
				masq[net] = true;
	});
	let unzoned = filter(health.routed, (s) => !masq[s.iface]);
	fail("strands_masq", !length(unzoned), join(" ", map(unzoned, (s) => s.dev)));

	// --- tunnel
	if (cfg.tunnel.enabled) {
		fail("tunnel_relays", tun.relays > 0);
		fail("tunnel_running", tun.running);
		fail("tunnel_divert", !tun.on || section_has(tbl_prism, "chain classify", "goto divert"));
		fail("tunnel_mixed_local", !tun.running || listening(sprintf("127.0.0.1:%d ", cfg.tunnel.mixed_port)));
		caution("tunnel_canary", !tun.running || (ctx.st.tunnel?.fails ?? 0) == 0, sprintf("%d failed", ctx.st.tunnel?.fails ?? 0));
	}

	// --- DNS and DHCP
	fail("smartdns", core.pidof("smartdns"));
	fail("smartdns_loopback", index(fs.readfile(core.outpath("smartdns.conf")) ?? "", "bind 127.0.0.1:") == 0);
	let dns_ok = ctx.dns_responsive ?? dns_responsive(cfg.dns.port);
	fail("smartdns_responsive", dns_ok, dns_ok ? "" : "SmartDNS query timeout");
	fail("dnsmasq", core.pidof("dnsmasq"));
	fail("dhcp_listen", listening("0.0.0.0:67 "));
	fail("dhcp_lan", uci.get("dhcp", "lan", "dhcpv4") == "server" && uci.get("dhcp", "lan", "ignore") != "1");
	let hook_ok = fs.stat("/etc/hotplug.d/dhcp/50-prism") &&
		!!match(core.sh("grep -l '^dhcp-script=' /var/etc/dnsmasq.conf.* 2>/dev/null").out, /dnsmasq\.conf/);
	caution("dhcp_hook", hook_ok, hook_ok ? "" : "dnsmasq missing dhcp-script (restart dnsmasq)");
	let fwd = uci.get("dhcp", "@dnsmasq[0]", "server");
	let want_fwd = sprintf("127.0.0.1#%d", cfg.dns.port);
	let fwd_ok = join(" ", type(fwd) == "array" ? fwd : [ fwd ]) == want_fwd;
	fail("dns_forward", fwd_ok, fwd_ok ? want_fwd : "dnsmasq must forward to SmartDNS only");

	// --- uplink copper and shaper
	let dev = cfg.shaper.device, speed = int(core.read("/sys/class/net/" + dev + "/speed") ?? "0");
	let copper = facts.carrier(dev);
	fail("uplink_carrier", copper, dev);
	if (cfg.shaper.mode != "off" && copper) {
		let qdisc = core.sh("tc qdisc show dev " + core.shq(dev)).out;
		if (speed == 10 || speed == 100) {
			let shaper_ok = index(qdisc, "htb") >= 0;
			fail("shaper", shaper_ok, shaper_ok ? sprintf("%s htb (%dM)", dev, speed) : sprintf("%s at %d Mbit has no shaper", dev, speed));
		}
		else {
			caution("shaper", speed <= 0 || !!match(qdisc, /htb|fq_codel|cake/));
		}
	}

	// --- Wi-Fi
	if (length(cfg.wifi.ap)) {
		fail("hostapd", core.pidof("hostapd"));
		let ssids = [];
		uci.foreach("wireless", "wifi-iface", (s) => {
			if (s.mode != "ap")
				return;
			push(ssids, s.ssid);
			if (s.multicast_to_unicast == "1" || s.multicast_to_unicast_all == "1")
				fail("wifi_m2u:" + s[".name"], false, "breaks DHCP/mDNS for clients");
			if (s.isolate == "1")
				fail("wifi_isolate:" + s[".name"], false);
		});
		for (let ap in cfg.wifi.ap) {
			fail("ap:" + ap, ap_forwarding(ap));
			let m = match(core.sh("iw dev " + core.shq(ap) + " info").out, /ssid ([^\n]+)/);
			fail("ap_ssid:" + ap, m && m[1] in ssids, m ? m[1] : "no ssid");
		}
		let sta = cfg.wifi.backup_sta;
		if (length(sta) && uci.get("wireless", sta))
			fail("sta_with_copper", !(copper && (uci.get("wireless", sta, "disabled") ?? "0") == "0"));
		caution("wifi_setup", index(core.sh("ubus call network.wireless status").out, '"retry_setup_failed": true') < 0);
	}

	// --- exposure and secrets
	fail("ssh_public", !listening("0.0.0.0:22 .*dropbear"));
	fail("http_public", !listening("0.0.0.0:80 .*uhttpd"));
	let secrets = [ core.ETC + "/controller.secret", path(cfg.tunnel.relays), core.RUN + "/mihomo.yaml", ...map(cfg.sites, (s) => path(s.portal_secret)) ];
	let loose = filter(secrets, (f) => !private_file(f));
	fail("secret_perms", !length(loose), join(" ", loose));

	// --- resources
	let free_kb = int(trim(core.sh("df -k /overlay | awk 'NR==2 {print $4}'").out));
	fail("overlay_space", free_kb > 5120, free_kb + " kB free");

	let failed = map(filter(checks, (c) => !c.ok && c.level == "fail"), (c) => c.id);
	let warned = map(filter(checks, (c) => !c.ok && c.level == "warn"), (c) => c.id);
	return { ts: ctx.now, ok: !length(failed), fail: failed, warn: warned, checks };
};

export function text(report) {
	let out = sprintf("%s  fail=%d warn=%d\n", report.ok ? "OK" : "NOT OK", length(report.fail), length(report.warn));
	for (let c in report.checks)
		if (!c.ok)
			out += sprintf("  %-4s %s%s\n", uc(c.level), c.id, length(c.detail) ? "  (" + c.detail + ")" : "");
	return out;
};
