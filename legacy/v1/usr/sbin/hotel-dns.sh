#!/bin/sh
# SmartDNS is the LAN resolver. Runtime conf is /tmp/hotel/smartdns.conf.
# Package UCI only keeps the service enabled for Luci; init ignores servers.

. /usr/lib/hotel/common.sh
hotel_dirs

CONF=${SMARTDNS_CONF:-/tmp/hotel/smartdns.conf}
AD_GZ=/usr/share/hotel/ad-domains.gz
AD_LIST=/tmp/hotel/ad.list
CN_GZ=/usr/share/hotel/cn-domains.gz
CN_LIST=/tmp/hotel/cn.list
WARM_HOSTS="www.baidu.com www.qq.com www.bilibili.com www.taobao.com www.aliyun.com
    steamcommunity.com github.com www.microsoft.com www.apple.com www.icloud.com
www.google.com www.cloudflare.com www.iqiyi.com weixin.qq.com music.163.com
api.anthropic.com claude.ai"

extract_gz() {
	gz="$1"
	list="$2"
	stamp="$3"
	[ -f "$gz" ] || { rm -f "$list" "$stamp"; return 0; }
	mark=$(wc -c < "$gz")
	mark=$(echo "$mark" | tr -d ' ')
	old=$(cat "$stamp" 2>/dev/null || true)
	if [ -n "$mark" ] && [ "$mark" = "$old" ] && [ -s "$list" ]; then
		return 0
	fi
	gzip -dc "$gz" > "$list" || busybox gzip -dc "$gz" > "$list" || {
		rm -f "$list" "$stamp"
		return 1
	}
	echo "$mark" > "$stamp"
}

extract_ad() {
	if [ "${ADS_ENABLE:-1}" != "1" ]; then
		rm -f "$AD_LIST" "$HOTEL_DIR/ad.list.bytes"
		return 0
	fi
	extract_gz "$AD_GZ" "$AD_LIST" "$HOTEL_DIR/ad.list.bytes"
}

extract_cn() {
	extract_gz "$CN_GZ" "$CN_LIST" "$HOTEL_DIR/cn.list.bytes"
}

write_smartdns_conf() {
	aaaa_soa="65"
	[ "${DNS_IPV4_ONLY:-1}" = "1" ] && aaaa_soa="28 65"
	extract_ad
	extract_cn
	px=0
	proxy_running && [ -f /var/run/hotel-proxy.active ] && px=1
	pref=yes
	[ "${DNS_PREFETCH:-1}" = "1" ] || pref=no
	# A forged answer must not be replayed for three days after upstream TLS fails.
	sexp=no
	[ "${DNS_SERVE_EXPIRED:-0}" = "1" ] && sexp=yes

	# 这条上行会伪造阿里 DoH 证书。解析只接受 5553（1.1.1.1 经代理）。
	# 国内地址仍由 nft @direct4 在拿到正确 IP 之后直连。
	if [ "$px" = 1 ]; then
		cat > "$CONF" <<EOF
bind 127.0.0.1:${SMARTDNS_PORT}
bind-tcp 127.0.0.1:${SMARTDNS_PORT}
server-name hotel-smartdns
speed-check-mode none
response-mode ${DNS_RESPONSE_MODE:-fastest-ip}
cache-size ${DNS_CACHE_SIZE:-32768}
cache-persist no
prefetch-domain ${pref}
serve-expired ${sexp}
serve-expired-reply-ttl 2
serve-expired-ttl 60
rr-ttl-min ${DNS_RR_TTL_MIN:-300}
rr-ttl-max 3600
rr-ttl-reply-max 60
max-reply-ip-num 1
dualstack-ip-selection no
force-qtype-SOA ${aaaa_soa}
dnsmasq-lease-file /tmp/dhcp.leases
log-level notice
log-file /tmp/hotel/smartdns.log
log-size 64K
log-num 2
audit-enable no
server 127.0.0.1:5553
EOF
		if [ -s "$CN_LIST" ]; then
			cat >> "$CONF" <<EOF
domain-set -name cn-list -type list -file $CN_LIST
EOF
		fi
		if [ -s /etc/hotel/claude-domains.list ]; then
			# Default group is 5553. nftset pins the answer IPs so
			# Cloudflare-CN still tproxies instead of @direct4.
			cat >> "$CONF" <<EOF
domain-set -name claude-list -type list -file /etc/hotel/claude-domains.list
nameserver /domain-set:claude-list/-
nftset /domain-set:claude-list/#4:inet#hotel_split#claude4
EOF
		fi
	else
		cat > "$CONF" <<EOF
bind 127.0.0.1:${SMARTDNS_PORT}
bind-tcp 127.0.0.1:${SMARTDNS_PORT}
server-name hotel-smartdns
speed-check-mode ${DNS_SPEED_CHECK:-tcp-syn:443,tcp-syn:80}
response-mode ${DNS_RESPONSE_MODE:-fastest-ip}
cache-size ${DNS_CACHE_SIZE:-32768}
cache-persist no
prefetch-domain ${pref}
serve-expired ${sexp}
serve-expired-reply-ttl 2
serve-expired-ttl 60
rr-ttl-min ${DNS_RR_TTL_MIN:-300}
rr-ttl-max 3600
rr-ttl-reply-max 60
max-reply-ip-num 1
dualstack-ip-selection no
force-qtype-SOA ${aaaa_soa}
dnsmasq-lease-file /tmp/dhcp.leases
log-level notice
log-file /tmp/hotel/smartdns.log
log-size 64K
log-num 2
audit-enable no
server-https https://223.5.5.5/dns-query -host-name dns.alidns.com -tls-host-verify dns.alidns.com
server-https https://223.6.6.6/dns-query -host-name dns.alidns.com -tls-host-verify dns.alidns.com
EOF
	fi
	if [ -s "$AD_LIST" ]; then
		cat >> "$CONF" <<EOF
domain-set -name ad-list -type list -file $AD_LIST
address /domain-set:ad-list/#
EOF
	fi
	if [ "$aaaa_soa" = "28 65" ]; then
		echo 1 > "$HOTEL_DIR/aaaa_filter"
	else
		echo 0 > "$HOTEL_DIR/aaaa_filter"
	fi
	has_gua && echo 1 > "$HOTEL_DIR/gua" || echo 0 > "$HOTEL_DIR/gua"
}

