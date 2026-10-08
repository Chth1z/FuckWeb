#!/bin/sh
# Adapter: single default route. No identity marks, no harvest.
# DNS/split/proxy keep working. Switch here with DATAPATH=plain.

. /usr/lib/hotel/common.sh

cmd="${1:-apply}"

teardown() {
	wipe_fwmark
	nft delete table inet hotel 2>/dev/null || true
	rm -f "$HOTEL_STATE" /tmp/hotel-policy.ok "$HOTEL_SLOTS" "$HOTEL_DIR/hash.marks"
	hotel_log DATAPATH_PLAIN_OFF
}

if [ "$cmd" = "egress" ]; then
	exit 0
fi
if [ "$cmd" = "teardown" ]; then
	teardown
	exit 0
fi

LOCK=/var/run/hotel-datapath.lock
exec 9>"$LOCK"
flock -n 9 || exit 0
hotel_dirs

CORE="plain none"
OLD=$(cat "$HOTEL_STATE" 2>/dev/null || true)
if [ "$CORE" = "$OLD" ] && nft list table inet hotel >/dev/null 2>&1; then
	echo UNCHANGED VER=plain
	exit 0
fi

wipe_fwmark
nft delete table inet hotel 2>/dev/null || true
nft -f - <<EOF || { echo NFT_FAIL; hotel_log NFT_FAIL; exit 1; }
table inet hotel {
	chain in {
		type filter hook input priority -160; policy accept;
		iifname $LANIIF accept
		iifname "lo" accept
		ct state established,related accept
		udp dport { 67, 68 } accept
		ip protocol icmp accept
		tcp dport { 53, 80, 443, 9090, 61235 } drop
		udp dport { 53, 853, 61235 } drop
		tcp dport 853 drop
	}
	chain fw {
		type filter hook forward priority 0; policy accept;
		iifname $LANIIF tcp flags syn tcp option maxseg size set $MSS
	}
}
EOF

echo "$CORE" > "$HOTEL_STATE"
echo "plain" > /tmp/hotel-policy.ok
: > "$HOTEL_SLOTS"
hotel_log DATAPATH_PLAIN
echo REBUILT VER=plain
/usr/sbin/hotel-split.sh >/dev/null 2>&1 || true
/usr/sbin/hotel-proxy.sh hook >/dev/null 2>&1 || true
exit 0
