#!/bin/sh
# Shared helpers. Datapath-specific algo lives in datapath/ecmp10.sh.

HOTEL_DIR=/tmp/hotel
HOTEL_STATE=/tmp/hotel-online
HOTEL_SLOTS=/tmp/hotel-slots
CODEFILE=/etc/hotel-portal.code
POLICY_FILE=/etc/hotel/policy
LANIIF='{ "br-lan", "lan1", "lan2", "lan3", "lan4", "phy0-ap0", "phy1-ap0" }'

[ -f "$POLICY_FILE" ] && . "$POLICY_FILE"

: "${DATAPATH:=ecmp10}"
: "${POLICY_VER:=ecmp10}"
: "${SPLIT_REMAINDER:=proxy}"
: "${NSLOTS:=42}"
: "${AUTH_BATCH:=4}"
: "${FAIL_KEEP:=2}"
: "${PARK_FAILS:=8}"
: "${PARK_SEC:=1800}"
: "${MSS:=1440}"
: "${UPLINK_MBYTES:=0}"
: "${MARK_PREF:=90}"
: "${FROM_PREF:=200}"
: "${ETH_VWANS:=20}"
: "${PROBE_URL:=http://www.baidu.com}"
: "${PROBE_TIMEOUT:=3}"
: "${PROBE_OK_SEC:=180}"
: "${SCORE_EWMA:=0.3}"
: "${WAN_SQM:=auto}"
: "${WAN_SQM_PCT:=95}"
: "${ADS_ENABLE:=1}"
: "${SMARTDNS_PORT:=6053}"
: "${SMARTDNS_CONF:=/tmp/hotel/smartdns.conf}"
: "${DNSMASQ_CACHE:=0}"
: "${TPROXY_MARK:=16384}"
: "${TPROXY_TBL:=100}"
: "${TPROXY_PREF:=50}"
: "${TPROXY_LISTEN:=198.51.100.1}"
: "${TPROXY_PORT:=61235}"
: "${MIXED_PORT:=7890}"
: "${CANARY_FAILS:=3}"
: "${CANARY_GRACE:=90}"
: "${CANARY_TIMEOUT:=5000}"
: "${CANARY_URL:=https://cp.cloudflare.com/generate_204}"
: "${HOTEL_BOOT_GRACE:=180}"

hotel_dirs() {
	mkdir -p "$HOTEL_DIR"
}

proxy_running() {
	pidof mihomo >/dev/null 2>&1
}

hotel_uptime() {
	awk '{printf "%d", $1+0}' /proc/uptime 2>/dev/null || echo 0
}

hotel_boot_grace() {
	u=$(hotel_uptime)
	[ "$u" -lt "${HOTEL_BOOT_GRACE:-180}" ]
}

hotel_ap_fwd() {
	dev="$1"
	[ -d "/sys/class/net/$dev" ] || return 1
	[ -d "/sys/class/net/br-lan/brif/$dev" ] || return 1
	st=$(cat "/sys/class/net/$dev/brport/state" 2>/dev/null || echo 0)
	op=$(cat "/sys/class/net/$dev/operstate" 2>/dev/null || echo down)
	[ "$st" = 3 ] && [ "$op" = up ]
}

hotel_wan_carrier() {
	cat /sys/class/net/wan/carrier 2>/dev/null || echo 0
}

hotel_hash_count() {
	if [ -f "$HOTEL_DIR/hash.marks" ]; then
		wc -w < "$HOTEL_DIR/hash.marks" | tr -d ' \t'
		return 0
	fi
	state=$(cat "$HOTEL_STATE" 2>/dev/null || true)
	[ -n "$state" ] || { echo 0; return 0; }
	echo "$state" | awk '{n=0; for(i=3;i<=NF;i++) if($i ~ /^[0-9]+$/) n++; print n+0}'
}

hotel_datapath_busy() {
	[ -f /tmp/hotel-burst ] && return 0
	busy="$HOTEL_DIR/datapath.busy"
	[ -f "$busy" ] || return 1
	now=$(date +%s)
	ts=$(cat "$busy" 2>/dev/null || echo 0)
	[ $((now - ts)) -lt 45 ]
}

