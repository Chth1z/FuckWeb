// The tunnel (mihomo): config rendering, per-device TProxy isolation,
// node normalization/deduplication, and Zashboard bidirectional relay sync.
//
// Each verified device profile owns a dedicated local TProxy listener (in-<uid>)
// matched by IN-NAME to its Zashboard select group ("Alias [anchor_mac]").
// Global PROXY and AUTO groups and chained proxies are permanently removed.

import * as fs from "fs";
import * as core from "../lib/core.uc";
import { path } from "../lib/config.uc";
import { MARK_TUNNEL_OUT } from "./kernel.uc";
import * as identity from "./identity.uc";

const BIN_GZ = core.SHARE + "/mihomo.gz";
const SECRET = core.ETC + "/controller.secret";
const SKIP_TYPES = [ "selector", "urltest", "direct", "block", "dns" ];
const RELAY_RESOLVE_SEC = 600;

const RENAME_NODES = {
	"JP-Lightsail-owner": "JP-Lightsail-VLESS",
	"JP-Lightsail-HY2-owner": "JP-Lightsail-HY2",
};

const TW_NODES = [
	"台湾家宽01丨专线【3x】",
	"台湾家宽01丨直连",
	"台湾家宽02丨专线【3x】",
	"台湾家宽02丨直连",
];

const KEEP_ORDER = [
	"JP-Lightsail-VLESS",
	"JP-Lightsail-HY2",
	"US-LA-VLESS",
	"US-LA-Hy2",
	...TW_NODES,
];

export function bin() {
	return core.RUN + "/mihomo";
};

// --- relays (sing-box outbound shape) -> mihomo proxies ----------------------

function tls_opts(relay, p) {
	let tls = relay.tls ?? {}, reality = tls.reality ?? {};
	if (tls.server_name)
		p.servername = tls.server_name;
	let fp = tls.utls?.fingerprint ?? relay.fingerprint;
	if (fp)
		p["client-fingerprint"] = fp;
	if (tls.insecure)
		p["skip-cert-verify"] = true;
	if (reality.enabled || reality.public_key) {
		p["reality-opts"] = { "public-key": reality.public_key ?? "" };
		if (reality.short_id)
			p["reality-opts"]["short-id"] = reality.short_id;
		// Xray 26.9.8+ REALITY (e.g. www.qualcomm.com PQ) rejects stripped ClientHellos;
		// Mihomo defaults support-x25519mlkem768 to false unless explicitly enabled.
		if (reality.support_x25519mlkem768 ?? (relay.server in [ "182.255.84.190", "18.176.216.3" ]))
			p["reality-opts"]["support-x25519mlkem768"] = true;
	}
	return p;
}

function tcp_opts(relay, p) {
	// Enable MPTCP for explicit opt-in or our Lightsail server (both sides verified);
	// arbitrary third-party relays stay standard TCP to avoid middlebox SYN stalls.
	if (relay.mptcp ?? (relay.server == "18.176.216.3"))
		p.mptcp = true;
	if (relay.tfo)
		p.tfo = true;
	return p;
}

const CONVERT = {
	hysteria2: function(n) {
		let tls = n.tls ?? {}, obfs = n.obfs ?? {}, hop = n.hop_ports ?? n.ports;
		let p = { type: "hysteria2", password: n.password, alpn: [ "h3" ] };
		if (type(hop) == "string" && length(hop))
			p.ports = hop;
		if (tls.server_name)
			p.sni = tls.server_name;
		if (tls.insecure)
			p["skip-cert-verify"] = true;
		let fp = tls.utls?.fingerprint ?? tls.fingerprint ?? n.fingerprint;
		if (fp)
			p.fingerprint = fp;
		if (obfs.type)
			p.obfs = obfs.type;
		if (obfs.password)
			p["obfs-password"] = obfs.password;
		return p;
	},
	vless: function(n) {
		let p = { type: "vless", uuid: n.uuid, network: "tcp", udp: true, tls: true };
		for (let from, to in { flow: "flow", encryption: "encryption", packet_encoding: "packet-encoding" })
			if (type(n[from]) == "string" && length(n[from]))
				p[to] = n[from];
		return tcp_opts(n, tls_opts(n, p));
	},
	trojan: function(n) {
		return tcp_opts(n, tls_opts(n, { type: "trojan", password: n.password, udp: true }));
	},
	shadowsocks: function(n) {
		return tcp_opts(n, { type: "ss", cipher: n.method ?? n.cipher ?? "aes-128-gcm", password: n.password, udp: true });
	},
	vmess: function(n) {
		let p = {
			type: "vmess", uuid: n.uuid, udp: true,
			alterId: n.alter_id ?? n.alterId ?? 0,
			cipher: n.security ?? n.cipher ?? "auto",
		};
		if (n.tls?.enabled || n.tls == true)
			p.tls = true;
		return tcp_opts(n, tls_opts(n, p));
	},
};
CONVERT.hysteria = CONVERT.hysteria2;
CONVERT.ss = CONVERT.shadowsocks;

