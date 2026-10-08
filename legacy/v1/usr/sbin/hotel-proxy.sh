#!/bin/sh
# mihomo: nft classifies; SmartDNS is the DNS brain; 5553 is dumb DNS via PROXY.

. /usr/lib/hotel/common.sh
hotel_dirs

BIN_GZ=/usr/share/hotel/mihomo.gz
BIN=/tmp/hotel/mihomo
CONF=/etc/hotel/mihomo.yaml
MARK=${TPROXY_MARK:-16384}
TBL=${TPROXY_TBL:-100}
PREF=${TPROXY_PREF:-50}
LISTEN=${TPROXY_LISTEN:-198.51.100.1}
TPORT=${TPROXY_PORT:-61235}
UI_PORT=${CLASH_API_PORT:-9090}
MIXED=${MIXED_PORT:-7890}
SAFE_PATHS=/etc/hotel:/tmp/hotel:/www

has_nodes() {
	[ -f /etc/hotel/proxy-nodes.json ] || return 1
	lua -e '
		local ok, j = pcall(require, "luci.jsonc")
		if not ok then ok, j = pcall(require, "cjson") end
		if not ok then os.exit(1) end
		local f = io.open("/etc/hotel/proxy-nodes.json")
		if not f then os.exit(1) end
		local raw = f:read("*a"); f:close()
		local t
		if j.parse then t = j.parse(raw) else t = j.decode(raw) end
		t = t or {}
		if type(t) == "table" and t.outbounds then t = t.outbounds end
		local n = 0
		if type(t) == "table" then
			for _, v in ipairs(t) do
				if type(v) == "table" and v.tag and v.type then n = n + 1 end
			end
		end
		os.exit(n > 0 and 0 or 1)
	'
}

