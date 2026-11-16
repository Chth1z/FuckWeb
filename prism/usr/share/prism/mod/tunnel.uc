// The tunnel (mihomo): config rendering, liveness, canary and fail-open.
//
// The kernel has already classified traffic by the time mihomo sees a packet,
// so its rule set is a single MATCH. nft decides what is tunnelled; mihomo
// decides through which relay.

import * as fs from "fs";
import * as core from "../lib/core.uc";
import { path } from "../lib/config.uc";
import { MARK_TUNNEL_OUT } from "./kernel.uc";

const BIN_GZ = core.SHARE + "/mihomo.gz";
const SECRET = core.ETC + "/controller.secret";
const SELECTED_FILE = core.STATE_DIR + "/selected.json";
const SKIP_TYPES = [ "selector", "urltest", "direct", "block", "dns" ];
const RELAY_RESOLVE_SEC = 600;

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

export function load_relays(cfg) {
	let raw = core.load_json(path(cfg.tunnel.relays), []);
	if (type(raw) == "object")
		raw = raw.outbounds ?? (raw.type ? [ raw ] : []);
	let proxies = [], ips = [], hosts = [], seen = {}, by_name = {};
	for (let n in raw) {
		if (type(n) != "object" || !n.tag || !n.type || n.type in SKIP_TYPES || seen[n.tag])
			continue;
		let convert = CONVERT[n.type];
		if (!convert) {
			core.err("relay %s: unsupported type %s", n.tag, n.type);
			continue;
		}
		seen[n.tag] = true;
		let p = { name: n.tag, server: n.server, port: n.server_port ?? 443, ...convert(n) };
		by_name[n.tag] = p;
		push(proxies, p);
		let literal = match(n.server ?? "", /^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$/);
		let list = literal ? ips : hosts;
		if (length(n.server) && !(n.server in list))
			push(list, n.server);
	}
	// Synthesize Lightsail (MPTCP) -> Taiwan direct residential chained backups
	// so even if the Mainland IPLC entry fails, traffic routes Tokyo -> Taiwan
	// directly (no China hairpin) and exits from the exact same Taiwan IP.
	if (by_name["JP-Lightsail-owner"]) {
		let chains = [
			[ "🇨🇳【亚洲】台湾家宽01丨直连", "🇹🇼【亚洲】台湾家宽01丨专线【3x】", "🔗 台湾家宽01丨Lightsail链式" ],
			[ "🇨🇳【亚洲】台湾家宽02丨直连", "🇹🇼【亚洲】台湾家宽02丨专线【3x】", "🔗 台湾家宽02丨Lightsail链式" ],
		];
		for (let spec in chains) {
			let base = by_name[spec[0]] ?? by_name[spec[1]], tag = spec[2];
			if (base && !seen[tag]) {
				seen[tag] = true;
				let cp = { ...base, name: tag, "dialer-proxy": "JP-Lightsail-owner" };
				by_name[tag] = cp;
				push(proxies, cp);
			}
		}
	}
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
	let pref = [
		"🇹🇼【亚洲】台湾家宽01丨专线【3x】",
		"🔗 台湾家宽01丨Lightsail链式",
		"🇨🇳【亚洲】台湾家宽01丨直连",
		"🇹🇼【亚洲】台湾家宽02丨专线【3x】",
		"🔗 台湾家宽02丨Lightsail链式",
		"🇨🇳【亚洲】台湾家宽02丨直连",
	];
	let out = [];
	for (let n in pref)
		if (n in names)
			push(out, n);
	for (let n in names)
		if (!(n in out) && (index(n, "台湾") >= 0 || index(n, "台灣") >= 0 || index(n, "TW") >= 0))
			push(out, n);
	return length(out) ? out : slice(names);
}

