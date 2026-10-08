// Wi-Fi keep-alive for the LAN side.
//
//   guard     both APs gone, or the radio's survey counters frozen -> reload,
//             after three strikes and at most once per ten minutes
//   sta_role  the backup client radio runs only while the copper is unplugged
//             (AP + STA on one mt76 radio hangs the firmware)

import * as fs from "fs";
import { cursor } from "uci";
import * as core from "../lib/core.uc";
import * as facts from "../lib/facts.uc";

const STRIKES = 3;
const RECOVER_GAP = 600;
const SURVEY_FLOOR = 20000;

// True when the AP is up and forwarding inside the LAN bridge.
export function ap_forwarding(dev) {
	let sys = "/sys/class/net/" + dev;
	return core.read(sys + "/brport/state") == "3" && core.read(sys + "/operstate") == "up";
};

// "channel active time" of the channel in use. A value that stops moving
// means the radio firmware has hung even though the interface looks up.
function active_time(dev) {
	let in_use = false;
	for (let line in split(core.sh("iw dev " + dev + " survey dump").out, "\n")) {
		if (index(line, "[in use]") >= 0)
			in_use = true;
		let m = in_use ? match(line, /channel active time:\s+([0-9]+)/) : null;
		if (m)
			return int(m[1]);
	}
	return null;
}

function guard(ctx) {
	let cfg = ctx.cfg.wifi, st = (ctx.st.wifi ??= { strikes: 0, recovered: 0, active: {} });
	if (!cfg.guard || !length(cfg.ap))
		return;
	let up = 0, frozen = false;
	for (let dev in cfg.ap) {
		if (ap_forwarding(dev))
			up++;
		let t = active_time(dev), prev = st.active[dev];
		if (t != null) {
			if (t == prev && t > SURVEY_FLOOR)
				frozen = true;
			st.active[dev] = t;
		}
	}
	let reason = up == 0 ? (frozen ? "survey_frozen" : "ap_down") : null;
	if (!reason) {
		st.strikes = 0;
		return;
	}
	if (++st.strikes < STRIKES || ctx.now - st.recovered < RECOVER_GAP)
		return;
	st.strikes = 0;
	st.recovered = ctx.now;
	core.event("WIFI recover %s", reason);
	core.act("wifi reload");
}

function sta_role(ctx) {
	let section = ctx.cfg.wifi.backup_sta, uplink = ctx.cfg.sqm.device;
	let uci = cursor();
	if (!length(section) || uci.get("wireless", section) == null)
		return;
	let want = facts.carrier(uplink) ? "1" : "0";
	if ((uci.get("wireless", section, "disabled") ?? "0") == want)
		return;
	core.event("WIFI backup sta %s (copper %s)", want == "1" ? "off" : "on", want == "1" ? "up" : "down");
	if (core.is_dry())
		return;
	uci.set("wireless", section, "disabled", want);
	uci.commit("wireless");
	core.act("wifi reload " + (uci.get("wireless", section, "device") ?? ""));
}

export function apply(ctx) {
	sta_role(ctx);
	// The first minutes after boot the APs are still settling; a reload then
	// only makes it worse.
	if (ctx.facts.uptime >= ctx.cfg.main.boot_grace)
		guard(ctx);
};
