// Independent forwarding guard. fw4 loads its persistent rules before Prism
// starts; kernel.teardown removes only inet prism, never inet prism_guard.
import * as fs from "fs";
import * as core from "../lib/core.uc";
import { path } from "../lib/config.uc";

export function render_rules(cfg, ctx) {
	let rows = [ "table inet prism_guard", "delete table inet prism_guard", "table inet prism_guard {" ];
	let set = (name, kind, items) => {
		push(rows, "set " + name + " { type " + kind + ";");
		if (length(items)) push(rows, "elements = { " + join(", ", uniq(items)) + " }");
		push(rows, "}");
	};
	if (cfg.tunnel.fail_open) {
		push(rows, "}");
		return join("\n", rows) + "\n";
	}
	set("lan", "ifname", map(cfg.main.lan_dev, (d) => sprintf('"%s"', d)));
	set("direct_devices", "ether_addr", map(filter(cfg.devices, (d) => d.policy == "direct"), (d) => d.mac));
	set("blocked_devices", "ether_addr", map(filter(cfg.devices, (d) => d.policy == "block"), (d) => d.mac));
	let raw = core.load_json(path(cfg.tunnel.relays), []), relays = [];
	let is_ip4 = (s) => match(s ?? "", /^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$/);
	let resolved_ips = filter(ctx?.tunnel?.relay_ips ?? [], is_ip4);
	let by_host = ctx?.tunnel?.relay_host_ips ?? {};
	if (type(raw) == "object") raw = raw.outbounds ?? (raw.type ? [ raw ] : []);
	for (let n in raw) {
		let port = int(n.server_port ?? 443);
		if (!(port > 0 && port <= 65535)) continue;
		// Fixed proxy transports only; arbitrary destination ports stay closed.
		let protos = n.type in [ "hysteria", "hysteria2", "tuic" ] ? [ "udp" ] :
			(n.type in [ "shadowsocks", "ss" ] ? [ "tcp", "udp" ] : [ "tcp" ]);
		let host_ips = filter(by_host[n.server] ?? [], is_ip4);
		let servers = is_ip4(n.server) ? [ n.server ] :
			(ctx?.tunnel?.relay_host_ips != null ? host_ips : resolved_ips);
		for (let srv in servers)
			for (let proto in protos)
				push(relays, sprintf("%s . %s . %d", srv, proto, port));
	}
	for (let ip in cfg.tunnel.guard_ssh4)
		if (match(ip, /^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$/)) push(relays, ip + " . tcp . 22");
	set("relay_ports", "ipv4_addr . inet_proto . inet_service", relays);
	push(rows,
		"chain dns { type nat hook prerouting priority -101; policy accept;",
		"iifname @lan meta l4proto { tcp, udp } th dport 53 counter redirect to :53", "}",
		"chain dns_input { type filter hook input priority -5; policy accept;",
		"iifname @lan meta l4proto { tcp, udp } th dport 853 counter reject with icmpx type admin-prohibited", "}",
		"chain forward { type filter hook forward priority -5; policy accept;",
		"iifname != @lan return", "oifname @lan return",
		"ether saddr @blocked_devices counter drop",
		"meta l4proto { tcp, udp } th dport { 53, 853 } counter reject with icmpx type admin-prohibited",
		"ether saddr @direct_devices return",
		"ip daddr { 10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16, 169.254.0.0/16 } return",
		"meta nfproto ipv6 counter drop",
		"ip daddr . meta l4proto . th dport @relay_ports counter return",
		"meta mark & 0x20000000 == 0x20000000 counter return",
		"counter drop comment \"blocked-fallback\"", "}", "}");
	return join("\n", rows) + "\n";
};

export function apply(ctx) {
	let text = render_rules(ctx.cfg, ctx), persistent = path("guard.nft");
	if (!core.is_dry() && fs.readfile(persistent) == text && core.ok("nft list table inet prism_guard"))
		return true;
	let draft = core.outpath("guard.nft");
	fs.writefile(draft, text);
	let checked = core.sh("nft -c -f " + core.shq(draft));
	if (checked.code != 0) {
		core.err("guard validation: %s", trim(checked.out));
		return false;
	}
	if (core.is_dry()) {
		warn("guard: valid -> ", draft, "\n");
		return true;
	}
	if (!core.act("nft -f " + core.shq(draft))) return false;
	core.write_atomic(persistent, text, 0o600);
	core.event("GUARD updated (fail_open=%d)", ctx.cfg.tunnel.fail_open);
	return true;
};
