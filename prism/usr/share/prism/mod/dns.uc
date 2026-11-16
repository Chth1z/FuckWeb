// DNS: dnsmasq (LAN :53, DHCP names) -> SmartDNS -> upstreams.
//
//   tunnel up    cn-list -> domestic DoH, everything else -> mihomo's resolver
//               (so a name is resolved the same way its traffic is forwarded)
//   fail-open    tunnel down -> domestic DoH
//   fail-closed  boot/down/stop never changes foreign DNS to a direct upstream
//
// Plain UDP/53 is never an upstream: networks like this one intercept it.

import * as fs from "fs";
import { cursor } from "uci";
import * as core from "../lib/core.uc";
import { path } from "../lib/config.uc";

const LISTS = {
	cn: core.SHARE + "/cn-domains.gz",
	ad: core.SHARE + "/ad-domains.gz",
};

// Unpack a packed list into RUN when the archive changed. Returns the path
// of the plain list, or null when there is none.
function unpack(name) {
	let gz = LISTS[name], out = core.RUN + "/" + name + ".list", stamp = out + ".stamp";
	let st = fs.stat(gz);
	if (!st)
		return null;
	let mark = sprintf("%d.%d", st.size, st.mtime);
	if (core.read(stamp) == mark && fs.stat(out)?.size > 0)
		return out;
	if (!core.ok(sprintf("gzip -dc %s > %s.tmp && mv %s.tmp %s", gz, out, out, out)))
		return null;
	fs.writefile(stamp, mark);
	return out;
}

function smartdns_conf(cfg, proxy_on) {
	let d = cfg.dns, yn = (v) => v ? "yes" : "no";
	let cn_list = unpack("cn"), ad_list = d.ads ? unpack("ad") : null;
	let tunnel_domains = path(cfg.classify.tunnel_domains);

	let doh = (group) => map(d.cn_upstream, (u) => {
		let p = split(u, " ");
		let host = p[1] ? sprintf(" -host-name %s -tls-host-verify %s", p[1], p[1]) : "";
		return sprintf("server-https %s%s%s", p[0], host, group);
	});

	let conf = [
		sprintf("bind 127.0.0.1:%d", d.port),
		sprintf("bind-tcp 127.0.0.1:%d", d.port),
		"server-name prism-dns",
		"response-mode " + d.response_mode,
		sprintf("cache-size %d", d.cache_size),
		sprintf("cache-file %s/cache.db", core.RUN),
		"cache-persist yes",
		"prefetch-domain " + yn(d.prefetch),
		"serve-expired " + yn(d.serve_expired),
		"serve-expired-reply-ttl 2",
		sprintf("serve-expired-ttl %d", d.serve_expired_ttl),
		"serve-expired-prefetch-time 86400",
		sprintf("rr-ttl-min %d", d.rr_ttl_min),
		"rr-ttl-max 3600",
		"rr-ttl-reply-max 60",
		"max-reply-ip-num 4",
		"dualstack-ip-selection no",
		// HTTPS records would hand clients ECH/alt-svc hints that bypass the A answer.
		"force-qtype-SOA " + (d.ipv4_only ? "28 65" : "65"),
		"dnsmasq-lease-file /tmp/dhcp.leases",
		"log-level notice",
		sprintf("log-file %s/smartdns.log", core.RUN),
		"log-size 64K",
		"log-num 2",
		"audit-enable no",
	];

	if (proxy_on || !cfg.tunnel.fail_open) {
		push(conf,
			"speed-check-mode none",
			sprintf("server 127.0.0.1:%d", cfg.tunnel.dns_port),
			sprintf("speed-check-mode %s -group cn", d.speed_check),
			...doh(" -group cn -exclude-default-group"),
			"nameserver /cn/cn",
			"nftset /cn/#4:inet#prism#domestic4_dns");
		if (cn_list)
			push(conf,
				sprintf("domain-set -name cn-list -type list -file %s", cn_list),
				"nameserver /domain-set:cn-list/cn",
				"nftset /domain-set:cn-list/#4:inet#prism#domestic4_dns");
		// After cn-list on purpose: these names never take the domestic group,
		// and their answers are pinned so nft tunnels them even inside domestic4.
		if (fs.stat(tunnel_domains)?.size > 0)
			push(conf,
				sprintf("domain-set -name tunnel-list -type list -file %s", tunnel_domains),
				"nameserver /domain-set:tunnel-list/-",
				"nftset /domain-set:tunnel-list/#4:inet#prism#tunnel4_dns");
	}
	else {
		push(conf, "speed-check-mode " + d.speed_check, ...doh(""));
	}

	if (ad_list)
		push(conf,
			sprintf("domain-set -name ad-list -type list -file %s", ad_list),
			"address /domain-set:ad-list/#");
	return join("\n", conf) + "\n";
}

// --- dnsmasq / resolver wiring (UCI) ----------------------------------------

function set_list(uci, config, section, option, want) {
	let have = uci.get(config, section, option);
	have = have == null ? [] : (type(have) == "array" ? have : [ have ]);
	if (join(" ", have) == join(" ", want))
		return false;
	if (length(want))
		uci.set(config, section, option, want);
	else
		uci.delete(config, section, option);
	return true;
}

function set_opts(uci, config, section, opts) {
	let changed = false;
	for (let k, v in opts) {
		if (uci.get(config, section, k) == "" + v)
			continue;
		uci.set(config, section, k, "" + v);
		changed = true;
	}
	return changed;
}