function build_config(cfg, lan_ip, proxies) {
	let c = cfg.tunnel, names = map(proxies, (p) => p.name);
	let tw_list = tw_order(names);
	let cn_doh = map(cfg.dns.cn_upstream, (u) => split(u, " ")[0]);
	let groups = [];
	if (length(names)) {
		let hb = min(int(c.test_interval), 60);
		push(groups, {
			name: "TW-HOME", type: "fallback", url: c.test_url, interval: hb,
			timeout: 3000, lazy: false, "expected-status": 204, proxies: tw_list,
		});
		push(groups, {
			name: "AUTO", type: "fallback", url: c.test_url, interval: hb,
			timeout: 3000, lazy: false, "expected-status": 204, proxies: tw_list,
		});
	}
	push(groups, {
		name: "PROXY", type: "select",
		proxies: length(names) ? [ "TW-HOME", "AUTO", ...names ] : [ "DIRECT" ],
	});
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
			"override-destination": false,
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
			nameserver: length(names) ? [
				"https://9.9.9.9/dns-query#PROXY",
				"https://dns.quad9.net/dns-query#PROXY",
				"https://dns.adguard-dns.com/dns-query#PROXY",
				"https://208.67.222.222/dns-query#PROXY",
			] : cn_doh,
		},
		listeners: [
			{ name: "mixed-in", type: "mixed", port: c.mixed_port, listen: "127.0.0.1" },
			{ name: "tproxy-in", type: "tproxy", port: c.tproxy_port, listen: c.listen_addr, udp: true },
		],
		proxies,
		"proxy-groups": groups,
		rules: [ "MATCH,PROXY" ],
	};
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

// Render and validate the config. Returns { changed, relays, ips, hosts } or null.
// The live file is replaced only by a config mihomo itself accepts.
export function prepare(cfg, lan_ip) {
	let relays = load_relays(cfg);
	if (!length(relays.proxies))
		return { changed: false, relays: 0, ips: [], hosts: [] };
	if (!extract_bin())
		return null;
	let file = core.outpath("mihomo.yaml");
	let text = sprintf("%.2J\n", build_config(cfg, lan_ip, relays.proxies));
	let res = { changed: false, relays: length(relays.proxies), ips: relays.ips, hosts: relays.hosts };
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
	let cmd = sprintf("curl -4 -m 8 -sS -o - -w '\\n%%{http_code}' -X %s -H %s", method,
		core.shq("Authorization: Bearer " + (core.read(SECRET) ?? "")));
	if (body)
		cmd += " -H 'Content-Type: application/json' --data " + core.shq(body);
	let r = core.sh(sprintf("%s %s 2>/dev/null", cmd, core.shq(sprintf("http://%s:%d%s", lan_ip, cfg.tunnel.controller_port, url))));
	let lines = split(trim(r.out), "\n");
	return { status: int(pop(lines)), body: join("\n", lines) };
}

export function save_selected(name) {
	if (length(name))
		core.save_json(SELECTED_FILE, { name, ts: time() });
};

export function restore_selected(cfg, lan_ip) {
	let saved = core.load_json(SELECTED_FILE, {})?.name;
	let target = length(saved) ? saved : "TW-HOME";
	api(cfg, lan_ip, "PUT", "/proxies/PROXY", sprintf("%J", { name: target }));
};

export function reload(cfg, lan_ip) {
	let r = api(cfg, lan_ip, "PUT", "/configs?force=true", sprintf("%J", { path: core.RUN + "/mihomo.yaml" }));
	let ok = r.status == 204 || r.status == 200;
	if (ok)
		restore_selected(cfg, lan_ip);
	core.event("TUNNEL reload http=%d", r.status);
	return ok;
};

function urlenc(s) {
	return replace(s, /[^A-Za-z0-9_.~-]/g, (c) => sprintf("%%%02X", ord(c)));
}

// Delay through PROXY (falling back to AUTO), or a real request through the
// mixed port when the API cannot answer.
function canary(cfg, lan_ip) {
	let c = cfg.tunnel;
	for (let grp in [ "PROXY", "AUTO" ]) {
		let r = api(cfg, lan_ip, "GET", sprintf("/proxies/%s/delay?timeout=%d&url=%s", grp, c.canary_timeout, urlenc(c.canary_url)));
		let m = match(r.body, /"delay":([0-9]+)/);
		if (m && int(m[1]) > 0)
			return int(m[1]);
	}
	let code = trim(core.sh(sprintf("curl -4 -m 8 -sS -o /dev/null -w '%%{http_code}' -x http://127.0.0.1:%d %s 2>/dev/null",
		c.mixed_port, core.shq(c.canary_url))).out);
	return (code == "204" || code == "200") ? 1 : 0;
}

