// Host tuning that is not datapath: one-time provisioning of UCI defaults,
// per-device steering, IPv6 off, IRQ affinity and the uplink shaper.

import * as fs from "fs";
import { abs } from "math";
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

// All three classes borrow to line rate. Size HTB credit for four ms at the
// aggregate rate and fq_codel memory for this swapless board.
export function shape(dev, rate) {
	let tcdev = " dev " + core.shq(dev);
	let q = json(core.sh("tc -j qdisc show" + tcdev).out);
	let root = filter(q, (x) => x.root)[0];
	let ours = root?.kind == "htb" && root.handle == "1:";
	if (rate <= 0) {
		if (ours)
			assert(core.act("tc qdisc del" + tcdev + " root"), "cannot remove shaper on " + dev);
		return ours;
	}

	let kbit = rate * 1000, burst = max(3000, rate * 500);
	let bands = [
		{ id: "10", pct: 20, target: 2, limit: 512, mem: 2097152 },
		{ id: "20", pct: 50, target: 5, limit: 1024, mem: 4194304 },
		{ id: "30", pct: 30, target: 5, limit: 1024, mem: 4194304 },
	];
	let classes = {}, leaves = {};
	if (ours) {
		for (let c in json(core.sh("tc -d -j class show" + tcdev + " parent 1:").out))
			classes[c.handle] = c;
		for (let x in q)
			leaves[x.parent] = x;
	}
	let cmds = [];
	if (!ours || root.options.default != "0x20")
		push(cmds, "tc qdisc replace" + tcdev + " root handle 1: htb default 20");
	let class_cmd = (id, parent, kb, suffix, prio) => {
		let c = classes[id];
		// tc converts burst to kernel ticks and rounds the byte count on dump.
		if (!c || c.rate != kb * 125 || c.ceil != kbit * 125 || abs(c.burst - burst) > 16 ||
		    abs(c.cburst - burst) > 16 || (prio != null && (c.prio != prio || c.quantum != 1514)))
			push(cmds, sprintf("tc class replace%s parent %s classid %s htb rate %dkbit ceil %dkbit burst %d cburst %d%s",
				tcdev, parent, id, kb, kbit, burst, burst, suffix));
	};
	class_cmd("1:1", "1:", kbit, "", null);
	for (let i, b in bands) {
		let id = "1:" + b.id, leaf = leaves[id], o = leaf?.options;
		class_cmd(id, "1:1", kbit * b.pct / 100, " prio " + i + " quantum 1514", i);
		if (leaf?.kind != "fq_codel" || o.limit != b.limit || o.memory_limit != b.mem ||
		    o.quantum != 1514 || abs(o.target - b.target * 1000) > 1 || abs(o.interval - 100000) > 1 || o.ecn)
			push(cmds, sprintf("tc qdisc replace%s parent %s handle %s: fq_codel limit %d target %dms interval 100ms quantum 1514 memory_limit %d noecn",
				tcdev, id, b.id, b.limit, b.target, b.mem));
	}
	if (!length(cmds))
		return false;
	assert(core.act(join(" &&\n", cmds)), "shaper update failed on " + dev);
	return true;
};

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
		core.act(sprintf("ip link set dev %s txqueuelen 128", core.shq(dev)));
		core.event("SHAPER %s up %d Mbit (phy %d)", dev, up, speed);
	}
	if (shape(lan, down) && down)
		core.event("SHAPER %s down %d Mbit (phy %d)", lan, down, speed);
	if (!slow && speed > 100) {
		let qout = core.sh("tc qdisc show dev " + core.shq(dev)).out;
		if (index(qout, "htb") >= 0 || !match(qout, /fq_codel/))
			core.act(sprintf("tc qdisc replace dev %s root fq_codel noecn", core.shq(dev)));
	}
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

export function loadavg() {
	let p = split(core.read("/proc/loadavg") ?? "0 0 0", " ");
	return {
		load1: +(p[0] ?? 0),
		load5: +(p[1] ?? 0),
		load15: +(p[2] ?? 0),
	};
};

export function load() {
	return loadavg().load1;
};

export function mem_info() {
	let raw = fs.readfile("/proc/meminfo") ?? "";
	let get_kb = (name) => {
		let m = match(raw, regexp(name + ": +([0-9]+)"));
		return m ? int(m[1]) : 0;
	};
	return {
		total_kb: get_kb("MemTotal"),
		free_kb: get_kb("MemFree"),
		available_kb: get_kb("MemAvailable"),
		cached_kb: get_kb("Cached"),
	};
};

export function mem_available_kb() {
	return mem_info().available_kb;
};

export function cpu_sample() {
	let line = split(fs.readfile("/proc/stat") ?? "", "\n")[0] ?? "";
	let p = split(trim(line), / +/);
	if (p[0] != "cpu" || length(p) < 8)
		return null;
	let user = int(p[1]), nice = int(p[2]), sys = int(p[3]), idle = int(p[4]);
	let iowait = int(p[5]), irq = int(p[6]), softirq = int(p[7]), steal = int(p[8] ?? "0");
	return {
		total: user + nice + sys + idle + iowait + irq + softirq + steal,
		idle: idle + iowait,
		softirq,
		iowait,
	};
};

export function temp_c() {
	let fallback = null;
	for (let z in fs.glob("/sys/class/thermal/thermal_zone*")) {
		let raw = core.read(z + "/temp");
		if (raw == null || !length(raw))
			continue;
		let v = int(raw);
		if (v <= 0)
			continue;
		let c = +(sprintf("%.1f", v > 1000 ? v / 1000.0 : v * 1.0));
		let kind = core.read(z + "/type") ?? "";
		if (index(lc(kind), "cpu") >= 0)
			return c;
		fallback ??= c;
	}
	return fallback;
};

export function wan_stats(dev) {
	if (!length(dev))
		return null;
	let base = "/sys/class/net/" + dev;
	if (!fs.stat(base))
		return null;
	let stat_num = (f) => int(core.read(base + "/statistics/" + f) ?? "0");
	let speed = int(core.read(base + "/speed") ?? "-1");
	return {
		dev,
		carrier: core.read(base + "/carrier") == "1",
		speed: speed > 0 ? speed : 0,
		carrier_changes: int(core.read(base + "/carrier_changes") ?? "0"),
		rx_errors: stat_num("rx_errors"),
		tx_errors: stat_num("tx_errors"),
		rx_dropped: stat_num("rx_dropped"),
		tx_dropped: stat_num("tx_dropped"),
	};
};