function is_emoji_or_space(s) {
	for (let i = 0; i < length(s); ) {
		let b = ord(s, i);
		if (b == 0x20 || b == 0x09) {
			i++;
			continue;
		}
		// UTF-8 4-byte emoji / regional flags start with 0xF0..0xF4. Reject ASCII words & 3-byte CJK (0xE4..0xE9).
		if (b >= 0xF0 && b <= 0xF4 && i + 4 <= length(s)) {
			i += 4;
			continue;
		}
		return false;
	}
	return true;
}

function strip_region_prefix(tag) {
	let idx_open = index(tag ?? "", "【");
	let idx_close = idx_open >= 0 ? index(tag, "】", idx_open) : -1;
	if (idx_open >= 0 && idx_close > idx_open && idx_close < 28) {
		let lead = substr(tag, 0, idx_open);
		if (is_emoji_or_space(lead))
			return trim(substr(tag, idx_close + length("】")));
	}
	return trim(tag ?? "");
}

export function normalize_tag(tag) {
	let cleaned = strip_region_prefix(tag);
	return RENAME_NODES[cleaned] ?? RENAME_NODES[tag] ?? cleaned;
};

export function load_relays(cfg) {
	let raw = core.load_json(path(cfg.tunnel.relays), []);
	if (type(raw) == "object")
		raw = raw.outbounds ?? (raw.type ? [ raw ] : []);
	let by_name = {}, ips = [], hosts = [];
	for (let n in raw) {
		if (type(n) != "object" || !n.tag || !n.type || n.type in SKIP_TYPES)
			continue;
		let name = normalize_tag(n.tag);
		if (!(name in KEEP_ORDER) || by_name[name])
			continue;
		let convert = CONVERT[n.type];
		if (!convert) {
			core.err("relay %s: unsupported type %s", n.tag, n.type);
			continue;
		}
		let p = { name, server: n.server, port: n.server_port ?? 443, ...convert(n) };
		by_name[name] = p;
		let literal = match(n.server ?? "", /^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$/);
		let list = literal ? ips : hosts;
		if (length(n.server) && !(n.server in list))
			push(list, n.server);
	}
	let proxies = [];
	for (let name in KEEP_ORDER)
		if (by_name[name])
			push(proxies, by_name[name]);
	return { proxies, ips, hosts };
};

// --- config ----------------------------------------------------------------

function secret() {
	let s = core.read(SECRET);
	if (!s && !core.is_dry()) {
		s = trim(core.sh("tr -dc A-Za-z0-9 </dev/urandom | head -c 20").out);
		core.write_atomic(SECRET, s + "\n", 0o600);
	}
	return s ?? "";
}

function tw_order(names) {
	let out = [];
	for (let n in TW_NODES)
		if (n in names)
			push(out, n);
	return out;
}

