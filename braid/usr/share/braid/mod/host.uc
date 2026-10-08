// Host tuning that is not datapath: one-time provisioning of UCI defaults,
// per-device steering, IPv6 off, IRQ affinity and the uplink shaper.

import * as fs from "fs";
import { cursor } from "uci";
import * as core from "../lib/core.uc";

const PROVISION = core.ETC + "/provision.json";
const RELOAD = {
	firewall: "/etc/init.d/firewall reload",
	wireless: "wifi reload",
	uhttpd: "/etc/init.d/uhttpd reload",
	dhcp: "/etc/init.d/dnsmasq reload",
};

// --- provisioning ----------------------------------------------------------

// provision.json declares UCI values this box should have. Sections that do
// not exist are skipped, so one file fits boards with different radios.
export function provision(ctx) {
	let spec = core.load_json(PROVISION, {});
	let uci = cursor(), dirty = {};

	let set = (config, section, option, value) => {
		if (uci.get(config, section) == null || uci.get(config, section, option) == "" + value)
			return;
		core.info("provision %s.%s.%s=%s", config, section, option, value);
		if (!core.is_dry())
			uci.set(config, section, option, "" + value);
		dirty[config] = true;
	};

	for (let config, sections in spec.uci ?? {}) {
		for (let section, opts in sections) {
			// "@type[0]" addresses the first section of a type.
			let m = match(section, /^@([a-z_-]+)\[0\]$/);
			if (m) {
				section = null;
				uci.foreach(config, m[1], (s) => { section ??= s[".name"]; });
				if (!section)
					continue;
			}
			for (let option, value in opts)
				set(config, section, option, value);
		}
	}

	// The web UI and SSH stay on the LAN address.
	let lan = ctx.facts.lan_ip;
	if (uci.get("uhttpd", "main") && join(" ", uci.get("uhttpd", "main", "listen_http") ?? []) != lan + ":80") {
		core.info("provision uhttpd listen %s:80", lan);
		if (!core.is_dry())
			uci.set("uhttpd", "main", "listen_http", [ lan + ":80" ]);
		dirty.uhttpd = true;
	}

	if (!core.is_dry()) {
		for (let config in keys(dirty)) {
			uci.commit(config);
			if (RELOAD[config])
				core.act(RELOAD[config]);
		}
		for (let svc in spec.disable_services ?? [])
			if (core.ok(sprintf("/etc/init.d/%s enabled", svc)))
				core.act(sprintf("/etc/init.d/%s stop; /etc/init.d/%s disable", svc, svc));
		if (length(keys(dirty)))
			core.event("PROVISION %s", join(" ", keys(dirty)));
	}
	return keys(dirty);
};

// --- per-device knobs ------------------------------------------------------

function steer(dev) {
	for (let q in fs.glob("/sys/class/net/" + dev + "/queues/rx-*")) {
		core.knob(q + "/rps_cpus", "f");
		core.knob(q + "/rps_flow_cnt", 4096);
	}
	for (let q in fs.glob("/sys/class/net/" + dev + "/queues/tx-*"))
		core.knob(q + "/xps_cpus", "f");
}

function irq_affinity(spec) {
	let seen = {};
	for (let line in split(fs.readfile("/proc/interrupts") ?? "", "\n")) {
		let m = match(line, /^ *([0-9]+):.* ([^ ]+)$/);
		let masks = m ? spec[m[2]] : null;
		if (!masks)
			continue;
		let n = seen[m[2]] ?? 0;
		seen[m[2]] = n + 1;
		if (masks[n] != null)
			core.knob(sprintf("/proc/irq/%s/smp_affinity", m[1]), masks[n]);
	}
}

function aql(limits) {
	for (let f in fs.glob("/sys/kernel/debug/ieee80211/phy*/aql_txq_limit")) {
		if (core.is_dry())
			continue;
		for (let ac, lim in limits)
			fs.writefile(f, sprintf("%s %d %d", ac, lim[0], lim[1]));
	}
}

// --- shaper ----------------------------------------------------------------

