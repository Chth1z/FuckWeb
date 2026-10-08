#!/bin/sh
# Generic stack: cnip whitelist + leak hijack. Remainder tproxy lives in hotel-proxy.
# Does not own harvest. Datapath must not delete this table.

. /usr/lib/hotel/common.sh
hotel_dirs

SRC=/etc/hotel/direct4.nft

ensure_table() {
	nft list table inet "$1" >/dev/null 2>&1 || nft add table inet "$1"
}

ensure_set() {
	tbl="$1"
	name="$2"
	spec="$3"
	nft list set inet "$tbl" "$name" >/dev/null 2>&1 || \
		nft add set inet "$tbl" "$name" "$spec"
}

load_direct4() {
	[ -f "$SRC" ] || return 1
	hdr=$(nft list set inet hotel_split direct4 2>/dev/null | head -n 12)
	retp=0
	if echo "$hdr" | grep -Eq 'timeout [0-9]'; then
		nft delete chain inet hotel_split tproxy_pre 2>/dev/null || true
		nft delete set inet hotel_split direct4 2>/dev/null || true
		rm -f /tmp/hotel/direct4.hotel_split.bytes
		retp=1
	fi
	ensure_set hotel_split direct4 '{ type ipv4_addr; flags interval; }' || return 1
	mark=$(wc -c < "$SRC")
	mark=$(echo "$mark" | tr -d ' ')
	stamp=/tmp/hotel/direct4.hotel_split.bytes
	old=$(cat "$stamp" 2>/dev/null || echo 0)
	if [ "$mark" = "$old" ] && nft get element inet hotel_split direct4 '{ 1.0.1.0/24 }' >/dev/null 2>&1; then
		[ "$retp" = 1 ] && /usr/sbin/hotel-proxy.sh hook >/dev/null 2>&1 || true
		return 0
	fi
	nft -f "$SRC" || return 1
	echo "$mark" > "$stamp"
	[ "$retp" = 1 ] && /usr/sbin/hotel-proxy.sh hook >/dev/null 2>&1 || true
}

install_leak() {
	if ! nft list chain inet hotel_split dns_hijack >/dev/null 2>&1; then
		nft delete chain inet hotel_split dns_hijack 2>/dev/null || true
		nft -f - <<EOF
table inet hotel_split {
	chain dns_hijack {
		type nat hook prerouting priority dstnat; policy accept;
		iifname != $LANIIF return
		meta l4proto { tcp, udp } th dport { 53, 853 } redirect to :53
	}
}
EOF
	fi
	# Reject (not drop) so Happy Eyeballs immediately falls back to IPv4.
	nft delete chain inet hotel_split v6_fwd 2>/dev/null || true
	nft -f - <<EOF
table inet hotel_split {
	chain v6_fwd {
		type filter hook forward priority 0; policy accept;
		iifname != $LANIIF return
		meta nfproto ipv6 reject with icmpv6 admin-prohibited
	}
}
EOF
}

ensure_table hotel_split
ensure_set hotel_split node4 '{ type ipv4_addr; }'
ensure_set hotel_split direct4 '{ type ipv4_addr; flags interval; }'
if ! nft list set inet hotel_split claude4 >/dev/null 2>&1; then
	nft add set inet hotel_split claude4 '{ type ipv4_addr; flags timeout; timeout 3600s; }' \
		|| nft add set inet hotel_split claude4 '{ type ipv4_addr; }' \
		|| true
fi
load_direct4
install_leak
exit 0