function build_config(cfg, lan_ip, proxies, profiles) {
	let c = cfg.tunnel, names = map(proxies, (p) => p.name);
	let tw_list = tw_order(names);
	let cn_doh = map(cfg.dns.cn_upstream, (u) => split(u, " ")[0]);
	let groups = [], rules = [];
	let listeners = [
		{ name: "mixed-in", type: "mixed", port: c.mixed_port, listen: "127.0.0.1" },
	];

	let has_tw = length(tw_list) > 0;
	if (has_tw) {
		push(groups, {
			name: "TW-HOME", type: "select", proxies: tw_list,
		});
	}

	let vps_proxy = null;
	for (let cand in [ "JP-Lightsail-VLESS", "JP-Lightsail-HY2", "US-LA-Hy2" ]) {
		if (cand in names) {
			vps_proxy = cand;
			break;
		}
	}
	if (vps_proxy) {
		// Taiwan residential relays block outbound mail ports (465/587/993); route mail
		// ports through an owned VPS relay so devices on TW-HOME still sync email cleanly.
		for (let mp in [ 25, 110, 143, 465, 587, 993, 995 ])
			push(rules, sprintf("DST-PORT,%d,%s", mp, vps_proxy));
	}

	let choices = has_tw ? [ "TW-HOME", ...names ] : slice(names);
	let sorted_profiles = sort(slice(profiles ?? []), (a, b) => (a.port ?? 0) - (b.port ?? 0));
	for (let p in sorted_profiles) {
		if (!p.uid || !p.port || !p.group_name)
			continue;
		let lname = "in-" + p.uid;
		push(listeners, { name: lname, type: "tproxy", port: p.port, listen: c.listen_addr, udp: true });
		push(groups, {
			name: p.group_name,
			type: "select",
			proxies: length(choices) ? choices : [ "TW-HOME" ],
		});
		push(rules, sprintf("IN-NAME,%s,%s", lname, p.group_name));
	}

	let dns_proxy_tag = has_tw ? "TW-HOME" : (names[0] ?? "");
	let dns_alt_tag = vps_proxy ?? dns_proxy_tag;
	if (has_tw)
		push(rules, "IN-NAME,mixed-in,TW-HOME");
	else if (length(names))
		push(rules, "IN-NAME,mixed-in," + names[0]);
	push(rules, "MATCH,REJECT");

	return {
		mode: "rule",
		"log-level": "error",
		ipv6: false,
		"allow-lan": false,
		"find-process-mode": "off",
		"unified-delay": true,
		"tcp-concurrent": true,
		"geodata-mode": false,
		"geo-auto-update": false,
		"keep-alive-idle": 600,
		"keep-alive-interval": 15,
		// Marks every socket mihomo opens so nft can weave them over the strands.
		"routing-mark": MARK_TUNNEL_OUT,
		profile: { "store-selected": true, "store-fake-ip": false },
		tun: { enable: false },
		sniffer: {
			enable: true,
			"override-destination": true,
			"parse-pure-ip": false,
			"force-dns-mapping": true,
			sniff: { HTTP: { ports: [ 80, 8080 ] }, TLS: { ports: [ 443, 8443 ] } },
		},
		"external-controller": lan_ip + ":" + c.controller_port,
		secret: secret(),
		"external-ui": path(c.dashboard),
		dns: {
			enable: true,
			listen: "127.0.0.1:" + c.dns_port,
			ipv6: false,
			"enhanced-mode": "redir-host",
			"cache-algorithm": "arc",
			"use-hosts": false,
			"use-system-hosts": false,
			"respect-rules": false,
			"default-nameserver": cn_doh,
			"proxy-server-nameserver": cn_doh,
			nameserver: length(dns_proxy_tag) ? [
				"https://9.9.9.9/dns-query#" + dns_alt_tag,
				"https://149.112.112.112/dns-query#" + dns_proxy_tag,
				"https://94.140.14.14/dns-query#" + dns_alt_tag,
				"https://208.67.222.222/dns-query#" + dns_proxy_tag,
			] : cn_doh,
		},
		listeners,
		proxies,
		"proxy-groups": groups,
		rules,
	};
}

function sanitize_cache_db() {
	let p = core.RUN + "/cache.db";
	let f = fs.open(p, "r");
	if (!f)
		return;
	let hdr = f.read(20) ?? "";
	f.close();
	// Remove non-bbolt cache.db (e.g. legacy SmartDNS collision or truncated DB) before Mihomo reads it.
	let valid_bbolt = length(hdr) >= 20
		&& ord(hdr, 16) == 0xed && ord(hdr, 17) == 0xda
		&& ord(hdr, 18) == 0x0c && ord(hdr, 19) == 0xed;
	if (length(hdr) > 0 && !valid_bbolt)
		fs.unlink(p);
}