// HTB at `rate` Mbit with fq_codel underneath, or nothing when rate is 0.
// Returns true when it changed something.
function shape(dev, rate) {
	let have = core.sh("tc qdisc show dev " + dev).out, ours = index(have, "htb") >= 0;
	if (rate <= 0) {
		if (ours)
			core.act(sprintf("tc qdisc del dev %s root", dev));
		return ours;
	}
	if (ours && index(core.sh("tc class show dev " + dev).out, sprintf("rate %dMbit", rate)) >= 0)
		return false;
	let leaf = sprintf("tc qdisc add dev %s parent 1:10 handle 10: fq_codel", dev);
	core.act(join("\n", [
		sprintf("tc qdisc del dev %s root 2>/dev/null", dev),
		sprintf("tc qdisc add dev %s root handle 1: htb default 10", dev),
		sprintf("tc class add dev %s parent 1: classid 1:10 htb rate %dmbit ceil %dmbit quantum 1514", dev, rate, rate),
		// 100 Mbit x 20 ms is about 250 kB; the default 4 MB is a lag reservoir.
		sprintf("%s limit 1000 target 5ms interval 100ms memory_limit 250000 noecn || %s noecn || %s", leaf, leaf, leaf),
	]));
	return true;
}

// On a 10/100 uplink the copper is the bottleneck in both directions, and
// whoever owns the queue in front of a bottleneck owns the latency.
//   up    shape the uplink port itself, just below the wire rate.
//   down  the queue would form in the switch upstream, which we cannot
//         manage. Shaping what we forward on to the LAN a little below the
//         wire rate makes senders slow down before that queue fills, and
//         puts the queue that is left under fq_codel here. There is no ifb
//         on this image; a single LAN bridge makes its egress the same thing.
// A faster uplink is not the bottleneck: leave both alone.
function shaper(cfg, lan) {
	let dev = cfg.device, sys = "/sys/class/net/" + dev;
	if (!fs.stat(sys))
		return;
	let speed = int(core.read(sys + "/speed") ?? "0");
	let slow = cfg.mode != "off" && (speed == 10 || speed == 100);
	let up = slow ? max(1, int(speed * cfg.pct / 100)) : 0;
	let down = slow && cfg.pct_down > 0 ? max(1, int(speed * cfg.pct_down / 100)) : 0;
	if (shape(dev, up) && up) {
		core.act(sprintf("ip link set dev %s txqueuelen 128", dev));
		core.event("SHAPER %s up %d Mbit (phy %d)", dev, up, speed);
	}
	if (shape(lan, down) && down)
		core.event("SHAPER %s down %d Mbit (phy %d)", lan, down, speed);
	if (!slow && speed > 100 && !match(core.sh("tc qdisc show dev " + dev).out, /fq_codel/))
		core.act(sprintf("tc qdisc replace dev %s root fq_codel noecn", dev));
}

// --- entry point -----------------------------------------------------------

export function apply(ctx) {
	let cfg = ctx.cfg, spec = core.load_json(PROVISION, {});
	let devs = uniq([ "eth0", ...cfg.main.lan_dev, ...map(ctx.strands, (s) => s.dev) ]);
	for (let dev in devs) {
		if (!(dev in ctx.facts.links))
			continue;
		steer(dev);
		if (!cfg.main.ipv6)
			core.knob(sprintf("/proc/sys/net/ipv6/conf/%s/disable_ipv6", dev), 1);
	}
	irq_affinity(spec.irq_affinity ?? {});
	if (ctx.boot)
		aql(spec.aql_txq_limit ?? {});
	shaper(cfg.shaper, cfg.main.lan_dev[0]);
};

export function conntrack() {
	return {
		count: int(core.read("/proc/sys/net/netfilter/nf_conntrack_count") ?? "0"),
		max: int(core.read("/proc/sys/net/netfilter/nf_conntrack_max") ?? "0"),
	};
};

export function load() {
	return +split(core.read("/proc/loadavg") ?? "0", " ")[0];
};

export function mem_available_kb() {
	let m = match(fs.readfile("/proc/meminfo") ?? "", /MemAvailable: +([0-9]+)/);
	return m ? int(m[1]) : 0;
};
