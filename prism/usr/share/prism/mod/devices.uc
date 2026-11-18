// Devices on the LAN: who is there, how they are attached, what they are
// doing, and where their traffic is allowed to go.
//
// A device is its MAC address. Everything else (address, hostname, radio) is
// looked up fresh, so a device keeps its name and its policy when its lease
// changes.
//
// Policy, enforced first in nft chain classify (see kernel.uc):
//   auto     classified like everyone else
//   direct   never tunnelled
//   tunnel   everything tunnelled, domestic destinations too
//   block    no internet; the router itself stays reachable

import * as fs from "fs";
import * as ubus from "ubus";
import * as core from "../lib/core.uc";
import * as facts from "../lib/facts.uc";

export const POLICIES = [ "auto", "direct", "tunnel", "block", "game" ];

function leases() {
	let out = {};
	for (let line in split(fs.readfile("/tmp/dhcp.leases") ?? "", "\n")) {
		let f = split(line, " ");
		if (length(f) >= 4)
			out[lc(f[1])] = { ip: f[2], host: f[3] == "*" ? "" : f[3] };
	}
	return out;
}

// mac -> { band, signal, rx, tx } for every associated Wi-Fi client
function radios(aps) {
	let out = {}, bus = ubus.connect();
	for (let ap in aps) {
		let r = bus?.call("hostapd." + ap, "get_clients");
		for (let mac, c in r?.clients ?? {})
			out[lc(mac)] = { band: r.freq >= 5000 ? "5G" : "2.4G", signal: c.signal, rx: c.rate?.rx ?? 0, tx: c.rate?.tx ?? 0 };
	}
	bus?.disconnect();
	return out;
}

// Everything known about every device, online or remembered.
//   [{ mac, ip, name, host, link, signal, online, policy, named }]
export function scan(cfg) {
	let lease = leases(), radio = radios(cfg.wifi.ap), seen = {}, list = [];
	let known = {};
	for (let d in cfg.devices)
		known[d.mac] = d;

	let add = (mac, ip, online) => {
		if (seen[mac]) {
			let cur = seen[mac];
			if (online && !cur.online)
				cur.online = true;
			if (length(ip ?? "") && (online || !length(cur.ip)))
				cur.ip = ip;
			return;
		}
		let k = known[mac], l = lease[mac], r = radio[mac];
		let item = {
			mac,
			ip: ip ?? l?.ip ?? "",
			host: l?.host ?? "",
			name: k?.name || l?.host || "",
			named: !!k?.name,
			link: r ? r.band : "wired",
			signal: r?.signal ?? 0,
			online: !!r || online,
			policy: k?.policy ?? "auto",
		};
		seen[mac] = item;
		push(list, item);
	};

	for (let n in facts.neighbours())
		if (n.dev in cfg.main.lan_dev)
			add(lc(n.lladdr), n.dst, facts.active_neighbour(n));
	for (let mac in keys(radio))
		add(mac, null, true);
	for (let mac in keys(known))
		add(mac, null, false);
	for (let mac in keys(lease))
		add(mac, null, false);
	return list;
};
