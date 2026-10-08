// /etc/config/hotel is the only place tunables live. The schema below is the
// full list of options with their defaults; the type of a default decides how
// the UCI string is coerced.

import { cursor } from "uci";
import * as core from "./core.uc";

const SCHEMA = {
	main: {
		enabled: 1,
		lan_dev: [ "br-lan" ],
		mss: 1440,
		ipv6: 0,
		tick: 60,
		boot_grace: 180,
	},
	uplink: {
		mode: "multi",                  // multi | plain
		device: [ "wan" ],              // glob patterns, in identity order
		backup: [],                     // used only when no primary leg is healthy
		slots: 42,
		scheduler: "idle",              // idle | even
		ewma: 0.3,
		reweigh: 120,
		probe_url: "http://www.baidu.com",
		probe_expect: 200,
		probe_timeout: 3,
		probe_interval: 180,
		fail_keep: 2,
		portal: "",                     // portal plugin name, empty for none
		portal_secret: "/etc/hotel-portal.code",
		auth_batch: 4,
		park_fails: 8,
		park_sec: 1800,
	},
	split: {
		remainder: "proxy",             // proxy | direct
		direct4: "lists/direct4.list",
		proxy4: "lists/proxy4.list",
		proxy_domains: "lists/proxy-domains.list",
		proxy_udp_port: [],
		quic: "proxy",                  // proxy | reject
	},
	proxy: {
		enabled: 1,
		nodes: "proxy-nodes.json",
		tproxy_addr: "198.51.100.1",
		tproxy_port: 61235,
		mixed_port: 7890,
		api_port: 9090,
		dns_port: 5553,
		ui: "zashboard",
		test_url: "https://www.gstatic.com/generate_204",
		test_interval: 600,
		tolerance: 80,
		canary_url: "https://cp.cloudflare.com/generate_204",
		canary_interval: 180,
		canary_timeout: 5000,
		canary_fails: 3,
		canary_grace: 90,
		// 1: a dead proxy takes its nft rules out, traffic goes direct.
		// 0: rules stay, proxied destinations fail until the proxy is back.
		fail_open: 1,
	},
	dns: {
		port: 6053,
		ipv4_only: 1,
		cn_upstream: [ "https://223.5.5.5/dns-query dns.alidns.com" ],
		ads: 1,
		cache_size: 32768,
		rr_ttl_min: 300,
		prefetch: 1,
		serve_expired: 1,
		serve_expired_ttl: 259200,
		speed_check: "tcp-syn:443,tcp-syn:80",
		response_mode: "fastest-ip",
		forward_max: 400,
		dnsmasq_cache: 0,
	},
	sqm: {
		mode: "auto",                   // auto | off
		device: "wan",
		pct: 95,
	},
	wifi: {
		guard: 1,
		ap: [],
		backup_sta: "",                 // wireless section enabled only without copper
	},
	led: {
		status: "",
		network: "",
		green: 18,
		yellow: 8,
	},
};

function coerce(value, fallback) {
	if (type(fallback) == "array")
		return value == null ? fallback : (type(value) == "array" ? value : [ value ]);
	if (value == null)
		return fallback;
	if (type(fallback) == "int")
		return int(value);
	if (type(fallback) == "double")
		return +value;
	return "" + value;
}

export function load() {
	let all = cursor(core.UCI_DIR).get_all("hotel") ?? {};
	let cfg = {};
	for (let section, defaults in SCHEMA) {
		cfg[section] = {};
		for (let key, fallback in defaults)
			cfg[section][key] = coerce(all[section]?.[key], fallback);
	}
	return cfg;
};

// Paths in the config are relative to /etc/hotel unless absolute.
export function path(p) {
	return substr(p, 0, 1) == "/" ? p : core.ETC + "/" + p;
};
