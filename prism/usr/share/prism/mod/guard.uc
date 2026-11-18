// Independent forwarding guard. fw4 loads its persistent rules before Prism
// starts; kernel.teardown removes only inet prism, never inet prism_guard.
import * as fs from "fs";
import * as core from "../lib/core.uc";
import { path } from "../lib/config.uc";

export function relay_ports(cfg, ctx) {
	let relays = [];
	let is_ip4 = (s) => match(s ?? "", /^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$/);
	let by_host = ctx?.tunnel?.relay_host_ips ?? {};
	for (let n in ctx.tunnel.transports ?? []) {
		let port = int(n.port ?? n.server_port ?? 443);
		if (!(port > 0 && port <= 65535)) continue;
		// Fixed proxy transports only; arbitrary destination ports stay closed.
		let protos = n.type in [ "hysteria", "hysteria2", "tuic" ] ? [ "udp" ] :
			(n.type in [ "shadowsocks", "ss" ] ? [ "tcp", "udp" ] : [ "tcp" ]);
		let host_ips = filter(by_host[n.server] ?? [], is_ip4);
		let servers = is_ip4(n.server) ? [ n.server ] : host_ips;
		for (let srv in servers)
			for (let proto in protos)
				push(relays, sprintf("%s . %s . %d", srv, proto, port));
	}
	for (let ip in cfg.tunnel.guard_ssh4)
		if (match(ip, /^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$/)) push(relays, ip + " . tcp . 22");
	return sort(uniq(relays));
};

export function render_rules(cfg, ctx) {
	let rows = [ "table inet prism_guard", "delete table inet prism_guard", "table inet prism_guard {" ];
	let set = (name, kind, items) => {
		push(rows, "set " + name + " { type " + kind + ";");
		if (length(items)) push(rows, "elements = { " + join(", ", uniq(items)) + " }");
		push(rows, "}");
	};
	let idp = ctx.identity;
	set("lan", "ifname", map(cfg.main.lan_dev, (d) => sprintf('"%s"', d)));
	set("direct_devices", "ether_addr", idp.sets.direct);
	set("blocked_devices", "ether_addr", idp.sets.block);
	set("verified_pairs", "ether_addr . ipv4_addr", idp.pairs);

	set("relay_ports", "ipv4_addr . inet_proto . inet_service", ctx.relay_ports);
	push(rows,
		"chain dns { type nat hook prerouting priority -101; policy accept;",
		"iifname @lan meta l4proto { tcp, udp } th dport 53 counter redirect to :53", "}",
		"chain dns_input { type filter hook input priority -5; policy accept;",
		"iifname @lan meta l4proto { tcp, udp } th dport 853 counter reject with icmpx type admin-prohibited", "}",
		"chain forward { type filter hook forward priority -5; policy accept;",
		"iifname != @lan return", "oifname @lan return",
		"ether saddr @blocked_devices counter drop",
		"meta nfproto ipv6 counter drop",
		"ether saddr . ip saddr != @verified_pairs counter drop",
		"meta l4proto { tcp, udp } th dport { 53, 853 } counter reject with icmpx type admin-prohibited",
		"ether saddr @direct_devices return",
		"ip daddr { 10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16, 169.254.0.0/16 } return",
		"ip daddr . meta l4proto . th dport @relay_ports counter return",
		"meta mark & 0x20000000 == 0x20000000 counter return",
		"counter drop comment \"blocked-fallback\"", "}", "}");
	return join("\n", rows) + "\n";
};

// The persistent file is the fw4 include. Keep the runtime copy only after
// a successful kernel transaction so an interrupted update is retried.
export function plan(ctx) {
	let text = render_rules(ctx.cfg, ctx);
	let persistent = path("guard.nft");
	if (core.is_dry()) {
		assert(core.write_atomic(core.outpath("guard.nft"), text), "cannot write guard plan");
		return text;
	}
	if (fs.readfile(persistent) == text && fs.readfile(core.RUN + "/guard.nft") == text &&
	    core.ok("nft list set inet prism_guard verified_pairs"))
		return "";
	let draft = core.RUN + "/guard.candidate";
	assert(core.write_atomic(draft, text), "cannot stage guard");
	assert(core.sh("nft -c -f " + core.shq(draft)).code == 0, "invalid guard");
	if (fs.readfile(persistent) != text)
		assert(core.write_atomic(persistent, text, 0o600), "cannot persist guard");
	fs.unlink(draft);
	return text;
};