// Addresses of every relay, so a LAN client running its own proxy client
// reaches them directly instead of being proxied twice. Hostnames are
// resolved here, through the same resolver the LAN uses, and retained in a
// 24h sliding window so CDN/GTM round-robin rotation does not churn @relay4.
function relay_addresses(prep, st, now) {
	let key = join(" ", prep.hosts);
	let cache = st.resolved ?? {};
	if (cache.key != key || now - (cache.ts ?? 0) >= RELAY_RESOLVE_SEC) {
		let cmds = map(prep.hosts, (h) => sprintf(
			"nslookup -type=a %s 127.0.0.1 2>/dev/null | awk '/^Name:/ { named = 1 } named && /^Address/ { print $2 }' &", core.shq(h)));
		push(cmds, "wait");
		let found = filter(split(core.sh(join("\n", cmds)).out, "\n"), (a) => match(a, /^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$/));
		let seen = cache.key == key ? { ...(cache.seen ?? {}) } : {};
		for (let ip in cache.key == key ? (cache.ips ?? []) : [])
			seen[ip] ??= now;
		for (let ip in found)
			seen[ip] = now;
		let ips = [];
		for (let ip, seen_ts in seen) {
			if (now - seen_ts < 86400)
				push(ips, ip);
			else
				delete seen[ip];
		}
		if (length(ips) || cache.key != key)
			cache = { key, seen, ips: sort(uniq(ips)) };
		// Nothing resolved (resolver still starting): try again in a minute.
		cache.ts = length(found) ? now : now - RELAY_RESOLVE_SEC + 60;
		st.resolved = cache;
	}
	return sort(uniq([ ...prep.ips, ...(cache.ips ?? []) ]));
}

// Returns the tunnel plan for this pass:
//   enabled   the operator wants a tunnel and there are relays
//   on        traffic should be handed to mihomo right now
//   relay_ips relay addresses LAN clients may reach directly
export function observe(ctx) {
	let cfg = ctx.cfg, c = cfg.tunnel, now = ctx.now;
	let st = (ctx.st.tunnel ??= { since: 0, fails: 0, open: false, checked: 0, delay: 0 });
	let plan = { enabled: false, on: false, running: false, relays: 0, relay_ips: [] };
	if (!c.enabled)
		return plan;

	let prep = prepare(cfg, ctx.facts.lan_ip);
	if (!prep || !prep.relays)
		return plan;
	plan.enabled = true;
	plan.relays = prep.relays;
	plan.relay_ips = relay_addresses(prep, st, now);

	// A mihomo that was just started needs a moment to bind. Waiting here
	// keeps the first pass after boot from installing a direct-only table.
	let listening = () => core.ok(sprintf("netstat -lnt | grep -q ':%d '", c.tproxy_port));
	for (let i = 0; i < 20 && core.pidof("mihomo") && !listening(); i++)
		sleep(500);
	plan.running = core.pidof("mihomo") && listening();
	if (!plan.running) {
		// Up but deaf: mihomo skips a listener it cannot bind and keeps
		// running. Its address exists by now, so a restart fixes it.
		if (core.pidof("mihomo") && now - (st.restarted ?? 0) >= 120) {
			st.restarted = now;
			core.event("TUNNEL tproxy port %d not bound, restarting mihomo", c.tproxy_port);
			core.act("ubus call service signal '{\"name\":\"prism\",\"instance\":\"mihomo\",\"signal\":15}'");
		}
		st.since = 0;
		ctx.want_service_sync = true;
		plan.on = !c.fail_open;
		return plan;
	}
	if (!st.since) {
		st.since = now;
		if (!core.is_dry())
			restore_selected(cfg, ctx.facts.lan_ip);
	}
	if (prep.changed && !core.is_dry())
		reload(cfg, ctx.facts.lan_ip);

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
