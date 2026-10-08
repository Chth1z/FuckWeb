// Health report. Every check is one row: { id, level, ok, detail }.
// A failed "fail" row makes the report not ok; "warn" rows are visible only.
// Checks look at the live system, never at what a module believes it did.

import * as fs from "fs";
import { cursor } from "uci";
import * as core from "../lib/core.uc";
import * as facts from "../lib/facts.uc";
import { path } from "../lib/config.uc";
import { ap_forwarding } from "./wifi.uc";

function nft_has(what, pattern) {
	let r = core.sh("nft list " + what);
	return r.code == 0 && (pattern == null || index(r.out, pattern) >= 0);
}

function listening(pattern) {
	return core.ok("netstat -lntup | grep -q " + core.shq(pattern));
}

function mode600(file) {
	let st = fs.stat(file);
	return !st || (st.perm.group_read == false && st.perm.other_read == false);
}

export function run(ctx) {
	let cfg = ctx.cfg, up = ctx.uplink, px = ctx.proxy, uci = cursor();
	let checks = [];
	let check = (level, id, ok, detail) => push(checks, { id, level, ok: !!ok, detail: detail ?? "" });
	let fail = (id, ok, detail) => check("fail", id, ok, detail);
	let warn_ = (id, ok, detail) => check("warn", id, ok, detail);

	// --- forwarding and datapath
	fail("ip_forward", core.read("/proc/sys/net/ipv4/ip_forward") == "1");
	fail("nft_table", nft_has("chain inet hotel prerouting", "jump proxy"));
	fail("dns_hijack", nft_has("chain inet hotel dns_hijack", "redirect"));
	if (cfg.uplink.mode == "multi") {
		fail("legs_healthy", length(up.healthy) > 0, sprintf("%d of %d", length(up.healthy), length(up.legs)));
		fail("balance", !length(up.healthy) || nft_has("chain inet hotel balance", "numgen"));
		warn_("legs_low", length(up.healthy) >= cfg.led.green, sprintf("%d < %d", length(up.healthy), cfg.led.green));
	}
	let first_cidr = core.lines(path(cfg.split.direct4))[0];
	fail("direct4_loaded", first_cidr && core.ok(sprintf("nft get element inet hotel direct4 '{ %s }'", split(first_cidr, "/")[0])));

	// Every leg must leave through a masquerading firewall zone.
	let masq = {};
	uci.foreach("firewall", "zone", (z) => {
		if (z.masq == "1")
			for (let n in (type(z.network) == "array" ? z.network : [ z.network ]))
				masq[n] = true;
	});
	let unzoned = filter(up.routed, (l) => !masq[l.iface]);
	fail("legs_masq", !length(unzoned), join(" ", map(unzoned, (l) => l.dev)));

	// --- proxy
	if (cfg.proxy.enabled) {
		fail("proxy_nodes", px.nodes > 0);
		fail("proxy_running", px.running);
		fail("proxy_tproxy", !px.on || nft_has("chain inet hotel proxy", "goto divert"));
		fail("proxy_mixed_local", !px.running || listening(sprintf("127.0.0.1:%d ", cfg.proxy.mixed_port)));
		warn_("proxy_fail_open", !ctx.st.proxy?.open, "canary down, traffic goes direct");
		warn_("proxy_canary", !px.running || (ctx.st.proxy?.fails ?? 0) == 0, sprintf("%d failed", ctx.st.proxy?.fails ?? 0));
	}

	// --- DNS and DHCP
	fail("smartdns", core.pidof("smartdns"));
	fail("smartdns_loopback", index(fs.readfile(core.RUN + "/smartdns.conf") ?? "", "bind 127.0.0.1:") == 0);
	fail("dnsmasq", core.pidof("dnsmasq"));
	fail("dhcp_listen", listening("0.0.0.0:67 "));
	fail("dhcp_lan", uci.get("dhcp", "lan", "dhcpv4") == "server" && uci.get("dhcp", "lan", "ignore") != "1");
	let fwd = uci.get("dhcp", "@dnsmasq[0]", "server");
	fail("dns_forward", join(" ", type(fwd) == "array" ? fwd : [ fwd ]) == sprintf("127.0.0.1#%d", cfg.dns.port), "dnsmasq must forward to SmartDNS only");

	// --- uplink copper and shaper
	let dev = cfg.sqm.device, speed = int(core.read("/sys/class/net/" + dev + "/speed") ?? "0");
	let copper = facts.carrier(dev);
	fail("uplink_carrier", copper, dev);
	if (cfg.sqm.mode != "off" && copper) {
		let qdisc = core.sh("tc qdisc show dev " + dev).out;
		if (speed == 10 || speed == 100)
			fail("sqm", index(qdisc, "htb") >= 0, sprintf("%s at %d Mbit has no shaper", dev, speed));
		else
			warn_("sqm", speed <= 0 || !!match(qdisc, /htb|fq_codel|cake/));
	}

	// --- Wi-Fi
	if (length(cfg.wifi.ap)) {
		fail("hostapd", core.pidof("hostapd"));
		let ssids = [];
		uci.foreach("wireless", "wifi-iface", (s) => {
			if (s.mode == "ap")
				push(ssids, s.ssid);
			if (s.mode == "ap" && (s.multicast_to_unicast == "1" || s.multicast_to_unicast_all == "1"))
				fail("wifi_m2u:" + s[".name"], false, "breaks DHCP/mDNS for clients");
			if (s.mode == "ap" && s.isolate == "1")
				fail("wifi_isolate:" + s[".name"], false);
		});
		for (let ap in cfg.wifi.ap) {
			fail("ap:" + ap, ap_forwarding(ap));
			let m = match(core.sh("iw dev " + ap + " info").out, /ssid ([^\n]+)/);
			fail("ap_ssid:" + ap, m && m[1] in ssids, m ? m[1] : "no ssid");
		}
		let sta = cfg.wifi.backup_sta;
		if (length(sta) && uci.get("wireless", sta))
			fail("sta_with_copper", !(copper && (uci.get("wireless", sta, "disabled") ?? "0") == "0"));
		warn_("wifi_setup", index(core.sh("ubus call network.wireless status").out, '"retry_setup_failed": true') < 0);
	}

	// --- exposure and secrets
	fail("ssh_public", !listening("0.0.0.0:22 .*dropbear"));
	fail("http_public", !listening("0.0.0.0:80 .*uhttpd"));
	let loose = filter([ core.ETC + "/clash.secret", cfg.uplink.portal_secret, path(cfg.proxy.nodes), core.RUN + "/mihomo.yaml" ], (f) => !mode600(f));
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