function extract_bin() {
	let b = bin();
	if (fs.access(b, "x") && core.ok(b + " -v"))
		return true;
	if (!core.ok(sprintf("gzip -dc %s > %s.tmp && chmod 755 %s.tmp && %s.tmp -v", BIN_GZ, b, b, b))) {
		fs.unlink(b + ".tmp");
		core.err("cannot unpack %s", BIN_GZ);
		return false;
	}
	return fs.rename(b + ".tmp", b) == true;
}

// Render and validate the config. Returns { changed, relays, ips, hosts, expected_ports } or null.
// The live file is replaced only by a config mihomo itself accepts.
export function prepare(cfg, lan_ip, profiles) {
	let relays = load_relays(cfg);
	if (!length(relays.proxies))
		return { changed: false, relays: 0, ips: [], hosts: [], expected_ports: [] };
	if (!extract_bin())
		return null;
	sanitize_cache_db();
	profiles ??= identity.load_store()?.profiles ?? [];
	let file = core.outpath("mihomo.yaml");
	let rendered = build_config(cfg, lan_ip, relays.proxies, profiles);
	let text = sprintf("%.2J\n", rendered);
	let expected_ports = map(filter(rendered.listeners, (l) => l.type == "tproxy"), (l) => l.port);
	let res = { changed: false, relays: length(relays.proxies), ips: relays.ips, hosts: relays.hosts, expected_ports };
	if (fs.readfile(file) == text)
		return res;
	let draft = file + ".draft";
	fs.writefile(draft, text);
	fs.chmod(draft, 0o600);
	let test = core.sh(sprintf("SAFE_PATHS=%s %s -t -d %s -f %s", core.ETC, bin(), core.RUN, draft));
	if (test.code != 0) {
		core.err("mihomo rejected the new config: %s", trim(test.out));
		fs.unlink(draft);
		return null;
	}
	fs.rename(draft, file);
	res.changed = true;
	return res;
};

// --- runtime ---------------------------------------------------------------

function api(cfg, lan_ip, method, url, body) {
	let cmd = sprintf("curl -4 --noproxy '*' -m 8 -sS -o - -w '\\n%%{http_code}' -X %s -H %s", method,
		core.shq("Authorization: Bearer " + (core.read(SECRET) ?? "")));
	if (body)
		cmd += " -H 'Content-Type: application/json' --data " + core.shq(body);
	let r = core.sh(sprintf("%s %s 2>/dev/null", cmd, core.shq(sprintf("http://%s:%d%s", lan_ip, cfg.tunnel.controller_port, url))));
	let lines = split(trim(r.out), "\n");
	return { status: int(pop(lines)), body: join("\n", lines) };
}

export function urlenc(s) {
	let out = "";
	for (let i = 0; i < length(s); i++) {
		let ch = substr(s, i, 1);
		out += match(ch, /^[A-Za-z0-9_.~-]$/) ? ch : sprintf("%%%02X", ord(s, i));
	}
	return out;
};

function parse_json_obj(s) {
	try {
		return length(trim(s ?? "")) ? json(s) : null;
	}
	catch (e) {
		return null;
	}
}

export function save_selected(uid_or_group, name) {
	if (!length(name ?? ""))
		return;
	identity.with_identity_lock(() => {
		let relays = identity.load_relays_state();
		let key = length(uid_or_group) ? uid_or_group : "_tw_home";
		if (relays[key] != name) {
			relays[key] = name;
			identity.save_relays_state(relays);
		}
	});
};