dnsmasq_forward() {
	# LAN DNS always stays on smartdns. cn list is diverted inside smartdns.
	target="127.0.0.1#${SMARTDNS_PORT}"
	aaaa=$(cat "$HOTEL_DIR/aaaa_filter" 2>/dev/null || echo 1)
	px=0
	proxy_running && [ -f /var/run/hotel-proxy.active ] && px=1
	digest="dnsmasq:$target:$aaaa:${DNSMASQ_CACHE:-0}:px=$px:if=lan:nowansta:logdhcp"
	old=$(cat "$HOTEL_DIR/dnsmasq.digest" 2>/dev/null || true)
	[ "$digest" = "$old" ] && return 0

	uci -q delete dhcp.@dnsmasq[0].server
	uci add_list dhcp.@dnsmasq[0].server="$target"
	uci set dhcp.@dnsmasq[0].noresolv='1'
	uci set dhcp.@dnsmasq[0].filter_aaaa="$aaaa"
	uci set dhcp.@dnsmasq[0].min_cache_ttl="${DNS_RR_TTL_MIN:-300}"
	uci set dhcp.@dnsmasq[0].use_stale_cache='3600'
	uci set dhcp.@dnsmasq[0].cachesize="${DNSMASQ_CACHE:-0}"
	uci set dhcp.@dnsmasq[0].nonegcache='1'
	uci set dhcp.@dnsmasq[0].dnsforwardmax="${DNS_FORWARD_MAX:-400}"
	uci set dhcp.@dnsmasq[0].dns_redirect='1'
	uci set dhcp.@dnsmasq[0].rebind_protection='1'
	uci set dhcp.@dnsmasq[0].domainneeded='1'
	uci set dhcp.@dnsmasq[0].localservice='1'
	uci set dhcp.@dnsmasq[0].nonwildcard='1'
	uci set dhcp.@dnsmasq[0].logdhcp='1'
	uci -q delete dhcp.@dnsmasq[0].interface
	uci add_list dhcp.@dnsmasq[0].interface='lan'
	uci -q delete dhcp.@dnsmasq[0].notinterface
	uci add_list dhcp.@dnsmasq[0].notinterface='wan'
	uci add_list dhcp.@dnsmasq[0].notinterface='wwan'
	for s in wwan5 wwan51 wwan52 wwan53 wwan54; do
		uci add_list dhcp.@dnsmasq[0].notinterface="$s"
	done
	n=1
	while [ "$n" -le "${ETH_VWANS:-20}" ]; do
		uci add_list dhcp.@dnsmasq[0].notinterface="vwan$n"
		n=$((n + 1))
	done
	if [ "${DNS_IPV4_ONLY:-1}" = "1" ]; then
		uci -q set dhcp.lan.dhcpv6='disabled'
		uci -q set dhcp.lan.ra='disabled'
		uci -q set dhcp.lan.ra_slaac='0'
	fi
	uci commit dhcp
	/etc/init.d/dnsmasq reload >/dev/null 2>&1 || /etc/init.d/dnsmasq restart
	echo "$digest" > "$HOTEL_DIR/dnsmasq.digest"
}

router_dns_loopback() {
	changed=0
	for s in $(uci -q show network | sed -n 's/^\(network\.[^=]*\)\.dns=.*$/\1/p' | cut -d. -f1-2 | sort -u); do
		cur=$(uci -q get "$s.dns" 2>/dev/null || true)
		[ "$cur" = "127.0.0.1" ] && continue
		uci -q delete "$s.dns"
		uci add_list "$s.dns=127.0.0.1"
		changed=1
	done
	if [ "$changed" = 1 ] || grep -q '::1' /tmp/resolv.conf 2>/dev/null; then
		uci commit network
		printf 'search lan\nnameserver 127.0.0.1\n' > /tmp/resolv.conf.auto
		ln -sf /tmp/resolv.conf.auto /tmp/resolv.conf
		hotel_log "SYS_DNS resolver=127.0.0.1"
	fi
}

