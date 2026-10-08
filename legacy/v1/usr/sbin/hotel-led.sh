#!/bin/sh
# RGB status from hash health. Night dim. Does not touch datapath.

. /usr/lib/hotel/common.sh
hotel_dirs

set_rgb() {
	led="$1"
	r="$2"; g="$3"; b="$4"; br="$5"
	[ -d "/sys/class/leds/$led" ] || return 0
	echo none > "/sys/class/leds/$led/trigger" 2>/dev/null || true
	echo "$r $g $b" > "/sys/class/leds/$led/multi_intensity" 2>/dev/null || true
	echo "$br" > "/sys/class/leds/$led/brightness" 2>/dev/null || true
}

n_hash=$(hotel_hash_count)
[ "$n_hash" -lt 0 ] && n_hash=0

hour=$(date +%H)
br=180
[ "$hour" -ge 0 ] && [ "$hour" -lt 7 ] && br=40

color=red
burst_age=9999
if [ -f /tmp/hotel-burst ]; then
	now=$(date +%s)
	mt=$(date -r /tmp/hotel-burst +%s 2>/dev/null || echo 0)
	burst_age=$((now - mt))
fi
if [ "$burst_age" -lt 30 ]; then
	color=orange
elif [ "$n_hash" -ge 18 ]; then
	color=green
elif [ "$n_hash" -ge 8 ]; then
	color=yellow
elif [ "$n_hash" -ge 1 ]; then
	color=orange
else
	color=red
fi

case "$color" in
	green)  set_rgb rgb:status 20 200 70 "$br" ;;
	yellow) set_rgb rgb:status 200 160 10 "$br" ;;
	orange) set_rgb rgb:status 220 90 10 "$br" ;;
	red)    set_rgb rgb:status 220 20 20 "$br" ;;
esac
# rgb:network is Wi-Fi + stack, not harvest. Green harvest + red network
# is how a dead AP used to hide behind 21 MAC marks.
net_bad=0
hotel_ap_fwd phy0-ap0 || net_bad=1
hotel_ap_fwd phy1-ap0 || net_bad=1
stack_bad=0
[ -f "$HOTEL_DIR/doctor.json" ] && grep -q '"ok":0,' "$HOTEL_DIR/doctor.json" 2>/dev/null && stack_bad=1
if [ "$net_bad" = 1 ]; then
	set_rgb rgb:network 220 20 20 "$br"
elif [ "$stack_bad" = 1 ]; then
	set_rgb rgb:network 220 90 10 "$br"
else
	set_rgb rgb:network 10 80 30 $((br / 3))
fi
echo "$color $n_hash" > "$HOTEL_DIR/led"
hotel_dirs
exit 0
