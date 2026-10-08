// Two RGB LEDs, two questions.
//   status   how many uplink legs carry traffic
//   network  is the LAN side (APs, stack) healthy
// Kept apart on purpose: a full set of legs must not hide a dead AP.

import * as fs from "fs";
import * as core from "../lib/core.uc";

const COLORS = {
	green: "20 200 70",
	yellow: "200 160 10",
	orange: "220 90 10",
	red: "220 20 20",
	dim: "10 80 30",
};

function show(led, color, brightness) {
	let sys = "/sys/class/leds/" + led;
	if (!length(led) || !fs.stat(sys) || core.is_dry())
		return;
	fs.writefile(sys + "/trigger", "none");
	fs.writefile(sys + "/multi_intensity", COLORS[color]);
	fs.writefile(sys + "/brightness", "" + brightness);
}

export function apply(ctx, report) {
	let cfg = ctx.cfg.led, n = length(ctx.uplink.healthy);
	let hour = localtime().hour;
	let bright = hour < 7 ? 40 : 180;

	let status = "red";
	if (ctx.cfg.uplink.mode != "multi")
		status = n ? "green" : "red";
	else if (n >= cfg.green)
		status = "green";
	else if (n >= cfg.yellow)
		status = "yellow";
	else if (n >= 1)
		status = "orange";
	show(cfg.status, status, bright);

	let failed = map(filter(report.checks, (c) => !c.ok && c.level == "fail"), (c) => c.id);
	let ap_dead = length(filter(failed, (id) => index(id, "ap:") == 0)) > 0;
	if (ap_dead)
		show(cfg.network, "red", bright);
	else if (length(failed))
		show(cfg.network, "orange", bright);
	else
		show(cfg.network, "dim", int(bright / 3));
	return status;
};
