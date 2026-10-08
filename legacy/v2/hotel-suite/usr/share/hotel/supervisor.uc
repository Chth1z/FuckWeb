// The only long-lived piece. It holds no state and makes no decisions: it
// runs `hotel tick` on a timer and when something asks for one (SIGUSR1 from
// `hotel kick`, which procd sends on interface and config events).
//
// Each tick is a fresh process, so a bug in the reconciler can never wedge
// or leak into the scheduler, and ticks never overlap.

import * as uloop from "uloop";
import { cursor } from "uci";

const HOTEL = "/usr/sbin/hotel";
const DEBOUNCE_MS = 2000;

let period = (int(cursor().get("hotel", "main", "tick")) || 60) * 1000;
let running = false, again = false, first = true;
let kick;

function tick() {
	if (running) {
		again = true;
		return;
	}
	running = true;
	let args = first ? [ "tick", "--boot" ] : [ "tick" ];
	first = false;
	uloop.process(HOTEL, args, {}, () => {
		running = false;
		if (again) {
			again = false;
			kick.set(DEBOUNCE_MS);
		}
	});
}

uloop.init();
kick = uloop.timer(1, tick);
uloop.interval(period, tick);
// A burst of events (21 legs renewing at once) collapses into one tick.
uloop.signal("USR1", () => kick.set(DEBOUNCE_MS));
uloop.signal("TERM", () => uloop.end());
uloop.run();