// Every netifd interface on the uplink side, from config so the answer does
// not change when a device comes or goes.
function uplink_ifaces(uci) {
	let out = [];
	uci.foreach("network", "interface", (s) => {
		if (s[".name"] != "lan" && s[".name"] != "loopback")
			push(out, s[".name"]);
	});
	return out;
}

function first_section(uci, config, stype) {
	let name = null;
	uci.foreach(config, stype, (s) => { name ??= s[".name"]; });
	return name;
}

// Point dnsmasq at `servers` and keep it off the uplink side.
function wire_dnsmasq(ctx, servers, managed) {
	let uci = cursor(), d = ctx.cfg.dns;
	let sec = first_section(uci, "dhcp", "dnsmasq");
	if (!sec)
		return;
	let changed = set_list(uci, "dhcp", sec, "server", servers);
	if (managed) {
		changed = set_opts(uci, "dhcp", sec, {
			noresolv: 1,
			filter_aaaa: d.ipv4_only,
			min_cache_ttl: d.rr_ttl_min,
			use_stale_cache: 3600,
			cachesize: d.dnsmasq_cache,
			nonegcache: 1,
			dnsforwardmax: d.forward_max,
			dns_redirect: 1,
			rebind_protection: 1,
			domainneeded: 1,
			localservice: 1,
			nonwildcard: 1,
			logdhcp: 1,
		}) || changed;
		changed = set_list(uci, "dhcp", sec, "interface", [ "lan" ]) || changed;
		changed = set_list(uci, "dhcp", sec, "notinterface", uplink_ifaces(uci)) || changed;
		if (d.ipv4_only && uci.get("dhcp", "lan"))
			changed = set_opts(uci, "dhcp", "lan", { dhcpv6: "disabled", ra: "disabled", ra_slaac: 0 }) || changed;
	}
	if (!changed)
		return;
	if (core.is_dry()) {
		warn("would rewire dnsmasq -> ", join(" ", servers), "\n");
		return;
	}
	uci.commit("dhcp");
	core.act("/etc/init.d/dnsmasq reload");
	core.event("DNS dnsmasq -> %s", join(" ", servers));
}

// The router itself resolves through the same chain as the LAN.
function wire_resolver(ctx) {
	let uci = cursor(), changed = false;
	for (let iface in uplink_ifaces(uci)) {
		if (uci.get("network", iface, "proto") != "dhcp")
			continue;
		changed = set_opts(uci, "network", iface, { peerdns: 0 }) || changed;
		changed = set_list(uci, "network", iface, "dns", [ "127.0.0.1" ]) || changed;
	}
	if (changed && !core.is_dry()) {
		uci.commit("network");
		core.event("DNS router resolver -> 127.0.0.1");
	}
}

// --- entry points ----------------------------------------------------------

export function conf_path() {
	return core.RUN + "/smartdns.conf";
};

// Boot: give SmartDNS something to start with before the first pass.
export function bootstrap(cfg) {
	if (!fs.stat(conf_path()))
		core.write_atomic(conf_path(), smartdns_conf(cfg, false));
};

export function responsive(port) {
	return core.ok(sprintf("nslookup -port=%d -timeout=2 -retry=1 prism-dns 127.0.0.1", port ?? 6053));
};

export function apply(ctx) {
	delete ctx.dns_responsive;
	let text = smartdns_conf(ctx.cfg, ctx.tunnel.on);
	let file = core.outpath("smartdns.conf");
	if (core.write_if_changed(file, text)) {
		ctx.want_service_sync = true;
		core.event("DNS smartdns conf changed (tunnel %s)", ctx.tunnel.on ? "on" : "off");
	}
	if (!core.pidof("smartdns")) {
		ctx.st.dns_fails = 0;
		ctx.want_service_sync = true;
	}
	else if (!core.is_dry()) {
		if (responsive(ctx.cfg.dns.port)) {
			ctx.st.dns_fails = 0;
			if (!ctx.want_service_sync)
				ctx.dns_responsive = true;
		}
		else if ((ctx.st.dns_fails = (ctx.st.dns_fails ?? 0) + 1) >= 2) {
			ctx.st.dns_fails = 0;
			core.act("killall -9 smartdns 2>/dev/null || true");
			ctx.want_service_sync = true;
			core.event("DNS smartdns deadlock recovered");
		}
	}
	wire_dnsmasq(ctx, [ sprintf("127.0.0.1#%d", ctx.cfg.dns.port) ], true);
	wire_resolver(ctx);
};

// Service stop: hand dnsmasq the DHCP-provided resolvers so the LAN keeps
// resolving on a plain router.
export function teardown(ctx) {
	// Preserve the local resolver chain when privacy takes precedence. A
	// stopped SmartDNS must cause DNS failure, not forwarding to the uplink.
	if (!ctx.cfg.tunnel.fail_open) {
		wire_dnsmasq(ctx, [ sprintf("127.0.0.1#%d", ctx.cfg.dns.port) ], true);
		return;
	}
	let upstream = [];
	for (let n in values(ctx.facts.netifd))
		for (let s in n.upstream_dns ?? [])
			if (!(s in upstream))
				push(upstream, s);
	if (!length(upstream))
		upstream = [ "223.5.5.5", "119.29.29.29" ];
	wire_dnsmasq(ctx, upstream, false);
};

export function running() {
	return core.pidof("smartdns");
};
