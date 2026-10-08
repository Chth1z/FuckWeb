#!/bin/sh
# Fail-closed health. hotelctl doctor. Does not print secrets.
# Critical fail → ok=0 and exit 1. Warn is visible but still ok=1.

. /usr/lib/hotel/common.sh
hotel_dirs

fmt="${1:-json}"
ok=1
fail=""
warn=""

addfail() {
	fail="$fail $1"
	ok=0
}

addwarn() {
	warn="$warn $1"
}

# --- processes / forwarding ---
proxy=0
proxy_running && [ -f /var/run/hotel-proxy.active ] && proxy=1
[ "$proxy" = 1 ] || addfail proxy_active

sd=0
pidof smartdns >/dev/null 2>&1 && sd=1
[ "$sd" = 1 ] || addfail smartdns

dnsmasq=0
pidof dnsmasq >/dev/null 2>&1 && dnsmasq=1
for f in /var/run/dnsmasq/*.pid /var/run/dnsmasq.pid; do
	[ -f "$f" ] || continue
	pid=$(cat "$f" 2>/dev/null || true)
	[ -n "$pid" ] && [ -d "/proc/$pid" ] && dnsmasq=1
done

hostapd=0
pidof hostapd >/dev/null 2>&1 && hostapd=1
[ "$hostapd" = 1 ] || addfail hostapd

ipfwd=0
[ "$(cat /proc/sys/net/ipv4/ip_forward 2>/dev/null)" = 1 ] && ipfwd=1
[ "$ipfwd" = 1 ] || addfail ip_forward

# --- nft / tproxy ---
pre=$(nft list chain inet hotel_split tproxy_pre 2>/dev/null || true)
nft=0
[ -n "$pre" ] && nft=1
[ "$nft" = 1 ] || addfail tproxy_nft

rest=0
echo "$pre" | grep -q 'tproxy ip to' && rest=1
[ "${SPLIT_REMAINDER:-proxy}" = "proxy" ] && [ "$rest" != 1 ] && addfail tproxy_live
[ "${SPLIT_REMAINDER:-proxy}" != "proxy" ] && rest=0

px=0
nft list chain inet hotel pre 2>/dev/null | grep -Eq '0x00004000|16384' && px=1
[ "$px" = 1 ] || addfail px_skip

pkt=0
echo "$pre" | grep -q 'pkttype' && echo "$pre" | grep -q broadcast && pkt=1
[ "$pkt" = 1 ] || addfail tproxy_pkttype

dhcp=0
echo "$pre" | grep -q '67, 68' && echo "$pre" | grep -q '255.255.255.255' && dhcp=1
[ "$dhcp" = 1 ] || addfail dhcp_bypass

llskip=0
echo "$pre" | grep -q '169.254.0.0/16' && llskip=1
[ "$llskip" = 1 ] || addfail tproxy_linklocal

d4skip=0
echo "$pre" | grep -q 'ip daddr @direct4 return' && d4skip=1
[ "$d4skip" = 1 ] || addfail cn_not_tproxy

hijack=0
hij=$(nft list chain inet hotel_split dns_hijack 2>/dev/null || true)
[ -n "$hij" ] && hijack=1
[ "$hijack" = 1 ] || addfail dns_hijack
hij_dhcp=0
echo "$hij" | grep -qE 'dport.*67' && hij_dhcp=1
[ "$hij_dhcp" = 1 ] && addfail dns_hijack_dhcp

out=0
nft list chain inet hotel sb_out >/dev/null 2>&1 && out=1
[ "${DATAPATH:-ecmp10}" = "ecmp10" ] && [ "$out" != 1 ] && addfail egress_ecmp
[ "${DATAPATH:-ecmp10}" != "ecmp10" ] && out=1

# --- DHCP service ---
dhcp_listen=0
netstat -uln 2>/dev/null | grep -q '0.0.0.0:67' && dhcp_listen=1
[ "$dhcp_listen" = 1 ] || addfail dhcp_listen
[ "$dnsmasq" != 1 ] && [ "$dhcp_listen" = 1 ] && dnsmasq=1
[ "$dnsmasq" = 1 ] || addfail dnsmasq

dhcp_lan=0
[ "$(uci -q get dhcp.lan.dhcpv4)" = "server" ] && [ "$(uci -q get dhcp.lan.ignore)" != "1" ] && dhcp_lan=1
[ "$dhcp_lan" = 1 ] || addfail dhcp_lan

# --- DNS ---
fwd=$(uci -q get dhcp.@dnsmasq[0].server)
dns_ok=1
echo "$fwd" | grep -q 5553 && dns_ok=0
[ "$dns_ok" = 1 ] || addfail dns_not_all_5553

bind=$(grep '^bind ' "${SMARTDNS_CONF:-/tmp/hotel/smartdns.conf}" 2>/dev/null || true)
bind_ok=0
echo "$bind" | grep -q '127.0.0.1' && bind_ok=1
[ "$bind_ok" = 1 ] || addfail smartdns_loopback

# --- API ---
api=1
ctrl=$(grep '^external-controller:' /etc/hotel/mihomo.yaml 2>/dev/null || true)
echo "$ctrl" | grep -q '0.0.0.0' && api=0
[ "$api" = 1 ] || addfail api_not_public

mixed=0
netstat -lntp 2>/dev/null | grep -q '127.0.0.1:7890' && mixed=1
[ "$proxy" = 1 ] && [ "$mixed" != 1 ] && addfail mixed_local

# --- cnip ---
cn=$(grep -oE '[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+/[0-9]+' /etc/hotel/direct4.nft 2>/dev/null | wc -l)
cn=$(echo "$cn" | tr -d ' \t')
[ -n "$cn" ] || cn=0
cn_ok=0
if [ "$cn" -gt 100 ] && nft get element inet hotel_split direct4 '{ 1.0.1.0/24 }' >/dev/null 2>&1; then
	cn_ok=1
fi
[ "$cn_ok" = 1 ] || addfail cnip_loaded

# --- WAN / SQM ---
wan_up=0
[ "$(cat /sys/class/net/wan/operstate 2>/dev/null)" = up ] && \
	[ "$(cat /sys/class/net/wan/carrier 2>/dev/null)" = 1 ] && wan_up=1
[ "$wan_up" = 1 ] || addfail wan_up

speed=$(cat /sys/class/net/wan/speed 2>/dev/null || echo 0)
qdisc=$(tc qdisc show dev wan 2>/dev/null || true)
sqm=0
case "$speed" in
	10|100)
		echo "$qdisc" | grep -q htb && sqm=1
		;;
	1000|2500|10000)
		echo "$qdisc" | grep -Eq 'htb|fq_codel|cake' && sqm=1
		;;
	*)
		# PHY not ready: do not fail closed on SQM
		sqm=1
		[ "$wan_up" = 1 ] && addwarn wan_speed_unknown
		;;
esac
[ "${WAN_SQM:-auto}" = "off" ] && sqm=1
[ "$sqm" = 1 ] || addfail wan_sqm

# --- Wi-Fi AP (not the harvest LED) ---
ap24=0
hotel_ap_fwd phy0-ap0 && ap24=1
[ "$ap24" = 1 ] || addfail ap24

ap5=0
hotel_ap_fwd phy1-ap0 && ap5=1
[ "$ap5" = 1 ] || addfail ap5

ssid24=0
iw dev phy0-ap0 info 2>/dev/null | grep -q 'ssid Redmi-2.4G' && ssid24=1
[ "$ssid24" = 1 ] || addfail ssid24

ssid5=0
iw dev phy1-ap0 info 2>/dev/null | grep -q 'ssid Redmi-5G' && ssid5=1
[ "$ssid5" = 1 ] || addfail ssid5

# --- overlay ---
overlay=0
avail=$(df -k /overlay 2>/dev/null | awk 'NR==2 {print $4}')
[ -n "$avail" ] || avail=0
[ "$avail" -gt 5120 ] && overlay=1
[ "$overlay" = 1 ] || addfail overlay

# --- nodes / canary (canary is warn: hotel probe can flap) ---
nodes=0
[ -s /etc/hotel/proxy-nodes.json ] && grep -q '"tag"' /etc/hotel/proxy-nodes.json && nodes=1
[ "$nodes" = 1 ] || addfail has_nodes

can=0
[ "$(cat /tmp/hotel/canary.ok 2>/dev/null)" = 1 ] && can=1
fdown=0
[ -f /tmp/hotel/canary.down ] && fdown=1
[ "$proxy" = 1 ] && [ "$can" != 1 ] && addwarn canary
[ "$fdown" = 1 ] && addwarn canary_down

# --- warns / remaining fail-closed wifi+perms ---
apsta=0
sta_wan=0
if [ -d /sys/class/net/phy0-ap0 ] && [ -d /sys/class/net/phy0-sta0 ]; then
	apsta=1
	if [ "$(hotel_wan_carrier)" = 1 ]; then
		sta_wan=1
		addfail sta_with_wan
	else
		addwarn wifi_apsta
	fi
fi

sta_slow=0
iw dev phy0-sta0 link 2>/dev/null | grep -q 'tx bitrate: 1.0' && sta_slow=1
[ "$sta_slow" = 1 ] && addwarn sta_tx_slow

m2u=0
[ "$(uci -q get wireless.default_radio0.multicast_to_unicast_all)" = 1 ] && m2u=1
[ "$(uci -q get wireless.default_radio1.multicast_to_unicast_all)" = 1 ] && m2u=1
[ "$(uci -q get wireless.default_radio0.multicast_to_unicast)" = 1 ] && m2u=1
[ "$(uci -q get wireless.default_radio1.multicast_to_unicast)" = 1 ] && m2u=1
[ "$m2u" = 1 ] && addfail m2u_all

isolate=0
grep -q '^ap_isolate=1' /var/run/hostapd-phy0.conf 2>/dev/null && isolate=1
grep -q '^ap_isolate=1' /var/run/hostapd-phy1.conf 2>/dev/null && isolate=1
[ "$isolate" = 1 ] && addfail ap_isolate

wed=0
for f in /sys/module/mt7915e/parameters/wed_enable /sys/module/mt76/parameters/wed_enable; do
	[ -f "$f" ] || continue
	[ "$(cat "$f" 2>/dev/null)" = Y ] && wed=1
done
[ "$wed" = 1 ] && addwarn wed

sec=1
for f in /etc/hotel/clash.secret /etc/hotel-portal.code /etc/hotel/proxy-nodes.json /etc/hotel/mihomo.yaml; do
	[ -f "$f" ] || continue
	ls -l "$f" 2>/dev/null | grep -q '^-rw-------' || sec=0
done
[ "$sec" = 1 ] || addfail secret_perms

ssh_pub=0
netstat -lntp 2>/dev/null | grep dropbear | grep -q '0.0.0.0:22' && ssh_pub=1
[ "$ssh_pub" = 1 ] && addfail ssh_public

http_pub=0
netstat -lntp 2>/dev/null | grep uhttpd | grep -q '0.0.0.0:80' && http_pub=1
[ "$http_pub" = 1 ] && addfail http_public

n_hash=$(hotel_hash_count)
ledc=""
[ -f /tmp/hotel/led ] && ledc=$(awk '{print $1}' /tmp/hotel/led)
[ "$n_hash" -lt 18 ] && [ "${DATAPATH:-ecmp10}" = "ecmp10" ] && addwarn harvest_low
[ "$ledc" = green ] && [ "$ap24" != 1 -o "$ap5" != 1 ] && addwarn led_masks_wifi

sta5on=0
for s in sta5 sta51 sta52 sta53 sta54; do
	[ "$(uci -q get wireless.$s.disabled)" = "0" ] && sta5on=1
done
[ "$sta5on" = 1 ] && addwarn extra_5g_sta

retry=0
ubus call network.wireless status 2>/dev/null | grep -q '"retry_setup_failed": true' && retry=1
[ "$retry" = 1 ] && addwarn wifi_retry_failed

dp=${DATAPATH:-ecmp10}

json_arr() {
	first=1
	printf '['
	for x in $1; do
		[ -n "$x" ] || continue
		[ "$first" = 1 ] || printf ','
		first=0
		printf '"%s"' "$x"
	done
	printf ']'
}

json() {
	printf '{'
	printf '"ok":%s,' "$ok"
	printf '"fail":'
	json_arr "$fail"
	printf ','
	printf '"warn":'
	json_arr "$warn"
	printf ','
	printf '"proxy_active":%s,"tproxy_nft":%s,"tproxy_all_public":%s,"tproxy_live":%s,' "$proxy" "$nft" "$rest" "$rest"
	printf '"tproxy_pkttype":%s,"tproxy_linklocal":%s,"cn_not_tproxy":%s,' "$pkt" "$llskip" "$d4skip"
	printf '"px_skip":%s,"mixed_local":%s,"canary_ok":%s,"canary_down":%s,' "$px" "$mixed" "$can" "$fdown"
	printf '"has_nodes":%s,"smartdns":%s,"dnsmasq":%s,"hostapd":%s,' "$nodes" "$sd" "$dnsmasq" "$hostapd"
	printf '"dns_not_all_5553":%s,"smartdns_loopback":%s,"api_not_public":%s,' "$dns_ok" "$bind_ok" "$api"
	printf '"cnip_loaded":%s,"egress_ecmp":%s,"direct4":%s,"datapath":"%s",' "$cn_ok" "$out" "$cn" "$dp"
	printf '"dns_hijack":%s,"dns_hijack_dhcp":%s,"wan_sqm":%s,"dhcp_bypass":%s,' "$hijack" "$hij_dhcp" "$sqm" "$dhcp"
	printf '"dhcp_listen":%s,"dhcp_lan":%s,"ap24":%s,"ap5":%s,"ssid24":%s,"ssid5":%s,' "$dhcp_listen" "$dhcp_lan" "$ap24" "$ap5" "$ssid24" "$ssid5"
	printf '"wan_up":%s,"wan_speed":%s,"ip_forward":%s,"overlay":%s,"overlay_avail_kb":%s,' "$wan_up" "$speed" "$ipfwd" "$overlay" "$avail"
	printf '"wifi_apsta":%s,"sta_with_wan":%s,"sta_tx_slow":%s,"m2u_all":%s,"ap_isolate":%s,"wed":%s,' "$apsta" "$sta_wan" "$sta_slow" "$m2u" "$isolate" "$wed"
	printf '"secret_perms":%s,"ssh_public":%s,"http_public":%s,' "$sec" "$ssh_pub" "$http_pub"
	printf '"n_hash":%s,"led":"%s"' "$n_hash" "$ledc"
	printf '}\n'
}

text() {
	echo "ok=$ok"
	[ -n "$fail" ] && echo "FAIL$fail"
	[ -n "$warn" ] && echo "WARN$warn"
	echo "wifi ap24=$ap24 ap5=$ap5 ssid24=$ssid24 ssid5=$ssid5 hostapd=$hostapd apsta=$apsta sta_wan=$sta_wan"
	echo "dhcp listen=$dhcp_listen lan=$dhcp_lan bypass=$dhcp pkttype=$pkt"
	echo "wan up=$wan_up speed=$speed sqm=$sqm"
	echo "proxy=$proxy nft=$nft live=$rest cnip=$cn_ok hijack=$hijack"
	echo "perms=$sec ssh_pub=$ssh_pub http_pub=$http_pub"
	echo "led=$ledc hash=$n_hash overlay_kb=$avail"
}

if [ "$fmt" = text ]; then
	text
	json
else
	json
fi

[ "$ok" = 1 ]
