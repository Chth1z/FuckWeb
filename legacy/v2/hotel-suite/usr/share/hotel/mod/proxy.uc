// mihomo: config rendering, liveness, canary and fail-open.
//
// The kernel has already split traffic by the time mihomo sees a packet, so
// its rule set is a single MATCH. nft decides what is proxied; mihomo decides
// through which node.

import * as fs from "fs";
import * as core from "../lib/core.uc";
import { path } from "../lib/config.uc";
import { MARK_OUT } from "./datapath.uc";

const BIN_GZ = core.SHARE + "/mihomo.gz";
const SECRET = core.ETC + "/clash.secret";
const SKIP_TYPES = [ "selector", "urltest", "direct", "block", "dns" ];
const NODE_RESOLVE_SEC = 600;

export function bin() {
	return core.RUN + "/mihomo";
};

// --- nodes (sing-box outbound shape) -> mihomo proxies ----------------------

function tls_opts(node, p) {
	let tls = node.tls ?? {}, reality = tls.reality ?? {};
	if (tls.server_name)
		p.servername = tls.server_name;
	let fp = tls.utls?.fingerprint ?? node.fingerprint;
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
		return tls_opts(n, p);
	},
	trojan: function(n) {
		return tls_opts(n, { type: "trojan", password: n.password, udp: true });
	},
	shadowsocks: function(n) {
		return { type: "ss", cipher: n.method ?? n.cipher ?? "aes-128-gcm", password: n.password, udp: true };
	},
	vmess: function(n) {
		let p = {
			type: "vmess", uuid: n.uuid, udp: true,
			alterId: n.alter_id ?? n.alterId ?? 0,
			cipher: n.security ?? n.cipher ?? "auto",
		};
		if (n.tls?.enabled || n.tls == true)
			p.tls = true;
		return tls_opts(n, p);
	},
};
CONVERT.hysteria = CONVERT.hysteria2;
CONVERT.ss = CONVERT.shadowsocks;

