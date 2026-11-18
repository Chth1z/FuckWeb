// Device identity, MAC+IP anti-spoof pairing, and multi-signal cross-auth.
//
// Logical device profiles live in /etc/prism/state/profiles.json so Zashboard
// selector groups stay stable ("Alias [anchor_mac]" on a dedicated local TProxy
// port) across DHCP renewals and randomized-MAC rotations. Any unverified or
// ambiguous MAC is quarantined in Mode A (internet blocked, router admin kept
// reachable) until cross-auth reaches high confidence or the operator claims it.

import * as fs from "fs";
import * as ubus from "ubus";
import * as rtnl from "rtnl";
import { cursor } from "uci";
import * as core from "../lib/core.uc";
import * as config from "../lib/config.uc";
import * as facts from "../lib/facts.uc";

export const PROFILES_FILE = core.STATE_DIR + "/profiles.json";
export const RELAYS_FILE = core.STATE_DIR + "/device_relays.json";
export const LEGACY_SELECTED_FILE = core.STATE_DIR + "/selected.json";
export const DHCP_OBS_DIR = core.RUN + "/dhcp_obs";
export const LAN_NAMES_FILE = core.RUN + "/lan_names.json";
export const RT_FILE = core.RUN + "/identities.json";

const BASE_TPROXY_PORT = 61236;
const MAX_MACS = 4;
const SCORE_THRESHOLD = 80;
const MARGIN_THRESHOLD = 25;
const LAN_PROBE_BIN = core.SHARE + "/bin/lan_probe.lua";

const GENERIC_NAMES = [
	"", "*", "localhost", "android", "iphone", "ipad", "ipod", "macbook",
	"galaxy", "redmi", "xiaomi", "huawei", "honor", "oppo", "vivo", "oneplus",
	"realme", "pc", "desktop", "laptop", "unknown", "linux",
];

// --- formatting & validation -----------------------------------------------

export function is_mac(s) {
	return !!match(lc(s ?? ""), /^[0-9a-f]{2}(:[0-9a-f]{2}){5}$/);
};

export function is_ip4(s) {
	return length(iptoarr(s ?? "")) == 4;
};

