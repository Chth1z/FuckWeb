#!/bin/sh
# Runtime heal. Boot grace so first-minute AP/proxy races do not wifi-reload.
# STA is copper-cut backup only: disable while wan carrier is up.

. /usr/lib/hotel/common.sh
hotel_dirs

cmd="${1:-all}"

reload_radio0() {
	if ubus -S call network.wireless down '{"device":"radio0"}' >/dev/null 2>&1; then
		ubus -S call network.wireless up '{"device":"radio0"}' >/dev/null 2>&1 || wifi up radio0 >/dev/null 2>&1 || true
	else
		wifi reload radio0 >/dev/null 2>&1 || wifi reload >/dev/null 2>&1 || true
	fi
}

sta_role() {
	uci -q get wireless.sta >/dev/null 2>&1 || return 0
	car=$(hotel_wan_carrier)
	if [ "$car" = 1 ]; then
		want=1
	else
		want=0
	fi
	cur=$(uci -q get wireless.sta.disabled)
	[ -z "$cur" ] && cur=0
	live=0
	[ -d /sys/class/net/phy0-sta0 ] && live=1
	need=0
	[ "$cur" != "$want" ] && need=1
	[ "$want" = 1 ] && [ "$live" = 1 ] && need=1
	[ "$want" = 0 ] && [ "$live" = 0 ] && [ "$cur" = 0 ] && need=1
	[ "$need" = 1 ] || return 0
	uci -q set wireless.sta.disabled="$want"
	uci commit wireless
	hotel_log "WIFI_STA copper=$car disabled=$want"
	reload_radio0
}

wifi_guard() {
	if hotel_boot_grace; then
		rm -f "$HOTEL_DIR/wifi.bad" "$HOTEL_DIR/wifi.survey.bad"
		return 0
	fi
	if hotel_datapath_busy; then
		return 0
	fi
	ap_bad=0
	survey_bad=0
	ap_ok=0
	for d in phy0-ap0 phy1-ap0; do
		if hotel_ap_fwd "$d"; then
			ap_ok=1
			echo "$(date +%s)" > "$HOTEL_DIR/wifi.ok.$d"
		else
			ap_bad=$((ap_bad + 1))
		fi
		act=$(iw dev "$d" survey dump 2>/dev/null | awk '/\[in use\]/{f=1} f && /channel active time/{print $3+0; exit}')
		old=$(cat "$HOTEL_DIR/wifi.act.$d" 2>/dev/null || true)
		[ -n "$act" ] && echo "$act" > "$HOTEL_DIR/wifi.act.$d"
		if [ -n "$act" ] && [ "$act" -gt 0 ] && [ -n "$old" ] && [ "$act" = "$old" ] && [ "$act" -gt 20000 ] 2>/dev/null; then
			survey_bad=1
		fi
	done
	# Both radios must look dead, or survey frozen with non-zero active time.
	bad=0
	reason=""
	if [ "$ap_bad" -ge 2 ]; then
		bad=1
		reason=ap_down
	elif [ "$survey_bad" = 1 ] && [ "$ap_ok" = 0 ]; then
		bad=1
		reason=survey_frozen
	fi
	strike="$HOTEL_DIR/wifi.bad"
	if [ "$bad" = 1 ]; then
		n=$(cat "$strike" 2>/dev/null || echo 0)
		n=$((n + 1))
		echo "$n" > "$strike"
	else
		rm -f "$strike"
		return 0
	fi
	[ "$n" -ge 3 ] || return 0
	last=$(cat "$HOTEL_DIR/wifi.recover.ts" 2>/dev/null || echo)
	now=$(date +%s)
	if [ -z "$last" ]; then
		echo "$now" > "$HOTEL_DIR/wifi.recover.ts"
		return 0
	fi
	[ $((now - last)) -ge 600 ] || return 0
	echo "$now" > "$HOTEL_DIR/wifi.recover.ts"
	rm -f "$strike"
	hotel_log "WIFI_RECOVER $reason"
	wifi reload >/dev/null 2>&1 || true
}

stack_heal() {
	if hotel_boot_grace; then
		return 0
	fi
	hotel_secure_files
	if [ -s /etc/hotel/proxy-nodes.json ] && ! proxy_running && [ ! -f "$HOTEL_DIR/canary.down" ]; then
		hotel_log "WATCH_PROXY start"
		/etc/init.d/hotel-proxy start >/dev/null 2>&1 || true
	fi
	if proxy_running && [ -f /var/run/hotel-proxy.active ]; then
		# canary.down means failopen already removed tproxy. Putting it back
		# forces LAN traffic through a proxy that just failed its probe.
		if [ -f "$HOTEL_DIR/canary.down" ]; then
			if nft list chain inet hotel_split tproxy_pre >/dev/null 2>&1; then
				hotel_log "WATCH_NFT drop canary_down"
				/usr/sbin/hotel-proxy.sh nft-off >/dev/null 2>&1 || true
			fi
		elif ! nft list chain inet hotel_split tproxy_pre >/dev/null 2>&1; then
			hotel_log "WATCH_NFT tproxy_pre"
			/usr/sbin/hotel-proxy.sh nft-on >/dev/null 2>&1 || true
		fi
	fi
	if ! pidof smartdns >/dev/null 2>&1; then
		hotel_log "WATCH_DNS smartdns"
		/usr/sbin/hotel-dns.sh apply >/dev/null 2>&1 || true
	fi
	if ! netstat -uln 2>/dev/null | grep -q '0.0.0.0:67'; then
		hotel_log "WATCH_DHCP dnsmasq"
		/etc/init.d/dnsmasq restart >/dev/null 2>&1 || true
	fi
	if [ "${WAN_SQM:-auto}" != "off" ]; then
		speed=$(cat /sys/class/net/wan/speed 2>/dev/null || echo 0)
		case "$speed" in
			10|100)
				tc qdisc show dev wan 2>/dev/null | grep -q htb || {
					/usr/sbin/hotel-perf.sh >/dev/null 2>&1 || true
					hotel_log "WATCH_SQM speed=$speed"
				}
				;;
		esac
	fi
	sta_role
}

case "$cmd" in
	wifi) wifi_guard ;;
	sta) sta_role ;;
	stack) stack_heal ;;
	all)
		wifi_guard
		stack_heal
		;;
	*)
		echo "usage: hotel-guard.sh all|wifi|sta|stack"
		exit 1
		;;
esac
exit 0