luci_smartdns_on() {
	if [ -f /usr/lib/hotel/smartdns.init.hotel ] && grep -q load_service /etc/init.d/smartdns 2>/dev/null; then
		if ! cmp -s /usr/lib/hotel/smartdns.init.hotel /etc/init.d/smartdns; then
			cp /usr/lib/hotel/smartdns.init.hotel /etc/init.d/smartdns
			chmod 755 /etc/init.d/smartdns
			hotel_log "DNS_WRAP restored /etc/init.d/smartdns"
		fi
	fi
	uci -q show smartdns.@smartdns[0] >/dev/null 2>&1 || return 0
	digest="luci:v5:port=${SMARTDNS_PORT:-6053}:enabled=1:noservers"
	old=$(cat "$HOTEL_DIR/luci.sd.digest" 2>/dev/null || true)
	if [ "$digest" != "$old" ]; then
		uci -q set smartdns.@smartdns[0].enabled='1'
		uci -q set smartdns.@smartdns[0].auto_set_dnsmasq='0'
		uci -q set smartdns.@smartdns[0].old_auto_set_dnsmasq='0'
		uci -q set smartdns.@smartdns[0].port="${SMARTDNS_PORT:-6053}"
		uci -q set smartdns.@smartdns[0].bind_device='1'
		uci -q set smartdns.@smartdns[0].bind_device_name='lo'
		uci -q set smartdns.@smartdns[0].tcp_server='1'
		uci -q set smartdns.@smartdns[0].ipv6_server='0'
		uci -q set smartdns.@smartdns[0].seconddns_enabled='0'
		uci -q set smartdns.@smartdns[0].seconddns_tcp_server='0'
		uci -q delete smartdns.@smartdns[0].nftset_name
		while uci -q delete smartdns.@server[0] >/dev/null 2>&1; do :; done
		uci commit smartdns
		echo "$digest" > "$HOTEL_DIR/luci.sd.digest"
	fi
	/etc/init.d/hotel-smartdns disable >/dev/null 2>&1 || true
	ubus call service delete '{"name":"hotel-smartdns"}' >/dev/null 2>&1 || true
	/etc/init.d/smartdns enable >/dev/null 2>&1 || true
}

dns_apply() {
	rm -f /etc/hotel/smartdns.conf
	write_smartdns_conf
	mkdir -p /var/etc/smartdns
	ln -sfn "$CONF" /var/etc/smartdns/smartdns.conf
	luci_smartdns_on
	router_dns_loopback
	conf_hash=$(md5sum "$CONF" | awk '{print $1}')
	old_hash=$(cat "$HOTEL_DIR/smartdns.digest" 2>/dev/null || true)
	luci_running=0
	ubus call service list '{"name":"smartdns"}' 2>/dev/null | grep -q '"running": true' && luci_running=1
	DNS_RESTARTED=0
	if [ "$conf_hash" != "$old_hash" ] || [ "$luci_running" != 1 ]; then
		/etc/init.d/smartdns restart >/dev/null 2>&1 || /etc/init.d/smartdns start
		echo "$conf_hash" > "$HOTEL_DIR/smartdns.digest"
		hotel_log "DNS_APPLY smartdns=$conf_hash aaaa=$(cat $HOTEL_DIR/aaaa_filter) gua=$(cat $HOTEL_DIR/gua)"
		DNS_RESTARTED=1
	fi
	dnsmasq_forward
}

dns_warm() {
	for h in $WARM_HOSTS; do
		nslookup "$h" 127.0.0.1 >/dev/null 2>&1 || true
	done
}

cmd="${1:-apply}"
case "$cmd" in
	apply)
		dns_apply
		[ "${DNS_RESTARTED:-0}" = 1 ] && dns_warm
		;;
	forward) dnsmasq_forward ;;
	warm) dns_warm ;;
	status)
		echo GUA=$(cat "$HOTEL_DIR/gua" 2>/dev/null)
		echo AAAA_FILTER=$(cat "$HOTEL_DIR/aaaa_filter" 2>/dev/null)
		echo BIND=$(grep '^bind ' "$CONF" 2>/dev/null)
		echo CN_DOH=$(grep -c 'server-https https://223' "$CONF" 2>/dev/null || echo 0)
		echo DOMAINSET=$(grep '^domain-set ' "$CONF" 2>/dev/null)
		echo SPEED=$(grep '^speed-check-mode ' "$CONF" 2>/dev/null)
		echo CNLIST=$(wc -l < /tmp/hotel/cn.list 2>/dev/null)
		echo ADS=$(wc -l < /tmp/hotel/ad.list 2>/dev/null)
		echo FWD=$(uci -q get dhcp.@dnsmasq[0].server)
		echo CACHE=$(uci -q get dhcp.@dnsmasq[0].cachesize)
		pidof smartdns >/dev/null && echo SMARTDNS=up || echo SMARTDNS=down
		;;
	*)
		echo "usage: hotel-dns.sh apply|forward|warm|status"
		exit 1
		;;
esac
exit 0