// Strip brackets, commas, quotes and control characters because Mihomo group
// rules use CSV (`IN-NAME,listener,Group Name`).
export function clean_alias(s) {
	let c = replace(s ?? "", /[[:cntrl:]'"\\,\[\]]/g, " ");
	c = trim(replace(c, / +/g, " "));
	return core.utf8_trunc(c, 32);
};

export function group_name(alias, anchor_mac) {
	let a = clean_alias(alias);
	let label = length(a) ? a : ("Dev-" + replace(substr(anchor_mac, 9), /:/g, ""));
	return sprintf("%s [%s]", label, anchor_mac);
};

function is_rand_mac(mac) {
	return (hex(substr(mac, 0, 2)) & 0x02) != 0;
}

function mac_slug(mac) {
	return replace(lc(mac ?? ""), /:/g, "");
}

function alloc_uid(alias, mac, used) {
	let raw = lc(replace(alias ?? "", /[^A-Za-z0-9]+/g, "_"));
	raw = replace(replace(raw, /^_+/, ""), /_+$/, "");
	let stem = replace(substr(length(raw) >= 2 ? raw : ("dev_" + substr(mac_slug(mac), 6)), 0, 14), /_+$/, "");
	let uid = stem;
	if (!used[uid])
		return uid;
	uid = replace(substr(stem, 0, 9), /_+$/, "") + "_" + substr(mac_slug(mac), 8, 4);
	let n = 1;
	while (used[uid]) {
		uid = replace(substr(stem, 0, 9), /_+$/, "") + "_" + n;
		n++;
	}
	return uid;
}

function alloc_port(store, cfg, used_ports) {
	let c = cfg?.tunnel ?? {};
	let avoid = {
		["" + (c.tproxy_port ?? 61235)]: true,
		["" + (c.mixed_port ?? 7890)]: true,
		["" + (c.controller_port ?? 9090)]: true,
		["" + (c.dns_port ?? 5553)]: true,
		["" + (cfg?.dns?.port ?? 6053)]: true,
		...used_ports,
	};
	let p = max(BASE_TPROXY_PORT, int(store.next_port ?? BASE_TPROXY_PORT));
	while (avoid["" + p] || p > 64000) {
		p++;
		if (p > 64000) {
			p = BASE_TPROXY_PORT;
			while (avoid["" + p] && p <= 64000) p++;
			break;
		}
	}
	assert(p <= 64000, "device listener port range exhausted");
	store.next_port = p + 1;
	return p;
}

function push_uniq(arr, val, limit) {
	if (!length(val ?? ""))
		return false;
	if (val in arr)
		return false;
	push(arr, val);
	if (limit && length(arr) > limit)
		splice(arr, 0, length(arr) - limit);
	return true;
}

// --- store persistence -----------------------------------------------------

export function load_store() {
	if (!fs.stat(PROFILES_FILE))
		return null;
	let s = json(fs.readfile(PROFILES_FILE));
	assert(type(s.profiles) == "array", "invalid profile store");
	return s;
};

export function save_store(store) {
	core.init_dirs();
	assert(core.write_atomic(PROFILES_FILE, sprintf("%.2J\n", store), 0o600), "cannot save " + PROFILES_FILE);
};

export function load_relays_state() {
	if (fs.stat(RELAYS_FILE)) {
		let r = json(fs.readfile(RELAYS_FILE));
		assert(type(r) == "object", "invalid relay selections");
		return r;
	}
	let leg = core.load_json(LEGACY_SELECTED_FILE, null);
	return type(leg?.name) == "string" && length(leg.name) ? { _tw_home: leg.name } : {};
};

export function save_relays_state(relays) {
	core.init_dirs();
	assert(core.write_atomic(RELAYS_FILE, sprintf("%.2J\n", relays), 0o600), "cannot save " + RELAYS_FILE);
};

export function with_identity_lock(fn) {
	return core.with_lock("identity", 3, () => fn());
};

export function profile_by_uid(store, uid) {
	for (let p in store?.profiles ?? [])
		if (p.uid == uid)
			return p;
	return null;
};

export function all_profile_macs(p) {
	let out = [];
	if (is_mac(p.anchor_mac))
		push(out, lc(p.anchor_mac));
	for (let m in p.macs ?? []) {
		let mac = lc(type(m) == "object" ? m.mac : m);
		if (is_mac(mac) && !(mac in out))
			push(out, mac);
	}
	return out;
};

export function mac_owner_map(store) {
	let owners = {};
	for (let p in store?.profiles ?? []) {
		for (let mac in all_profile_macs(p)) {
			assert(!owners[mac], "multiple profiles own " + mac);
			owners[mac] = p;
		}
	}
	return owners;
};

export function mac_anchor(mac) {
	let store = load_store();
	if (!store)
		return lc(mac ?? "");
	let p = mac_owner_map(store)[lc(mac ?? "")];
	return p ? p.anchor_mac : lc(mac ?? "");
};

// --- telemetry & fingerprinting --------------------------------------------

function extract_hw(sig) {
	if (!length(sig ?? ""))
		return { ies: [], core: "", rrm_hint: "" };
	let ies = [], cores = {};
	for (let part in split(sig, "|")) {
		for (let tok in split(part, ",")) {
			if (substr(tok, 0, 4) == "221(")
				push_uniq(ies, tok);
			else {
				for (let k in [ "htcap:", "vhtcap:", "vhtrxmcs:", "vhttxmcs:", "extcap:" ])
					if (substr(tok, 0, length(k)) == k && !cores[k])
						cores[k] = tok;
			}
		}
	}
	let core_list = [];
	for (let k in [ "htcap:", "vhtcap:", "vhtrxmcs:", "vhttxmcs:", "extcap:" ])
		if (cores[k])
			push(core_list, k == "extcap:" ? substr(cores[k], 0, 21) : cores[k]);
	for (let ie in sort(slice(ies)))
		push(core_list, ie);
	return { ies: sort(ies), core: join("|", core_list) };
}

function rrm_key(rrm) {
	if (type(rrm) != "array" || !length(rrm))
		return "";
	return join(",", map(rrm, (v) => "" + int(v)));
}

function infer_os(opt55, vendor, name) {
	let v = lc(vendor ?? ""), n = lc(name ?? ""), o = "," + (opt55 ?? "") + ",";
	if (index(v, "msft") >= 0 || index(o, ",249,") >= 0 || index(o, ",44,46,47,") >= 0 || match(n, /^(desktop|laptop|win)-/))
		return "windows";
	if (index(o, ",108,114,") >= 0 || match(n, /^(iphone|ipad|macbook|imac)/))
		return "apple";
	if (index(v, "android") >= 0 || index(o, ",1,3,6,15,26,28,51,58,59") >= 0)
		return "android";
	return "unknown";
}

function name_kind(raw) {
	let s = lc(clean_alias(raw));
	if (!length(s))
		return "none";
	if (s in GENERIC_NAMES)
		return "generic";
	for (let p in [ "android-", "android_", "iphone", "ipad", "galaxy-", "redmi-", "xiaomi-" ])
		if (index(s, p) == 0 && length(s) < 16)
			return "generic";
	if (match(s, /^(laptop|desktop)-[a-z0-9]+$/i) || match(s, /^(vivo|oneplus|oppo|honor|watch|realme)-/))
		return "model";
	return "specific";
}

function read_leases() {
	let out = {};
	for (let line in split(fs.readfile("/tmp/dhcp.leases") ?? "", "\n")) {
		let f = split(trim(line), " ");
		if (length(f) >= 4 && is_mac(f[1]) && (int(f[0]) == 0 || int(f[0]) > time()))
			out[lc(f[1])] = { ts: int(f[0]), ip: f[2], host: f[3] == "*" ? "" : clean_alias(f[3]) };
	}
	return out;
}

function read_dhcp_obs() {
	let out = {};
	for (let fn in (fs.lsdir(DHCP_OBS_DIR) ?? [])) {
		if (!match(fn, /\.json$/))
			continue;
		let rec = core.load_json(DHCP_OBS_DIR + "/" + fn, null);
		if (rec && is_mac(rec.mac))
			out[lc(rec.mac)] = rec;
	}
	return out;
}

function read_radios(aps) {
	let out = {}, bus = ubus.connect();
	for (let ap in aps ?? []) {
		let r = bus?.call("hostapd." + ap, "get_clients");
		let band = (r?.freq ?? 0) >= 5000 ? "5G" : "2.4G";
		for (let mac, c in r?.clients ?? {}) {
			let m = lc(mac);
			out[m] = {
				ap, band,
				signal: c.signal ?? 0,
				sig: c.signature ?? "",
				rrm: rrm_key(c.rrm),
				rx: c.rate?.rx ?? 0,
				tx: c.rate?.tx ?? 0,
				hw: extract_hw(c.signature ?? ""),
			};
		}
	}
	bus?.disconnect();
	return out;
}

function read_fdb(lan_devs) {
	let entries = rtnl.request(rtnl.const.RTM_GETNEIGH, rtnl.const.NLM_F_DUMP, { family: rtnl.const.AF_BRIDGE });
	let error = rtnl.error();
	assert(!error, error);
	let out = {};
	for (let n in entries ?? []) {
		if (!(n.master in lan_devs) || !n.lladdr || !n.cacheinfo || (n.state & rtnl.const.NUD_PERMANENT))
			continue;
		let mac = lc(n.lladdr), age = n.cacheinfo.updated / 100.0;
		if (!out[mac] || age < out[mac].ageing)
			out[mac] = { dev: n.dev, ageing: age };
	}
	return out;
}

function read_neigh(lan_devs) {
	let by_mac = {}, by_ip = {};
	for (let n in facts.neighbours()) {
		if (!(n.dev in lan_devs))
			continue;
		let mac = lc(n.lladdr), rec = { ip: n.dst, mac, active: facts.active_neighbour(n), lan: n.dev };
		push(by_mac[mac] ??= [], rec);
		if (!by_ip[n.dst] || rec.active)
			by_ip[n.dst] = rec;
	}
	return { by_mac, by_ip };
}

export function gather_telemetry(cfg) {
	let leases = read_leases();
	let dhcp_obs = read_dhcp_obs();
	let radio = read_radios(cfg.wifi?.ap ?? []);
	let fdb = read_fdb(cfg.main?.lan_dev ?? []);
	let neigh = read_neigh(cfg.main?.lan_dev ?? [ "br-lan" ]);
	let lan_names = core.load_json(LAN_NAMES_FILE, {});
	return { leases, dhcp_obs, radio, fdb, neigh, lan_names };
};

function observe_mac(mac, tel) {
	let l = tel.leases[mac], d = tel.dhcp_obs[mac], r = tel.radio[mac], f = tel.fdb[mac];
	let ns = tel.neigh.by_mac[mac] ?? [];
	let ip = l?.ip ?? filter(ns, (n) => n.active)[0]?.ip ?? ns[0]?.ip ?? "";
	let ln_ent = ip ? tel.lan_names[ip] : null;
	let ln = (ln_ent && (!length(ln_ent.mac ?? "") || ln_ent.mac == mac)) ? (ln_ent.name ?? "") : "";
	let name = clean_alias(d?.host || l?.host || ln || "");
	let media = r ? r.band : (f?.dev && match(f.dev, /^phy/) ? (f.dev == "phy1-ap0" ? "5G" : "2.4G") : (f?.dev ? "wired" : "unknown"));
	let active_neigh = length(filter(ns, (x) => x.active)) > 0;
	let fdb_fresh = f && f.ageing < 20.0;
	return {
		mac, ip,
		host: d?.host || l?.host || "",
		lan_name: ln,
		name,
		name_kind: name_kind(name),
		opt55: d?.opt55 ?? "",
		vendor: d?.vendor ?? "",
		os: infer_os(d?.opt55, d?.vendor, name),
		band: r?.band ?? (media == "5G" || media == "2.4G" ? media : "unknown"),
		media,
		port: f?.dev ?? r?.ap ?? "",
		signal: r?.signal ?? 0,
		sig: r?.sig ?? "",
		hw_core: r?.hw?.core ?? "",
		rrm: r?.rrm ?? "",
		rand: is_rand_mac(mac),
		online: !!r || active_neigh || !!fdb_fresh,
	};
}

function absorb_mac_fp(p, obs, now) {
	let dirty = false;
	let fp = (p.fp ??= {});
	fp.sigs ??= {};
	fp.ie_cores ??= [];
	fp.rrm ??= [];
	fp.dhcp55 ??= [];
	fp.dhcp60 ??= [];
	fp.names ??= [];
	fp.media ??= [];
	fp.os ??= "unknown";

	let found = false;
	for (let entry in (p.macs ??= [])) {
		if (type(entry) == "object" && entry.mac == obs.mac) {
			entry.seen = now;
			found = true;
			break;
		}
	}
	if (!found) {
		push(p.macs, { mac: obs.mac, seen: now, src: obs.src ?? "seen" });
		dirty = true;
	}
	if (length(obs.sig) && obs.band != "unknown" && fp.sigs[obs.band] != obs.sig) {
		fp.sigs[obs.band] = obs.sig;
		dirty = true;
	}
	if (length(obs.hw_core) && push_uniq(fp.ie_cores, obs.hw_core, 4))
		dirty = true;
	if (length(obs.rrm) && push_uniq(fp.rrm, obs.rrm, 4))
		dirty = true;
	if (length(obs.opt55) && push_uniq(fp.dhcp55, obs.opt55, 4))
		dirty = true;
	if (length(obs.vendor) && push_uniq(fp.dhcp60, obs.vendor, 4))
		dirty = true;
	if (length(obs.name) && obs.name_kind != "generic" && push_uniq(fp.names, lc(obs.name), 6))
		dirty = true;
	if (obs.media != "unknown" && push_uniq(fp.media, obs.media, 4))
		dirty = true;
	if (obs.os != "unknown" && fp.os == "unknown") {
		fp.os = obs.os;
		dirty = true;
	}
	if (is_ip4(obs.ip) && fp.last_ip != obs.ip) {
		fp.last_ip = obs.ip;
		dirty = true;
	}
	if (length(p.macs) > MAX_MACS) {
		// Evict oldest non-anchor secondary MAC while always keeping anchor_mac.
		let idx = -1, oldest = now + 1;
		for (let i = 0; i < length(p.macs); i++) {
			let m = p.macs[i];
			if (m.mac != p.anchor_mac && (m.seen ?? 0) < oldest) {
				oldest = m.seen ?? 0;
				idx = i;
			}
		}
		if (idx >= 0) {
			splice(p.macs, idx, 1);
			dirty = true;
		}
	}
	return dirty;
}

// --- bootstrap & migration -------------------------------------------------

function make_profile(store, cfg, used_uids, used_ports, mac, alias, policy, tel, now, src) {
	let obs = observe_mac(mac, tel);
	let effective_alias = clean_alias(alias || obs.name || "");
	let uid = alloc_uid(effective_alias, mac, used_uids);
	used_uids[uid] = true;
	let port = alloc_port(store, cfg, used_ports);
	used_ports["" + port] = true;
	let p = {
		uid,
		anchor_mac: mac,
		alias: effective_alias,
		group_name: group_name(effective_alias, mac),
		port,
		policy: policy || "auto",
		macs: [ { mac, seen: now, src: src ?? "enrolled" } ],
		fp: {},
	};
	absorb_mac_fp(p, { ...obs, src: src ?? "enrolled" }, now);
	return p;
}

function bootstrap(cfg, tel, now) {
	let store = { version: 1, next_port: BASE_TPROXY_PORT, profiles: [] };
	let used_uids = {}, used_ports = {}, seeded = {};
	let relays = load_relays_state();

	let add_seed = (mac, alias, policy, src) => {
		mac = lc(mac ?? "");
		if (!is_mac(mac) || seeded[mac])
			return;
		seeded[mac] = true;
		let p = make_profile(store, cfg, used_uids, used_ports, mac, alias, policy, tel, now, src);
		push(store.profiles, p);
		relays[p.uid] ??= "TW-HOME";
	};

	// Migrate saved UCI device rows + currently active LAN hosts so Mode A never
	// locks out existing connected devices on first deploy.
	for (let d in cfg.devices ?? [])
		add_seed(d.mac, d.name, d.policy ?? "auto", "uci");
	for (let mac in sort(keys(tel.radio)))
		add_seed(mac, "", "auto", "online_seed");
	for (let mac in sort(keys(tel.leases)))
		if (observe_mac(mac, tel).online)
			add_seed(mac, "", "auto", "lease_seed");
	for (let mac in sort(keys(tel.neigh.by_mac)))
		if (observe_mac(mac, tel).online)
			add_seed(mac, "", "auto", "neigh_seed");
	for (let mac in sort(keys(tel.fdb)))
		if (tel.fdb[mac].ageing < 20 && !(int("0x" + substr(mac, 0, 2)) & 1))
			add_seed(mac, "", "auto", "fdb_seed");

	if (!core.is_dry()) {
		save_store(store);
		save_relays_state(relays);
		core.event("IDENTITY bootstrapped %d device profiles (Mode A armed)", length(store.profiles));
	}
	return store;
}

// --- cross-authentication scoring engine -----------------------------------

export function score_candidate(obs, p, p_is_online, ip_held_elsewhere, sig_owners, hw_owners) {
	let fp = p.fp ?? {};
	let p_media = fp.media ?? [];
	// Hard Veto 1: any bound MAC of candidate profile is simultaneously active.
	if (p_is_online)
		return { score: -1, veto: "profile_online", reasons: [] };
	// Hard Veto 2: incompatible OS family from DHCP Option 55/60.
	if (obs.os != "unknown" && (fp.os ?? "unknown") != "unknown" && obs.os != fp.os)
		return { score: -1, veto: "os_mismatch", reasons: [] };
	// Hard Veto 3: randomized Wi-Fi MAC vs wired-only profile with no DHCP/name link.
	if (obs.rand && length(p_media) && !("2.4G" in p_media) && !("5G" in p_media))
		return { score: -1, veto: "media_mismatch", reasons: [] };

	let score = 0, reasons = [];

	// S1: 802.11 hardware IE signature (with anti-collision down-weighting).
	if (length(obs.sig) && obs.band != "unknown" && fp.sigs?.[obs.band] == obs.sig) {
		let shared = (sig_owners[obs.band + ":" + obs.sig] ?? 1) >= 2;
		let pts = shared ? 20 : 50;
		score += pts;
		push(reasons, sprintf("sig_%s(%s:+%d)", obs.band, shared ? "shared" : "uniq", pts));
	}
	else if (length(obs.hw_core) && (obs.hw_core in (fp.ie_cores ?? []))) {
		let shared = (hw_owners[obs.hw_core] ?? 1) >= 2;
		let pts = shared ? 15 : 35;
		score += pts;
		push(reasons, sprintf("hw_ie(%s:+%d)", shared ? "shared" : "uniq", pts));
	}

	// S2: DHCP Option 55 + Vendor Class (Option 60).
	if (length(obs.opt55) && (obs.opt55 in (fp.dhcp55 ?? []))) {
		let has_v = length(obs.vendor) && (obs.vendor in (fp.dhcp60 ?? []));
		let pts = has_v ? 20 : 12;
		score += pts;
		push(reasons, sprintf("dhcp(+%d)", pts));
	}

	// S3: Hostname (DHCP Option 12 or LAN mDNS/NetBIOS name).
	if (length(obs.name) && (lc(obs.name) in (fp.names ?? []))) {
		let pts = obs.name_kind == "specific" ? 25 : (obs.name_kind == "model" ? 14 : 5);
		score += pts;
		push(reasons, sprintf("name(%s:+%d)", obs.name_kind, pts));
	}

	// S4: IP continuity (strictly gated: old MAC offline + IP not held elsewhere).
	if (is_ip4(obs.ip) && obs.ip == fp.last_ip && !ip_held_elsewhere) {
		score += 10;
		push(reasons, "ip_cont(+10)");
	}

	// S5: Physical interface / RRM match.
	if ((length(obs.rrm) && (obs.rrm in (fp.rrm ?? []))) || (obs.media != "unknown" && (obs.media in p_media))) {
		score += 5;
		push(reasons, "phy(+5)");
	}

	return { score, veto: null, reasons };
};

export function build_signature_index(profiles) {
	let sig_owners = {}, hw_owners = {};
	for (let p in profiles) {
		let seen_s = {}, seen_h = {};
		for (let band, sig in (p.fp?.sigs ?? {})) {
			let key = band + ":" + sig;
			if (!seen_s[key]) {
				seen_s[key] = true;
				sig_owners[key] = (sig_owners[key] ?? 0) + 1;
			}
		}
		for (let h in (p.fp?.ie_cores ?? [])) {
			if (!seen_h[h]) {
				seen_h[h] = true;
				hw_owners[h] = (hw_owners[h] ?? 0) + 1;
			}
		}
	}
	return { sig_owners, hw_owners };
};

function profile_online_map(store, tel) {
	let out = {};
	for (let p in store.profiles) {
		let up = false;
		for (let m in all_profile_macs(p)) {
			let ns = tel.neigh.by_mac[m] ?? [];
			let active_n = length(filter(ns, (x) => x.active)) > 0;
			let fdb_up = tel.fdb[m] && tel.fdb[m].ageing < 15.0;
			if (tel.radio[m] || active_n || fdb_up) {
				up = true;
				break;
			}
		}
		out[p.uid] = up;
	}
	return out;
}

// Compute exclusive (mac . ip) pairs allowed into kernel @verified_pairs.
export function compute_verified_pairs(store, tel) {
	let owners = mac_owner_map(store);
	let by_ip = {};
	// The active lease owns the IP, including when the lessee is quarantined.
	for (let mac, lease in tel.leases)
		by_ip[lease.ip] = mac;
	for (let ip, n in tel.neigh.by_ip) {
		if (by_ip[ip] || (!n.active && !tel.radio[n.mac] && !(tel.fdb[n.mac] && tel.fdb[n.mac].ageing < 20)))
			continue;
		by_ip[ip] = n.mac;
	}
	let pairs = [];
	for (let ip in sort(keys(by_ip))) {
		let mac = by_ip[ip], owner = owners[mac];
		if (owner && owner.policy != "block" && is_ip4(ip))
			push(pairs, mac + " . " + ip);
	}
	return pairs;
};

// Trigger a quick background LAN hostname probe (NBSTAT/mDNS) for unlabeled online IPs.
function maybe_probe_lan_names(candidates, tel, now) {
	if (!length(candidates) || core.is_dry() || !fs.stat(LAN_PROBE_BIN))
		return;
	for (let obs in candidates) {
		if (!obs.online || !is_ip4(obs.ip) || obs.name_kind == "specific")
			continue;
		let cached = tel.lan_names[obs.ip];
		if (cached && cached.mac == obs.mac && now - (cached.ts ?? 0) < 300)
			continue;
		system(sprintf("/usr/bin/lua %s %s %s >/dev/null 2>&1 &",
			core.shq(LAN_PROBE_BIN), core.shq(obs.ip), core.shq(obs.mac)));
		break; // at most one async probe per pass
	}
}

function refresh_missing_neighbours(store, tel, cfg) {
	let cmds = [];
	for (let p in store.profiles) {
		let ip = p.fp?.last_ip;
		if (p.policy == "block" || !is_ip4(ip) || tel.neigh.by_ip[ip])
			continue;
		let linked = false, leased = false;
		for (let mac in all_profile_macs(p)) {
			linked ||= !!tel.radio[mac] || !!(tel.fdb[mac] && tel.fdb[mac].ageing < 20);
			leased ||= !!tel.leases[mac];
		}
		if (!linked || leased)
			continue;
		let c = rtnl.const, route = rtnl.request(c.RTM_GETROUTE, 0, { family: c.AF_INET, dst: ip });
		if (route && !route.gateway && (route.oif in cfg.main.lan_dev))
			push(cmds, sprintf("ping -c 1 -W 1 -I %s %s >/dev/null 2>&1 &", core.shq(route.oif), ip));
	}
	if (length(cmds)) {
		push(cmds, "wait");
		core.sh(join("\n", cmds));
		tel.neigh = read_neigh(cfg.main.lan_dev);
	}
}

// Evaluate cross-auth, Mode A quarantine, and verified (MAC, IP) pairs for reconcile.
export function reconcile(ctx) {
	return core.with_lock("identity", 5, () => {
		let cfg = ctx.cfg, now = ctx.now;
		let tel = gather_telemetry(cfg);
		let store = load_store() ?? bootstrap(cfg, tel, now);
		if (!core.is_dry())
			refresh_missing_neighbours(store, tel, cfg);
		let dirty = false;

		// Sync policy & alias overrides from UCI device entries cleanly without erasing auto profiles.
		// Also auto-enroll any manual `config device` entries added directly to /etc/config/prism.
		let owners = mac_owner_map(store);
		let used_uids = {}, used_ports = {};
		for (let p in store.profiles) {
			used_uids[p.uid] = true;
			used_ports["" + p.port] = true;
		}
		for (let d in cfg.devices ?? []) {
			let p = owners[d.mac];
			if (!p) {
				p = make_profile(store, cfg, used_uids, used_ports, d.mac, d.name ?? "", d.policy ?? "auto", tel, now, "uci_sync");
				push(store.profiles, p);
				for (let m in all_profile_macs(p))
					owners[m] = p;
				dirty = true;
				continue;
			}
			if (p.policy != d.policy) {
				p.policy = d.policy;
				dirty = true;
			}
			if (length(d.name) && clean_alias(d.name) != p.alias) {
				p.alias = clean_alias(d.name);
				p.group_name = group_name(p.alias, p.anchor_mac);
				dirty = true;
			}
		}

	// Collect currently relevant MACs on the LAN.
	let seen_macs = {};
	for (let m in keys(tel.radio)) seen_macs[m] = true;
	for (let m in keys(tel.leases)) seen_macs[m] = true;
	for (let m in keys(tel.neigh.by_mac)) seen_macs[m] = true;
	for (let m in keys(tel.dhcp_obs))
		if (tel.dhcp_obs[m].action != "remove") seen_macs[m] = true;
	for (let m, f in tel.fdb)
		if (f.ageing < 120.0) seen_macs[m] = true;

	let online_prof = profile_online_map(store, tel);
	let sig_idx = build_signature_index(store.profiles);
	let sig_owners = sig_idx.sig_owners, hw_owners = sig_idx.hw_owners;
	let quarantine = [], unlabelled = [];

	// First refresh fingerprints for already-known online/observed MACs.
	for (let mac in sort(keys(seen_macs))) {
		let p = owners[mac];
		if (!p)
			continue;
		let obs = observe_mac(mac, tel);
		if (obs.online || length(obs.sig) || length(obs.opt55)) {
			if (absorb_mac_fp(p, obs, now))
				dirty = true;
		}
	}

	// Next cross-authenticate any unknown MAC against dormant/offline profiles.
	for (let mac in sort(keys(seen_macs))) {
		if (owners[mac])
			continue;
		let obs = observe_mac(mac, tel);
		if (!obs.online && !tel.leases[mac])
			continue;

		// Is the observed IP currently owned by an active different MAC?
		let cur_ip_holder = is_ip4(obs.ip) ? tel.neigh.by_ip[obs.ip] : null;
		let ip_held_elsewhere = !!(cur_ip_holder && cur_ip_holder.mac != mac && cur_ip_holder.active);

		let scored = [];
		for (let p in store.profiles) {
			let res = score_candidate(obs, p, !!online_prof[p.uid], ip_held_elsewhere, sig_owners, hw_owners);
			if (res.score >= 0)
				push(scored, { profile: p, score: res.score, reasons: res.reasons });
		}
		scored = sort(scored, (a, b) => b.score - a.score);
		let best = scored[0], second = scored[1];
		let margin = best ? (best.score - (second?.score ?? 0)) : 0;

		if (best && best.score >= SCORE_THRESHOLD && margin >= MARGIN_THRESHOLD) {
			if (absorb_mac_fp(best.profile, { ...obs, src: "cross_auth" }, now))
				dirty = true;
			owners[mac] = best.profile;
			online_prof[best.profile.uid] = true;
			core.event("IDENTITY matched %s -> %s (score=%d margin=%d via %s)",
				mac, best.profile.uid, best.score, margin, join("+", best.reasons));
		}
		else {
			push(unlabelled, obs);
			push(quarantine, {
				mac,
				ip: obs.ip,
				host: obs.name || obs.host || "",
				link: obs.band != "unknown" ? obs.band : obs.media,
				signal: obs.signal,
				online: obs.online,
				rand: obs.rand,
				os: obs.os,
				score: best?.score ?? 0,
				reason: !best ? "no_candidate" : (best.score < SCORE_THRESHOLD ? "low_score" : "ambiguous_tie"),
				candidates: map(slice(scored, 0, 2), (c) => ({
					uid: c.profile.uid,
					group_name: c.profile.group_name,
					alias: c.profile.alias || c.profile.anchor_mac,
					score: c.score,
					reasons: c.reasons,
				})),
			});
		}
	}

	maybe_probe_lan_names(unlabelled, tel, now);

	if (dirty && !core.is_dry())
		save_store(store);

	let pairs = compute_verified_pairs(store, tel);
	let sets = { direct: [], tunnel: [], block: [], game: [] };
	for (let p in store.profiles) {
		if (sets[p.policy]) {
			for (let m in all_profile_macs(p))
				push(sets[p.policy], m);
		}
	}
	for (let q in quarantine)
		push(sets.block, q.mac);

	let rt = { ts: now, profiles: store.profiles, quarantine, pairs, sets };
	if (!core.is_dry())
		core.save_json(RT_FILE, rt, 0o600);
	return rt;
	});
};

// DHCP notifications refresh fingerprints and schedule one policy transaction.
export function record_dhcp(ev) {
	let mac = lc(ev?.mac ?? ""), ip = ev?.ip ?? "", act = ev?.action ?? "";
	if (!is_mac(mac))
		die("invalid DHCP MAC");
	if (!(act in [ "add", "update", "remove" ]) || (act != "remove" && !is_ip4(ip)))
		die("invalid DHCP event");
	let now = time(), ev_ts = int(ev?.ts ?? 0) || now;
	core.init_dirs();
	fs.mkdir(DHCP_OBS_DIR);
	let obs_path = sprintf("%s/%s.json", DHCP_OBS_DIR, mac_slug(mac));
	let prev = core.load_json(obs_path, {});
	if ((prev.ts ?? 0) > ev_ts)
		return false;

	let rec = {
		action: act, mac, ip: length(ip) ? ip : (prev.ip ?? ""),
		host: length(clean_alias(ev?.host ?? "")) ? clean_alias(ev.host) : (prev.host ?? ""),
		opt55: length(ev?.opt55 ?? "") ? ev.opt55 : (prev.opt55 ?? ""),
		vendor: length(ev?.vendor ?? "") ? ev.vendor : (prev.vendor ?? ""),
		cid: length(ev?.cid ?? "") ? ev.cid : (prev.cid ?? ""),
		iface: length(ev?.iface ?? "") ? ev.iface : (prev.iface ?? "br-lan"),
		ts: ev_ts,
	};
	assert(core.write_atomic(obs_path, sprintf("%J\n", rec), 0o600), "cannot record DHCP event");

	// Invalidate IP-keyed LAN hostname cache whenever a different MAC leases `ip`.
	if (is_ip4(rec.ip) && (act == "add" || act == "update")) {
		let ln = core.load_json(LAN_NAMES_FILE, null);
		if (type(ln) == "object" && ln[rec.ip] && ln[rec.ip].mac != mac) {
			delete ln[rec.ip];
			core.write_atomic(LAN_NAMES_FILE, sprintf("%.1J\n", ln), 0o600);
		}
	}

	return true;
};

// --- operator claim / merge / forget / policy sync --------------------------

function sync_uci_device(mac, alias, policy) {
	let uci = cursor(core.UCI_DIR);
	let hit = null;
	uci.foreach("prism", "device", (s) => {
		if (!hit && lc(s.mac ?? "") == mac)
			hit = s[".name"];
	});
	if (policy == "auto" && !length(alias)) {
		if (hit)
			uci.delete("prism", hit);
	}
	else {
		hit ??= uci.add("prism", "device");
		uci.set("prism", hit, "mac", mac);
		uci.set("prism", hit, "name", clean_alias(alias));
		uci.set("prism", hit, "policy", policy);
	}
	uci.commit("prism");
}

export function update_profile_policy(mac, alias, policy, cfg) {
	mac = lc(mac ?? "");
	return with_identity_lock(() => {
		let store = load_store();
		if (!store)
			return null;
		let owners = mac_owner_map(store);
		let p = owners[mac];
		if (!p)
			return null;
		p.policy = policy;
		if (alias != null) {
			p.alias = clean_alias(alias);
			p.group_name = group_name(p.alias, p.anchor_mac);
		}
		save_store(store);
		return p;
	});
};

function promote_anchor(p) {
	let rem = sort(slice(p.macs), (a, b) => (b.seen ?? 0) - (a.seen ?? 0));
	p.macs = rem;
	p.anchor_mac = rem[0].mac;
	p.group_name = group_name(p.alias, p.anchor_mac);
}

export function claim(args, cfg) {
	let mac = lc(args?.mac ?? ""), action = args?.action ?? "new";
	if (!is_mac(mac))
		return { ok: false, error: "bad mac" };

	return with_identity_lock(() => {
		let tel = gather_telemetry(cfg);
		let now = core.now();
		let store = load_store() ?? bootstrap(cfg, tel, now);
		let relays = load_relays_state();
		let owners = mac_owner_map(store);

		if (action == "forget") {
			let cur = owners[mac];
			if (!cur)
				return { ok: false, error: "mac not found" };
			sync_uci_device(mac, "", "auto");
			if (mac == cur.anchor_mac) {
				cur.macs = filter(cur.macs, (m) => m.mac != mac);
				if (length(cur.macs)) {
					promote_anchor(cur);
					sync_uci_device(cur.anchor_mac, cur.alias, cur.policy);
				}
				else {
					store.profiles = filter(store.profiles, (x) => x.uid != cur.uid);
					delete relays[cur.uid];
				}
			}
			else {
				cur.macs = filter(cur.macs, (m) => m.mac != mac);
			}
			save_store(store);
			save_relays_state(relays);
			core.event("IDENTITY forgot mac %s", mac);
			return { ok: true };
		}

		if (action == "merge") {
			let target = profile_by_uid(store, args?.target_uid ?? "");
			if (!target)
				return { ok: false, error: "target profile not found" };
			let old = owners[mac];
			if (old && old.uid != target.uid) {
				old.macs = filter(old.macs, (m) => m.mac != mac);
				if (!length(old.macs)) {
					sync_uci_device(old.anchor_mac, "", "auto");
					store.profiles = filter(store.profiles, (x) => x.uid != old.uid);
					delete relays[old.uid];
					save_relays_state(relays);
				}
				else if (mac == old.anchor_mac) {
					sync_uci_device(mac, "", "auto");
					promote_anchor(old);
					sync_uci_device(old.anchor_mac, old.alias, old.policy);
				}
			}
			if (mac != target.anchor_mac)
				sync_uci_device(mac, "", "auto");
			let obs = observe_mac(mac, tel);
			absorb_mac_fp(target, { ...obs, src: "manual" }, now);
			save_store(store);
			sync_uci_device(target.anchor_mac, target.alias, target.policy);
			core.event("IDENTITY merged %s -> %s (%s)", mac, target.uid, target.group_name);
			return { ok: true, uid: target.uid, group_name: target.group_name };
		}

		// Default action == "new": enroll new logical device & Zashboard group.
		if (owners[mac]) {
			let p = owners[mac];
			if (length(args?.alias)) {
				p.alias = clean_alias(args.alias);
				p.group_name = group_name(p.alias, p.anchor_mac);
			}
			if (length(args?.policy) && (args.policy in [ "auto", "direct", "tunnel", "block", "game" ]))
				p.policy = args.policy;
			save_store(store);
			sync_uci_device(p.anchor_mac, p.alias, p.policy);
			return { ok: true, uid: p.uid, group_name: p.group_name, port: p.port };
		}

		let used_uids = {}, used_ports = {};
		for (let p in store.profiles) {
			used_uids[p.uid] = true;
			used_ports["" + p.port] = true;
		}
		let policy = (args?.policy in [ "auto", "direct", "tunnel", "block", "game" ]) ? args.policy : "auto";
		let np = make_profile(store, cfg, used_uids, used_ports, mac, args?.alias ?? "", policy, tel, now, "manual");
		push(store.profiles, np);
		relays[np.uid] = length(args?.relay) ? args.relay : "TW-HOME";
		save_store(store);
		save_relays_state(relays);
		sync_uci_device(mac, np.alias, policy);
		core.event("IDENTITY enrolled new device %s -> %s (:%d)", mac, np.group_name, np.port);
		return { ok: true, uid: np.uid, group_name: np.group_name, port: np.port };
	});
};

// Build dashboard/CLI view merging live telemetry, profile state, and Mode A quarantine.
export function view(cfg, base_devices, rate_map) {
	let store = load_store();
	let rt = core.load_json(RT_FILE, null);
	let relays = load_relays_state();
	let by_mac = {};
	for (let d in base_devices ?? [])
		by_mac[d.mac] = d;

	let devices_out = [];
	if (store) {
		for (let p in store.profiles) {
			let macs = all_profile_macs(p);
			let best_live = null, primary = by_mac[p.anchor_mac];
			let best_ip = "", host = "", link = "wired", signal = 0, online = false;
			let total_up = 0, total_down = 0, total_up_b = 0, total_down_b = 0;
			let seen_ips = {};

			for (let m in macs) {
				let d = by_mac[m];
				if (!d) continue;
				if (d.online) online = true;
				if (!best_live || (d.online && !best_live.online) || (d.ip && !best_live.ip))
					best_live = d;
				if (d.ip && !seen_ips[d.ip] && rate_map?.[d.ip]) {
					seen_ips[d.ip] = true;
					let r = rate_map[d.ip];
					total_up += r.up ?? 0;
					total_down += r.down ?? 0;
					total_up_b += r.up_bytes ?? 0;
					total_down_b += r.down_bytes ?? 0;
				}
			}
			let pick = best_live ?? primary;
			best_ip = pick?.ip || p.fp?.last_ip || "";
			host = pick?.host || (p.fp?.names?.[0] ?? "");
			link = pick?.link || (p.fp?.media?.[0] ?? "wired");
			signal = pick?.signal ?? 0;
			let active_mac = pick?.mac || p.anchor_mac;
			push(devices_out, {
				uid: p.uid,
				mac: p.anchor_mac,
				active_mac,
				bound_macs: macs,
				group_name: p.group_name,
				port: p.port,
				relay: relays[p.uid] ?? "TW-HOME",
				ip: best_ip,
				host,
				name: p.alias || host || "",
				named: !!length(p.alias),
				link, signal, online,
				policy: p.policy ?? "auto",
				up: int(total_up), down: int(total_down),
				up_bytes: total_up_b, down_bytes: total_down_b,
			});
		}
	}
	else {
		devices_out = base_devices ?? [];
	}

	return {
		devices: devices_out,
		quarantine: rt?.quarantine ?? [],
	};
};