export function restore_selected(cfg, lan_ip, profiles) {
	profiles ??= identity.load_store()?.profiles ?? [];
	let relays = identity.load_relays_state();
	let live = null;
	for (let i = 0; i < 4 && !live; i++) {
		live = parse_json_obj(api(cfg, lan_ip, "GET", "/proxies").body)?.proxies;
		if (!live && i < 3)
			sleep(250);
	}
	if (!live)
		return false;
	let all_ok = true;
	let tw_g = live["TW-HOME"];
	if (tw_g) {
		let want_tw = relays._tw_home ?? "";
		if (!(want_tw in (tw_g.all ?? [])))
			want_tw = tw_g.all?.[0] ?? "";
		if (length(want_tw) && tw_g.now != want_tw) {
			let pr = api(cfg, lan_ip, "PUT", "/proxies/TW-HOME", sprintf("%J", { name: want_tw }));
			if (pr.status != 200 && pr.status != 204)
				all_ok = false;
		}
	}
	for (let p in profiles) {
		let g = live[p.group_name];
		if (!g)
			continue;
		let want = relays[p.uid] ?? "TW-HOME";
		if (!(want in (g.all ?? [])))
			want = ("TW-HOME" in (g.all ?? [])) ? "TW-HOME" : (g.all?.[0] ?? "");
		if (length(want) && g.now != want) {
			let pr = api(cfg, lan_ip, "PUT", "/proxies/" + urlenc(p.group_name), sprintf("%J", { name: want }));
			if (pr.status != 200 && pr.status != 204)
				all_ok = false;
		}
	}
	return all_ok;
};

// Poll live Zashboard selections from Mihomo RAM and persist only when modified.
export function sync_selected(cfg, lan_ip, profiles) {
	let res = api(cfg, lan_ip, "GET", "/proxies");
	let live = parse_json_obj(res.body)?.proxies;
	if (!live)
		return false;
	return identity.with_identity_lock(() => {
		// Re-read authoritative store inside identity.lock so concurrent claim/forget
		// cannot have deleted UIDs resurrected by a stale pre-HTTP snapshot.
		let store = identity.load_store();
		let cur_profiles = store?.profiles ?? profiles ?? [];
		let saved = identity.load_relays_state();
		let next = { ...saved }, changed = false;
		let valid_uids = {};
		if (live["TW-HOME"]?.now && next._tw_home != live["TW-HOME"].now) {
			next._tw_home = live["TW-HOME"].now;
			changed = true;
		}
		for (let p in cur_profiles) {
			valid_uids[p.uid] = true;
			let now_sel = live[p.group_name]?.now;
			if (length(now_sel) && next[p.uid] != now_sel) {
				next[p.uid] = now_sel;
				changed = true;
			}
		}
		if (store) {
			for (let k in keys(next)) {
				if (k != "_tw_home" && !valid_uids[k]) {
					delete next[k];
					changed = true;
				}
			}
		}
		if (changed)
			identity.save_relays_state(next);
		return changed;
	});
};

function reload_raw(cfg, lan_ip, profiles) {
	sanitize_cache_db();
	let r = api(cfg, lan_ip, "PUT", "/configs?force=true", sprintf("%J", { path: core.RUN + "/mihomo.yaml" }));
	let ok = r.status == 204 || r.status == 200;
	if (ok)
		ok = restore_selected(cfg, lan_ip, profiles);
	core.event("TUNNEL reload http=%d restored=%d", r.status, ok ? 1 : 0);
	return { ok, status: r.status };
}

export function reload(cfg, lan_ip, profiles) {
	return reload_raw(cfg, lan_ip, profiles).ok;
};

// Delay through TW-HOME (falling back to working VPS relays or mixed-in).
function canary(cfg, lan_ip) {
	let c = cfg.tunnel;
	for (let grp in [ "TW-HOME", "JP-Lightsail-VLESS", "JP-Lightsail-HY2", "US-LA-VLESS", "US-LA-Hy2" ]) {
		let r = api(cfg, lan_ip, "GET", sprintf("/proxies/%s/delay?timeout=%d&url=%s", urlenc(grp), c.canary_timeout, urlenc(c.canary_url)));
		let m = match(r.body, /"delay":([0-9]+)/);
		if (m && int(m[1]) > 0)
			return int(m[1]);
	}
	let code = trim(core.sh(sprintf("curl -4 -m 8 -sS -o /dev/null -w '%%{http_code}' -x http://127.0.0.1:%d %s 2>/dev/null",
		c.mixed_port, core.shq(c.canary_url))).out);
	return (code == "204" || code == "200") ? 1 : 0;
}

