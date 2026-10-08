#!/bin/sh
nft delete table inet hotel 2>/dev/null || true
rm -f /tmp/hotel-online /tmp/hotel-policy.ok /tmp/hotel-slots.prev
pref=90
while [ "$pref" -le 250 ]; do
	ip rule del pref "$pref" 2>/dev/null || true
	pref=$((pref + 1))
done
old=201
while [ "$old" -le 250 ]; do
	ip route flush table "$old" 2>/dev/null || true
	old=$((old + 1))
done
ip route replace default via 192.168.128.1 dev wan 2>/dev/null || true
logger -t hotel "PANIC: single-line mode on wan"
echo "$(date +%s) PANIC_WAN" >> /tmp/hotel/events.log 2>/dev/null || true
echo PANIC_WAN
[ -x /usr/sbin/hotel-led.sh ] && /usr/sbin/hotel-led.sh >/dev/null 2>&1 || true
exit 0
