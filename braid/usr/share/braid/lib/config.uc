// /etc/config/braid is the only place tunables live. SCHEMA is the complete
// list of options with their defaults; the type of a default decides how the
// UCI string is coerced. TUNABLE is the subset the web UI may change, with
// the bounds it is validated against.

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
	strands: {
		aggregate: "auto",              // auto | on | off. auto follows the site
		uplink: [ "wan" ],              // always a strand
		identity: [],                   // extra identities, up only while aggregating
		backup: [],                     // carry traffic only when no primary strand is healthy
		// Must be an empty-body endpoint: a captive portal answers any plain
		// HTTP request with its own 200 page, so 200 cannot prove a login.
		probe_url: "http://connect.rom.miui.com/generate_204",
		probe_expect: 204,
		probe_timeout: 3,
		probe_interval: 180,
		fail_keep: 2,
		auth_batch: 4,
		park_fails: 8,
		park_sec: 1800,
	},
	weave: {
		policy: "harvest",              // harvest | headroom | even
		affinity: "flow",               // auto | flow | dest
		spill: 6,                       // auto: connections a pair may open in a burst before spreading
		slots: 0,                       // pattern length, 0 = 6 per healthy strand
		interval: 2,                    // seconds between load samples
		smoothing: 0.3,                 // EWMA weight of the newest sample
		strand_kbit: 0,                 // per-strand ceiling, 0 = learn from peaks
	},
	classify: {
		remainder: "tunnel",            // tunnel | direct
		domestic4: "lists/domestic4.list",
		tunnel4: "lists/tunnel4.list",
		tunnel_domains: "lists/tunnel-domains.list",
		tunnel_udp_port: [],
		quic: "reject",                 // tunnel | reject
	},
	tunnel: {
		enabled: 1,
		relays: "relays.json",
		listen_addr: "198.51.100.1",
		tproxy_port: 61235,
		mixed_port: 7890,
		controller_port: 9090,
		dns_port: 5553,
		dashboard: "zashboard",
		test_url: "https://www.gstatic.com/generate_204",
		test_interval: 600,
		tolerance: 80,
		canary_url: "https://cp.cloudflare.com/generate_204",
		canary_interval: 180,
		canary_timeout: 5000,
		canary_fails: 3,
		canary_grace: 90,
		// 1: a dead tunnel takes its nft rules out, traffic goes direct.
		// 0: rules stay, tunnelled destinations fail until it is back.
		fail_open: 0,
		// SSH maintenance destinations allowed even with the whole service stopped.
		guard_ssh4: [],
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
	shaper: {
		mode: "auto",                   // auto | off
		device: "wan",
		pct: 95,                        // upload: percent of a 10/100 link speed
		pct_down: 72,                   // download, shaped on the LAN side. 0 = off
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

export const TUNABLE = {
	"strands.aggregate": { choices: [ "auto", "on", "off" ], locked: false },
	"strands.probe_interval": { min: 30, max: 3600, locked: false },
	"weave.policy": { choices: [ "harvest" ], locked: true },
	"weave.affinity": { choices: [ "flow" ], locked: true },
	"weave.slots": { min: 0, max: 252, locked: false },
	"weave.strand_kbit": { min: 0, max: 1000000, locked: false },
	"classify.remainder": { choices: [ "tunnel" ], locked: true },
	"classify.quic": { choices: [ "reject" ], locked: true },
	"tunnel.enabled": { min: 1, max: 1, locked: true },
	"tunnel.fail_open": { min: 0, max: 0, locked: true },
	"dns.ads": { min: 0, max: 1, locked: false },
	"main.mss": { min: 0, max: 1460, locked: false },
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
	let all = cursor(core.UCI_DIR).get_all("braid") ?? {};
	let cfg = {};
	for (let section, defaults in SCHEMA) {
		cfg[section] = {};
		for (let key, fallback in defaults)
			cfg[section][key] = coerce(all[section]?.[key], fallback);
	}
	// Repeatable sections: the networks we recognise and the devices we know.
	cfg.sites = [];
	cfg.devices = [];
	for (let name, s in all) {
		if (s[".type"] == "site")
			push(cfg.sites, {
				id: name,
				name: s.name ?? name,
				gateway: map(coerce(s.gateway, []), lc),
				aggregate: int(s.aggregate ?? 0),
				portal: s.portal ?? "",
				portal_secret: s.portal_secret ?? "portal.secret",
			});
		else if (s[".type"] == "device" && s.mac)
			push(cfg.devices, { id: name, mac: lc(s.mac), name: s.name ?? "", policy: s.policy ?? "auto" });
	}
	return cfg;
};

// Paths in the config are relative to /etc/braid unless absolute.
export function path(p) {
	return substr(p, 0, 1) == "/" ? p : core.ETC + "/" + p;
};

// Validate and store UI changes: { "weave.policy": "even", ... }.
// Returns { ok, error }. Nothing is written unless every key is valid.
export function store(changes) {
	let uci = cursor(core.UCI_DIR), todo = [];
	for (let key, value in changes) {
		let rule = TUNABLE[key], part = split(key, ".");
		if (!rule)
			return { ok: false, error: "not tunable: " + key };
		if (rule.choices) {
			if (!(value in rule.choices))
				return { ok: false, error: sprintf("%s must be one of %s", key, join(", ", rule.choices)) };
		}
		else {
			value = int(value);
			if (!(value >= rule.min && value <= rule.max))
				return { ok: false, error: sprintf("%s must be %d..%d", key, rule.min, rule.max) };
		}
		push(todo, [ part[0], part[1], "" + value ]);
	}
	for (let t in todo) {
		if (uci.get("braid", t[0]) == null)
			uci.set("braid", t[0], t[0]);
		uci.set("braid", t[0], t[1], t[2]);
	}
	uci.commit("braid");
	return { ok: true };
};

// A display name: no quotes, backslashes or control characters, 48 at most.
function clean(s) {
	return substr(replace(s ?? "", /[[:cntrl:]'"\\]/g, ""), 0, 48);
}

function find(uci, stype, test) {
	let hit = null;
	uci.foreach("braid", stype, (s) => {
		if (!hit && test(s))
			hit = s[".name"];
	});
	return hit;
}

// Name a device and/or set its policy. A device back at the defaults is
// forgotten rather than stored.
export function device_store(mac, name, policy) {
	if (!match(mac, /^[0-9a-f]{2}(:[0-9a-f]{2}){5}$/))
		return { ok: false, error: "bad mac" };
	if (!(policy in [ "auto", "direct", "tunnel", "block", "game" ]))
		return { ok: false, error: "bad policy" };
	name = clean(name);
	let uci = cursor(core.UCI_DIR);
	let id = find(uci, "device", (s) => lc(s.mac ?? "") == mac);
	if (policy == "auto" && !length(name)) {
		if (id)
			uci.delete("braid", id);
	}
	else {
		id ??= uci.add("braid", "device");
		uci.set("braid", id, "mac", mac);
		uci.set("braid", id, "name", name);
		uci.set("braid", id, "policy", policy);
	}
	uci.commit("braid");
	return { ok: true };
};

// Remember the network behind this gateway and what to do on it.
export function site_store(gateway, name, aggregate, portal) {
	if (!match(gateway ?? "", /^[0-9a-f]{2}(:[0-9a-f]{2}){5}$/))
		return { ok: false, error: "gateway unknown" };
	let uci = cursor(core.UCI_DIR);
	let has = (s) => gateway in map(type(s.gateway) == "array" ? s.gateway : [ s.gateway ?? "" ], lc);
	let id = find(uci, "site", has) ?? uci.add("braid", "site");
	uci.set("braid", id, "name", clean(name) || "site");
	uci.set("braid", id, "gateway", [ gateway ]);
	uci.set("braid", id, "aggregate", aggregate ? "1" : "0");
	if (portal != null)
		uci.set("braid", id, "portal", portal);
	uci.commit("braid");
	return { ok: true };
};

export function site_forget(gateway) {
	let uci = cursor(core.UCI_DIR);
	let id = find(uci, "site", (s) => gateway in map(type(s.gateway) == "array" ? s.gateway : [ s.gateway ?? "" ], lc));
	if (!id)
		return { ok: false, error: "not a known site" };
	uci.delete("braid", id);
	uci.commit("braid");
	return { ok: true };
};