function listening_ports() {
	let ports = {};
	for (let line in split(core.sh("netstat -lnt 2>/dev/null").out, "\n")) {
		let m = match(line, /:([0-9]+)[ \t]+.*LISTEN/);
		if (m)
			ports[m[1]] = true;
	}
	return ports;
}

function all_expected_ready(ready, mixed_port, expected_ports) {
	if (!ready["" + mixed_port])
		return false;
	for (let p in expected_ports ?? [])
		if (!ready["" + p])
			return false;
	return true;
}

// Addresses of every active relay, so a LAN client running its own proxy client
// reaches them directly instead of being proxied twice.
function relay_addresses(prep, st, now) {
	let key = join(" ", prep.hosts);
	let cache = st.resolved ?? {};
	if (cache.key != key || !cache.by_host || now - (cache.ts ?? 0) >= RELAY_RESOLVE_SEC) {
		let host_seen = cache.key == key ? { ...(cache.by_host_seen ?? {}) } : {};
		let any_found = !length(prep.hosts);
		if (length(prep.hosts)) {
			let cmds = map(prep.hosts, (h) => sprintf(
				"nslookup -type=a %s 127.0.0.1 2>/dev/null | awk -v h=%s '/^Name:/ { named = 1 } named && /^Address/ { print h, $2 }' &",
				core.shq(h), core.shq(h)));
			push(cmds, "wait");
			for (let line in split(core.sh(join("\n", cmds)).out, "\n")) {
				let p = split(trim(line), / +/);
				let h = p[0], ip = p[1];
				if (h && match(ip ?? "", /^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$/)) {
					any_found = true;
					(host_seen[h] ??= {})[ip] = now;
				}
			}
		}
		let by_host = {}, ips = [], clean_host_seen = {};
		for (let h, tbl in host_seen) {
			let h_ips = [], kept = {};
			for (let ip, seen_ts in tbl) {
				if (now - seen_ts < 86400) {
					kept[ip] = seen_ts;
					push(h_ips, ip);
					push(ips, ip);
				}
			}
			if (length(h_ips)) {
				clean_host_seen[h] = kept;
				by_host[h] = sort(uniq(h_ips));
			}
		}
		ips = sort(uniq(ips));
		if (length(ips) || cache.key != key)
			cache = { key, by_host_seen: clean_host_seen, by_host, ips };
		else
			cache = { ...cache, by_host_seen: clean_host_seen, by_host };
		cache.ts = any_found ? now : now - RELAY_RESOLVE_SEC + 60;
		st.resolved = cache;
	}
	return { ips: sort(uniq([ ...prep.ips, ...(cache.ips ?? []) ])), by_host: cache.by_host ?? {} };
}