lan_ip() {
	ip=$(uci -q get network.lan.ipaddr)
	ip=${ip%%/*}
	[ -n "$ip" ] || ip=192.168.16.1
	echo "$ip" > "$HOTEL_DIR/lan.ip"
	echo "$ip"
}

ensure_secret() {
	if [ ! -s /etc/hotel/clash.secret ]; then
		tr -dc 'A-Za-z0-9' </dev/urandom 2>/dev/null | head -c 20 > /etc/hotel/clash.secret
	fi
	chmod 600 /etc/hotel/clash.secret 2>/dev/null || true
}

extract_bin() {
	need=1
	if [ -x "$BIN" ] && "$BIN" -v >/dev/null 2>&1; then
		need=0
	fi
	[ "$need" = 0 ] && return 0
	[ -f "$BIN_GZ" ] || { echo "NO_MIHOMO_GZ"; return 1; }
	rm -f "$BIN"
	gzip -dc "$BIN_GZ" > "$BIN" || busybox gzip -dc "$BIN_GZ" > "$BIN" || {
		rm -f "$BIN"
		echo GZIP_FAIL
		return 1
	}
	chmod 755 "$BIN"
	"$BIN" -v >/dev/null 2>&1 || { echo MIHOMO_BIN_BAD; rm -f "$BIN"; return 1; }
}

append_node_ip() {
	ip="$1"
	echo "$ip" | grep -Eq '^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$' || return 0
	echo "$ip" | grep -Eq '^127\.|^0\.|^255\.|^198\.18\.' && return 0
	els="$els $ip,"
}

resolve_node_host() {
	host="$1"
	[ -n "$host" ] || return 0
	echo "$host" | grep -Eq '^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$' && {
		append_node_ip "$host"
		return 0
	}
	ips=""
	if command -v resolveip >/dev/null 2>&1; then
		ips=$(resolveip -4 "$host" 2>/dev/null || true)
	fi
	if [ -z "$ips" ]; then
		ips=$(nslookup "$host" 127.0.0.1 2>/dev/null | awk '/^Address/{print $NF}')
	fi
	for ip in $ips; do
		append_node_ip "$ip"
	done
}

refill_dst() {
	els=""
	if [ -f "$HOTEL_DIR/sb_dst4.ips" ]; then
		while read -r ip; do
			[ -n "$ip" ] || continue
			append_node_ip "$ip"
		done < "$HOTEL_DIR/sb_dst4.ips"
	fi
	if [ -f "$HOTEL_DIR/sb_dst_hosts" ]; then
		while read -r host; do
			[ -n "$host" ] || continue
			resolve_node_host "$host"
		done < "$HOTEL_DIR/sb_dst_hosts"
	fi
	els=$(echo "$els" | sed 's/,$//')
	if nft list set inet hotel_split node4 >/dev/null 2>&1; then
		if [ -n "$els" ]; then
			nft -f - <<EOF
flush set inet hotel_split node4
add element inet hotel_split node4 { $els }
EOF
		else
			nft flush set inet hotel_split node4 2>/dev/null || true
		fi
	fi
	hotel_datapath_egress
}

nft_on() {
	modprobe nft_tproxy >/dev/null 2>&1 || true
	modprobe nf_tproxy_ipv4 >/dev/null 2>&1 || true
	sysctl -qw net.ipv4.conf.lo.rp_filter=0
	ip addr add "$LISTEN/32" dev lo 2>/dev/null || true
	ip rule del pref "$PREF" 2>/dev/null || true
	ip rule add fwmark "$MARK" lookup "$TBL" pref "$PREF"
	ip route replace local default dev lo table "$TBL"
	[ -x /usr/sbin/hotel-split.sh ] && /usr/sbin/hotel-split.sh >/dev/null 2>&1 || true
	nft list set inet hotel_split node4 >/dev/null 2>&1 || \
		nft add set inet hotel_split node4 '{ type ipv4_addr; }'
	if ! nft list set inet hotel_split claude4 >/dev/null 2>&1; then
		nft add set inet hotel_split claude4 '{ type ipv4_addr; flags timeout; timeout 3600s; }' \
			|| nft add set inet hotel_split claude4 '{ type ipv4_addr; }' \
			|| true
	fi
	# Remainder tproxy is public unicast only. Broadcast/multicast (DHCP,
	# mDNS, 255.255.255.255) must never match or Wi-Fi clients get no IP.
	# Claude/Anthropic and NTP are tproxied *before* @direct4 so Cloudflare-CN
	# or Aliyun NTP cannot leak past the proxy.
	priv="10.0.0.0/8, 127.0.0.0/8, 169.254.0.0/16, 172.16.0.0/12, 192.168.0.0/16, 100.64.0.0/10, 224.0.0.0/4, 255.255.255.255"
	rest=""
	if [ "${SPLIT_REMAINDER:-proxy}" = "proxy" ]; then
		rest="		ip daddr != { $priv } meta l4proto { tcp, udp } tproxy ip to $LISTEN:$TPORT meta mark set $MARK"
	fi
	nft delete chain inet hotel_split tproxy_pre 2>/dev/null || true
	nft delete chain inet hotel_split tproxy_in 2>/dev/null || true
	nft delete chain inet hotel_split tproxy_fwd 2>/dev/null || true
	nft delete chain inet hotel_split quic_nat 2>/dev/null || true
	nft delete chain inet hotel_split quic_in 2>/dev/null || true
	nft delete chain inet hotel_split tproxy_dns 2>/dev/null || true
	nft delete set inet hotel_split cf4 2>/dev/null || true
	nft -f - <<EOF
table inet hotel_split {
	set cf4 {
		type ipv4_addr
		flags interval
		elements = {
			1.0.0.1, 1.1.1.1,
			103.21.244.0/22, 103.22.200.0/22, 103.31.4.0/22,
			104.16.0.0/13, 104.24.0.0/14,
			108.162.192.0/18, 131.0.72.0/22, 141.101.64.0/18,
			162.158.0.0/15, 172.64.0.0/13, 173.245.48.0/20,
			188.114.96.0/20, 190.93.240.0/20, 197.234.240.0/22,
			198.41.128.0/17
		}
	}
	chain tproxy_pre {
		type filter hook prerouting priority -100; policy accept;
		iifname != $LANIIF return
		iifname "lo" return
		meta pkttype { broadcast, multicast } return
		fib daddr type { local, broadcast, multicast } return
		udp dport { 67, 68 } return
		ip daddr $LISTEN return
		ip daddr @cf4 meta l4proto { tcp, udp } tproxy ip to $LISTEN:$TPORT meta mark set $MARK
		ip daddr 160.79.104.0/21 meta l4proto { tcp, udp } tproxy ip to $LISTEN:$TPORT meta mark set $MARK
		ip daddr @claude4 meta l4proto { tcp, udp } tproxy ip to $LISTEN:$TPORT meta mark set $MARK
		udp dport 123 ip daddr != { $priv } tproxy ip to $LISTEN:$TPORT meta mark set $MARK
		ip daddr @direct4 return
		ip daddr { $priv } return
		ip daddr @node4 return
$rest
	}
	chain tproxy_in {
		type filter hook input priority -100; policy accept;
		meta mark $MARK accept
		iifname $LANIIF tcp dport $UI_PORT accept
	}
}
EOF
	nft delete set inet hotel_split proxy4 2>/dev/null || true
	nft delete set inet hotel_split resolver4 2>/dev/null || true
	rm -f "$HOTEL_DIR/proxy4.timeout" "$HOTEL_DIR/proxy.list"
	refill_dst
}

nft_off() {
	nft delete chain inet hotel_split tproxy_pre 2>/dev/null || true
	nft delete chain inet hotel_split tproxy_in 2>/dev/null || true
	nft delete chain inet hotel_split tproxy_fwd 2>/dev/null || true
	nft delete chain inet hotel_split quic_nat 2>/dev/null || true
	nft delete chain inet hotel_split quic_in 2>/dev/null || true
	nft delete chain inet hotel_split tproxy_dns 2>/dev/null || true
	nft delete set inet hotel_split cf4 2>/dev/null || true
	nft delete table inet hotel_sb 2>/dev/null || true
	ip rule del pref "$PREF" 2>/dev/null || true
	ip route flush table "$TBL" 2>/dev/null || true
	ip addr del "$LISTEN/32" dev lo 2>/dev/null || true
	nft flush set inet hotel_split node4 2>/dev/null || true
	hotel_datapath_egress
}

write_ui_page() {
	lan=$(lan_ip)
	mkdir -p /www
	ln -sfn /etc/hotel/zashboard /www/zashboard
	cat > /www/hotel-ui.html <<EOF
<!doctype html>
<meta charset="utf-8">
<title>hotel proxy</title>
<meta http-equiv="refresh" content="0;url=http://$lan:$UI_PORT/ui/">
<p><a href="http://$lan:$UI_PORT/ui/">open zashboard</a></p>
EOF
	echo "http://$lan:$UI_PORT/ui/" > "$HOTEL_DIR/ui.url"
	chmod 600 "$HOTEL_DIR/ui.url"
}

wait_listen() {
	n=0
	while [ "$n" -lt 20 ]; do
		netstat -uln 2>/dev/null | grep -q ":$TPORT " && return 0
		netstat -ln 2>/dev/null | grep -q ":$TPORT " && return 0
		n=$((n + 1))
		sleep 1
	done
	return 1
}

prepare() {
	has_nodes || { echo INACTIVE_NO_NODES; return 1; }
	lan_ip >/dev/null
	ensure_secret
	rm -f /tmp/hotel/sing-box
	extract_bin || return 1
	lua /usr/lib/hotel/mihomo-render.lua || return 1
	hotel_secure_files
	SAFE_PATHS="$SAFE_PATHS" "$BIN" -t -d /tmp/hotel -f "$CONF" || { echo MIHOMO_CHECK_FAIL; return 1; }
	ip addr add "$LISTEN/32" dev lo 2>/dev/null || true
	echo 1 > /var/run/hotel-proxy.prepared
	hotel_log "PROXY_PREP listen=$LISTEN:$TPORT mark=$MARK mixed=$MIXED"
	return 0
}

attach() {
	[ -f /var/run/hotel-proxy.prepared ] || return 1
	wait_listen || { echo WAIT_LISTEN_FAIL; return 1; }
	rm -f "$HOTEL_DIR/canary.down" "$HOTEL_DIR/canary.fail"
	date +%s > /var/run/hotel-proxy.started
	nft_on || return 1
	write_ui_page
	echo 1 > /var/run/hotel-proxy.active
	/usr/sbin/hotel-dns.sh apply >/dev/null 2>&1 || true
	hotel_log "PROXY_ON listen=$LISTEN:$TPORT ui=http://$(lan_ip):$UI_PORT/ui/"
	return 0
}

teardown() {
	rm -f /var/run/hotel-proxy.active /var/run/hotel-proxy.prepared
	rm -f "$HOTEL_DIR/canary.down" "$HOTEL_DIR/canary.fail" "$HOTEL_DIR/canary.ok"
	nft_off
	/usr/sbin/hotel-dns.sh apply >/dev/null 2>&1 || true
	hotel_log PROXY_OFF
}

hook() {
	refill_dst
	[ -f /var/run/hotel-proxy.active ] || return 0
	proxy_running || return 0
	[ -f "$HOTEL_DIR/canary.down" ] && return 0
	nft list chain inet hotel_split tproxy_pre >/dev/null 2>&1 || nft_on
}

reload() {
	has_nodes || { echo INACTIVE_NO_NODES; return 1; }
	proxy_running || { echo INACTIVE; return 1; }
	lan_ip >/dev/null
	ensure_secret
	lua /usr/lib/hotel/mihomo-render.lua || return 1
	hotel_secure_files
	SAFE_PATHS="$SAFE_PATHS" "$BIN" -t -d /tmp/hotel -f "$CONF" || { echo MIHOMO_CHECK_FAIL; return 1; }
	lan=$(cat "$HOTEL_DIR/lan.ip")
	secret=$(cat /etc/hotel/clash.secret)
	code=$(curl -4 -m 8 -sS -o /dev/null -w "%{http_code}" \
		-X PUT -H "Authorization: Bearer $secret" \
		-H "Content-Type: application/json" \
		--data '{"path":"/etc/hotel/mihomo.yaml"}' \
		"http://${lan}:9090/configs?force=true" 2>/dev/null || echo 000)
	echo "RELOAD=$code"
	hotel_log "PROXY_RELOAD http=$code"
	[ "$code" = "204" ] || [ "$code" = "200" ]
}

failopen() {
	[ -f /var/run/hotel-proxy.active ] || return 0
	[ -f "$HOTEL_DIR/canary.down" ] && return 0
	echo 1 > "$HOTEL_DIR/canary.down"
	nft_off
	hotel_log PROXY_FAILOPEN
}

cmd="${1:-status}"
case "$cmd" in
	prepare) prepare ;;
	attach) attach ;;
	teardown) teardown ;;
	refill) refill_dst ;;
	hook) hook ;;
	nft-on) nft_on ;;
	nft-off) nft_off ;;
	reload) reload ;;
	failopen) failopen ;;
	start) /etc/init.d/hotel-proxy start ;;
	stop) /etc/init.d/hotel-proxy stop ;;
	status)
		if proxy_running && [ -f /var/run/hotel-proxy.active ]; then
			echo ACTIVE
		else
			echo INACTIVE
		fi
		has_nodes && echo NODES=yes || echo NODES=no
		if [ -x "$BIN" ]; then
			"$BIN" -v 2>/dev/null | head -n 1
		else
			echo BIN=missing
		fi
		nft list chain inet hotel_split tproxy_pre >/dev/null 2>&1 && echo NFT=on || echo NFT=off
		nft list chain inet hotel pre 2>/dev/null | grep -Eq '0x00004000|16384' && echo PXSKIP=on || echo PXSKIP=off
		[ -f "$HOTEL_DIR/canary.down" ] && echo CANARY=down || echo CANARY=$(cat "$HOTEL_DIR/canary.ok" 2>/dev/null || echo 0)
		echo FWD=$(uci -q get dhcp.@dnsmasq[0].server)
		echo LAN=$(cat "$HOTEL_DIR/lan.ip" 2>/dev/null)
		echo UI=http://$(cat "$HOTEL_DIR/lan.ip" 2>/dev/null):$UI_PORT/ui/
		;;
	ui)
		lan=$(cat "$HOTEL_DIR/lan.ip" 2>/dev/null || echo 192.168.16.1)
		echo "http://$lan:$UI_PORT/ui/"
		[ -s /etc/hotel/clash.secret ] && echo SECRET=yes
		;;
	check)
		extract_bin || exit 1
		lan_ip >/dev/null
		ensure_secret
		lua /usr/lib/hotel/mihomo-render.lua || true
		SAFE_PATHS="$SAFE_PATHS" "$BIN" -t -d /tmp/hotel -f "$CONF"
		;;
	*)
		echo "usage: hotel-proxy.sh status|ui|check|start|stop|prepare|attach|teardown|refill|hook|nft-on|nft-off|reload|failopen"
		exit 1
		;;
esac