export function load_nodes(cfg) {
	let raw = core.load_json(path(cfg.proxy.nodes), []);
	if (type(raw) == "object")
		raw = raw.outbounds ?? (raw.type ? [ raw ] : []);
	let proxies = [], ips = [], hosts = [], seen = {};
	for (let n in raw) {
		if (type(n) != "object" || !n.tag || !n.type || n.type in SKIP_TYPES || seen[n.tag])
			continue;
		let convert = CONVERT[n.type];
		if (!convert) {
			core.err("proxy node %s: unsupported type %s", n.tag, n.type);
			continue;
		}
		seen[n.tag] = true;
		push(proxies, { name: n.tag, server: n.server, port: n.server_port ?? 443, ...convert(n) });
		let literal = match(n.server ?? "", /^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$/);
		let list = literal ? ips : hosts;
		if (length(n.server) && !(n.server in list))
			push(list, n.server);
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

function build_config(cfg, lan_ip, proxies) {
	let c = cfg.proxy, names = map(proxies, (p) => p.name);
	let cn_doh = map(cfg.dns.cn_upstream, (u) => split(u, " ")[0]);
	let groups = [];
	if (length(names))
		push(groups, {
			name: "AUTO", type: "url-test", url: c.test_url, interval: c.test_interval,
			tolerance: c.tolerance, lazy: true, "expected-status": 204, proxies: names,
		});
	push(groups, {
		name: "PROXY", type: "select",
		proxies: length(names) ? [ "AUTO", ...names, "DIRECT" ] : [ "DIRECT" ],
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
		"keep-alive-interval": 30,
		// Marks every socket mihomo opens so nft can balance them over the legs.
		"routing-mark": MARK_OUT,
		profile: { "store-selected": true, "store-fake-ip": false },
		tun: { enable: false },
		sniffer: {
			enable: true,
			"override-destination": false,
			"parse-pure-ip": false,
			"force-dns-mapping": true,
			sniff: { HTTP: { ports: [ 80 ] }, TLS: { ports: [ 443, 8443 ] } },
		},
		"external-controller": lan_ip + ":" + c.api_port,
		secret: secret(),
		"external-ui": path(c.ui),
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
			nameserver: length(names) ? [ "https://1.1.1.1/dns-query#PROXY" ] : cn_doh,
		},
		listeners: [
			{ name: "mixed-in", type: "mixed", port: c.mixed_port, listen: "127.0.0.1" },
			{ name: "tproxy-in", type: "tproxy", port: c.tproxy_port, listen: c.tproxy_addr, udp: true },
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

// Render and validate the config. Returns { changed, nodes, ips } or null.
// The live file is replaced only by a config mihomo itself accepts.
export function prepare(cfg, lan_ip) {
	let nodes = load_nodes(cfg);
	if (!length(nodes.proxies))
		return { changed: false, nodes: 0, ips: [], hosts: [] };
	if (!extract_bin())
		return null;
	let file = core.outpath("mihomo.yaml");
	let text = sprintf("%.2J\n", build_config(cfg, lan_ip, nodes.proxies));
	let res = { changed: false, nodes: length(nodes.proxies), ips: nodes.ips, hosts: nodes.hosts };
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
	let r = core.sh(sprintf("%s %s 2>/dev/null", cmd, core.shq(sprintf("http://%s:%d%s", lan_ip, cfg.proxy.api_port, url))));
	let lines = split(trim(r.out), "\n");
	return { status: int(pop(lines)), body: join("\n", lines) };
}

export function reload(cfg, lan_ip) {
	let r = api(cfg, lan_ip, "PUT", "/configs?force=true", sprintf("%J", { path: core.RUN + "/mihomo.yaml" }));
	core.event("PROXY reload http=%d", r.status);
	return r.status == 204 || r.status == 200;
};

function urlenc(s) {
	return replace(s, /[^A-Za-z0-9_.~-]/g, (c) => sprintf("%%%02X", ord(c)));
}

// Delay through AUTO, the group that carries traffic. Falls back to a real
// request through the mixed port when the API cannot answer.
function canary(cfg, lan_ip) {
	let c = cfg.proxy;
	let r = api(cfg, lan_ip, "GET", sprintf("/proxies/AUTO/delay?timeout=%d&url=%s", c.canary_timeout, urlenc(c.canary_url)));
	let m = match(r.body, /"delay":([0-9]+)/);
	if (m && int(m[1]) > 0)
		return int(m[1]);
	let code = trim(core.sh(sprintf("curl -4 -m 8 -sS -o /dev/null -w '%%{http_code}' -x http://127.0.0.1:%d %s 2>/dev/null",
		c.mixed_port, core.shq(c.canary_url))).out);
	return (code == "204" || code == "200") ? 1 : 0;
}

// Addresses of every node, so a LAN client running its own proxy client
// reaches them directly instead of being proxied twice. Hostnames are
// resolved here, through the same resolver the LAN uses, and cached.
function node_addresses(prep, st, now) {
	let key = join(" ", prep.hosts);
	let cache = st.resolved ?? {};
	if (cache.key != key || now - (cache.ts ?? 0) >= NODE_RESOLVE_SEC) {
		let cmds = map(prep.hosts, (h) => sprintf(
			"nslookup -type=a %s 127.0.0.1 2>/dev/null | awk '/^Name:/ { named = 1 } named && /^Address/ { print $2 }' &", core.shq(h)));
		push(cmds, "wait");
		let found = filter(split(core.sh(join("\n", cmds)).out, "\n"), (a) => match(a, /^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$/));
		// A failed lookup must not shrink the set: keep the last good answer.
		if (length(found) || cache.key != key)
			cache = { key, ips: sort(uniq(found)) };
		// Nothing resolved (resolver still starting): try again in a minute.
		cache.ts = length(found) ? now : now - NODE_RESOLVE_SEC + 60;
		st.resolved = cache;
	}
	return sort(uniq([ ...prep.ips, ...(cache.ips ?? []) ]));
}

// Returns the proxy plan for this tick:
//   enabled   the operator wants a proxy and there are nodes
//   on        traffic should be handed to mihomo right now
//   node_ips  node addresses LAN clients may reach directly
export function observe(ctx) {
	let cfg = ctx.cfg, c = cfg.proxy, now = ctx.now;
	let st = (ctx.st.proxy ??= { since: 0, fails: 0, open: false, checked: 0, delay: 0 });
	let plan = { enabled: false, on: false, running: false, nodes: 0, node_ips: [] };
	if (!c.enabled)
		return plan;

	let prep = prepare(cfg, ctx.facts.lan_ip);
	if (!prep || !prep.nodes)
		return plan;
	plan.enabled = true;
	plan.nodes = prep.nodes;
	plan.node_ips = node_addresses(prep, st, now);

	// A mihomo that was just started needs a moment to bind. Waiting here
	// keeps the first tick after boot from installing a direct-only table.
	let listening = () => core.ok(sprintf("netstat -lnt | grep -q ':%d '", c.tproxy_port));
	for (let i = 0; i < 20 && core.pidof("mihomo") && !listening(); i++)
		sleep(500);
	plan.running = core.pidof("mihomo") && listening();
	if (!plan.running) {
		// Up but deaf: mihomo skips a listener it cannot bind and keeps
		// running. Its address exists by now, so a restart fixes it.
		if (core.pidof("mihomo") && now - (st.restarted ?? 0) >= 120) {
			st.restarted = now;
			core.event("PROXY tproxy port %d not bound, restarting mihomo", c.tproxy_port);
			core.act("ubus call service signal '{\"name\":\"hotel\",\"instance\":\"mihomo\",\"signal\":15}'");
		}
		st.since = 0;
		ctx.want_service_sync = true;
		plan.on = !c.fail_open;
		return plan;
	}
	if (!st.since)
		st.since = now;
	if (prep.changed && !core.is_dry())
		reload(cfg, ctx.facts.lan_ip);

	if (st.open || st.fails > 0 || now - st.checked >= c.canary_interval) {
		st.checked = now;
		st.delay = canary(cfg, ctx.facts.lan_ip);
		if (st.delay > 0) {
			if (st.open)
				core.event("PROXY canary recovered delay=%dms", st.delay);
			st.fails = 0;
			st.open = false;
		}
		else if (++st.fails >= c.canary_fails && !st.open && now - st.since >= c.canary_grace) {
			st.open = true;
			core.event("PROXY fail-open after %d failed canaries", st.fails);
		}
	}
	plan.on = !st.open || !c.fail_open;
	return plan;
};