hotel_secure_files() {
	chmod 600 /etc/hotel/clash.secret 2>/dev/null || true
	chmod 600 /etc/hotel-portal.code 2>/dev/null || true
	chmod 600 /etc/hotel/proxy-nodes.json 2>/dev/null || true
	chmod 600 /etc/hotel/mihomo.yaml 2>/dev/null || true
}

hotel_log() {
	hotel_dirs
	msg=$(echo "$*" | sed 's/secret=[^&[:space:]]*/secret=REDACTED/g')
	echo "$(date +%s) $msg" >> "$HOTEL_DIR/events.log"
	logger -t hotel "$msg"
	sz=$(wc -c < "$HOTEL_DIR/events.log" 2>/dev/null || echo 0)
	if [ "$sz" -gt 400000 ]; then
		tail -c 200000 "$HOTEL_DIR/events.log" > "$HOTEL_DIR/events.log.new" 2>/dev/null
		mv "$HOTEL_DIR/events.log.new" "$HOTEL_DIR/events.log"
	fi
}

is_eth() {
	case "$1" in
		wan|vwan*) return 0 ;;
		*) return 1 ;;
	esac
}

eth_mark() {
	dev="$1"
	if [ "$dev" = "wan" ]; then
		echo 1
		return
	fi
	case "$dev" in
		vwan*) echo $((${dev#vwan} + 1)) ;;
		*) echo 0 ;;
	esac
}

sta_mark() {
	dev="$1"
	case "$dev" in
		phy0-sta*) echo 40 ;;
		phy1-sta*) echo $((41 + ${dev#phy1-sta})) ;;
		*) echo 0 ;;
	esac
}

leg_mark() {
	if is_eth "$1"; then
		eth_mark "$1"
	else
		sta_mark "$1"
	fi
}

leg_tbl() {
	echo $((200 + $(leg_mark "$1")))
}

arp_leg() {
	dev="$1"
	stamp="$HOTEL_DIR/arp.$dev"
	[ -f "$stamp" ] && return 0
	sysctl -qw "net.ipv4.conf.${dev}.arp_ignore=1" 2>/dev/null || true
	sysctl -qw "net.ipv4.conf.${dev}.arp_announce=2" 2>/dev/null || true
	sysctl -qw "net.ipv4.conf.${dev}.arp_filter=1" 2>/dev/null || true
	sysctl -qw "net.ipv4.conf.${dev}.rp_filter=0" 2>/dev/null || true
	hotel_dirs
	echo 1 > "$stamp"
}

wipe_fwmark() {
	pref=90
	while [ "$pref" -le 250 ]; do
		ip rule del pref "$pref" 2>/dev/null || true
		pref=$((pref + 1))
	done
}

hotel_ip4_cache() {
	ip -4 -o addr show > "$HOTEL_DIR/ip4"
}

ip4_of() {
	awk -v d="$1" '$2 == d { split($4, a, "/"); print a[1]; exit }' "$HOTEL_DIR/ip4" 2>/dev/null
}

eth_dev_list() {
	devs="wan"
	n=1
	while [ "$n" -le "$ETH_VWANS" ]; do
		devs="$devs vwan$n"
		n=$((n + 1))
	done
	echo "$devs"
}

sta_dev_list() {
	out=""
	for d in /sys/class/net/phy*-sta*; do
		[ -e "$d" ] || continue
		out="$out ${d##*/}"
	done
	echo "$out"
}

hotel_rotate_file() {
	path="$1"
	max="${2:-1500000}"
	keep="${3:-700000}"
	[ -f "$path" ] || return 0
	sz=$(wc -c < "$path" 2>/dev/null || echo 0)
	[ "$sz" -gt "$max" ] || return 0
	tail -c "$keep" "$path" > "$path.new" 2>/dev/null && mv "$path.new" "$path"
}

hotel_jsonl() {
	path="$1"
	line="$2"
	hotel_dirs
	echo "$line" >> "$path"
	hotel_rotate_file "$path"
}

has_gua() {
	ip -6 -o addr show scope global 2>/dev/null | grep -q 'inet6' && return 0
	return 1
}

. /usr/lib/hotel/datapath.sh