// Returns the tunnel plan for this pass:
//   enabled         the operator wants a tunnel and there are relays
//   on              traffic should be handed to mihomo right now
//   ready_ports     map of listening TProxy ports verified live in netstat
//   relay_ips       relay addresses LAN clients may reach directly
//   relay_host_ips  per-hostname resolved relay addresses for @relay_ports
export function observe(ctx) {
	let cfg = ctx.cfg, c = cfg.tunnel, now = ctx.now;
	let st = (ctx.st.tunnel ??= { since: 0, fails: 0, open: false, checked: 0, delay: 0 });
	let profiles = ctx.identity?.profiles ?? identity.load_store()?.profiles ?? [];
	let plan = { enabled: false, on: false, running: false, restored: false, pid: "", relays: 0, relay_ips: [], relay_host_ips: {}, ready_ports: {} };
	if (!c.enabled)
		return plan;

	let prep = prepare(cfg, ctx.facts.lan_ip, profiles);
	if (!prep || !prep.relays)
		return plan;
	plan.enabled = true;
	plan.relays = prep.relays;
	let addr = relay_addresses(prep, st, now);
	plan.relay_ips = addr.ips;
	plan.relay_host_ips = addr.by_host;

	// Wait briefly until Mihomo binds mixed-in (and existing profile ports when config unchanged).
	let ready = listening_ports();
	let min_check = (p) => p["" + c.mixed_port] && (prep.changed || !length(prep.expected_ports) || p["" + prep.expected_ports[0]]);
	for (let i = 0; i < 20 && core.pidof("mihomo") && !min_check(ready); i++) {
		sleep(500);
		ready = listening_ports();
	}
	plan.running = core.pidof("mihomo") && min_check(ready);
	if (!plan.running) {
		if (core.pidof("mihomo") && now - (st.restarted ?? 0) >= 120) {
			st.restarted = now;
			core.event("TUNNEL tproxy listeners not bound, restarting mihomo");
			core.act("ubus call service signal '{\"name\":\"prism\",\"instance\":\"mihomo\",\"signal\":15}'");
		}
		st.since = 0;
		st.pid = "";
		ctx.want_service_sync = true;
		plan.on = !c.fail_open;
		plan.ready_ports = ready;
		return plan;
	}
	let pid = trim(core.sh("pidof mihomo").out);
	plan.pid = pid;
	if (prep.changed && !core.is_dry()) {
		if (st.since && st.pid == pid)
			sync_selected(cfg, ctx.facts.lan_ip);
		let rr = reload_raw(cfg, ctx.facts.lan_ip, profiles);
		let ok = rr.ok;
		plan.restored = ok;
		if (ok) {
			st.since ||= now;
			st.pid = pid;
		}
		else if ((rr.status == 0 || rr.status >= 500) && now - (st.restarted ?? 0) >= 60) {
			st.restarted = now;
			st.since = 0;
			st.pid = "";
			fs.unlink(core.RUN + "/cache.db");
			core.event("TUNNEL reload http=%d failed, restarting mihomo", rr.status);
			core.act("ubus call service signal '{\"name\":\"prism\",\"instance\":\"mihomo\",\"signal\":15}'");
			ctx.want_service_sync = true;
			ctx.want_rescan = true;
			plan.ready_ports = listening_ports();
			plan.on = !c.fail_open;
			return plan;
		}
		else {
			st.pid = "";
			ctx.want_rescan = true;
		}
		for (let i = 0; i < 12; i++) {
			ready = listening_ports();
			if (all_expected_ready(ready, c.mixed_port, prep.expected_ports))
				break;
			sleep(250);
		}
	}
	else if (!st.since || st.pid != pid || ctx.boot) {
		if (!core.is_dry()) {
			let ok = restore_selected(cfg, ctx.facts.lan_ip, profiles);
			plan.restored = ok;
			if (ok) {
				st.since ||= now;
				st.pid = pid;
			}
			else {
				st.pid = "";
				ctx.want_rescan = true;
			}
		}
		else {
			plan.restored = true;
		}
	}
	else {
		plan.restored = true;
	}
	plan.ready_ports = ready;
	if (!all_expected_ready(ready, c.mixed_port, prep.expected_ports)) {
		ctx.want_rescan = true;
		st.port_fails = (st.port_fails ?? 0) + 1;
		if (st.port_fails >= 2 && core.pidof("mihomo") && now - (st.restarted ?? 0) >= 60) {
			st.port_fails = 0;
			st.restarted = now;
			core.event("TUNNEL device listener port missing after reload, restarting mihomo");
			core.act("ubus call service signal '{\"name\":\"prism\",\"instance\":\"mihomo\",\"signal\":15}'");
			ctx.want_service_sync = true;
		}
	}
	else {
		st.port_fails = 0;
	}

	if (st.open || st.fails > 0 || now - st.checked >= c.canary_interval) {
		st.checked = now;
		st.delay = canary(cfg, ctx.facts.lan_ip);
		if (st.delay > 0) {
			if (st.open)
				core.event("TUNNEL canary recovered delay=%dms", st.delay);
			st.fails = 0;
			st.open = false;
		}
		else if (++st.fails >= c.canary_fails && !st.open && now - st.since >= c.canary_grace) {
			st.open = true;
			core.event("TUNNEL fail-open after %d failed canaries", st.fails);
		}
	}
	plan.on = !st.open || !c.fail_open;
	return plan;
};
