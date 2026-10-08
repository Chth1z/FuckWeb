// What the system looks like right now. Gathered once per tick so every
// module reasons about the same snapshot.

import * as fs from "fs";
import * as ubus from "ubus";
import { cursor } from "uci";
import * as core from "./core.uc";

function ip_json(args) {
	let r = core.sh("ip -j " + args);
	if (r.code != 0)
		return [];
	try {
		return json(r.out) ?? [];
	}
	catch (e) {
		return [];
	}
}

// device -> { ip, prefix } for the first IPv4 address of each link
function addr4() {
	let out = {};
	for (let link in ip_json("-4 addr show")) {
		for (let a in link.addr_info ?? []) {
			out[link.ifname] ??= { ip: a.local, prefix: a.prefixlen, all: [] };
			push(out[link.ifname].all, a.local);
		}
	}
	return out;
}

// l3 device -> { iface, gw } from netifd. DHCP legs with defaultroute=0 keep
// their gateway under "inactive".
function netifd() {
	let out = {};
	let conn = ubus.connect();
	let dump = conn?.call("network.interface", "dump");
	conn?.disconnect();
	for (let i in dump?.interface ?? []) {
		let dev = i.l3_device ?? i.device;
		if (!dev || dev == "lo")
			continue;
		let gw = null;
		for (let r in [ ...(i.route ?? []), ...(i.inactive?.route ?? []) ])
			if (r.target == "0.0.0.0" && r.mask == 0 && r.nexthop)
				gw ??= r.nexthop;
		let upstream_dns = filter(i.inactive?.["dns-server"] ?? [], (s) => index(s, "127.") != 0);
		out[dev] = { iface: i.interface, up: !!i.up, gw, upstream_dns };
	}
	return out;
}

export function gather() {
	let uci = cursor();
	let lan = uci.get("network", "lan", "ipaddr") ?? "192.168.1.1";
	if (type(lan) == "array")
		lan = lan[0];
	return {
		links: fs.lsdir("/sys/class/net") ?? [],
		addr4: addr4(),
		netifd: netifd(),
		lan_ip: split(lan, "/")[0],
		uptime: core.uptime(),
	};
};

export function ip(args) {
	return ip_json(args);
};

export function carrier(dev) {
	return core.read("/sys/class/net/" + dev + "/carrier") == "1";
};

// Natural order so vwan2 sorts before vwan10.
function natkey(name) {
	let m = match(name, /^(.*[^0-9])?([0-9]+)$/);
	return m ? [ m[1] ?? "", int(m[2]) ] : [ name, -1 ];
}

function natcmp(a, b) {
	let ka = natkey(a), kb = natkey(b);
	if (ka[0] != kb[0])
		return ka[0] < kb[0] ? -1 : 1;
	return ka[1] - kb[1];
}

// Expand glob patterns against existing links, keeping pattern order.
export function expand(patterns, links) {
	let out = [];
	for (let pat in patterns) {
		let hits = filter(links, (l) => wildcard(l, pat) && match(l, /^[A-Za-z0-9_.-]+$/));
		for (let l in sort(hits, natcmp))
			if (!(l in out))
				push(out, l);
	}
	return out;
};
