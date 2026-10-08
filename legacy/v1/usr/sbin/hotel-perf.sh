#!/bin/sh
# IRQ / RPS / sysctl. Disable IPv6 on WAN and LAN (WebRTC/AAAA leak).
# apply-uci: wifi/firewall/log/packet_steering. Not from hotplug (avoids ifup loops).
# iface <dev>: RPS + v6off for one NIC. Never rebuilds WAN SQM.
. /usr/lib/hotel/common.sh
hotel_dirs

rps_on() {
	dev="$1"
	[ -d "/sys/class/net/$dev" ] || return 0
	for q in /sys/class/net/$dev/queues/rx-*; do
		[ -w "$q/rps_cpus" ] && echo f > "$q/rps_cpus" 2>/dev/null || true
		[ -w "$q/rps_flow_cnt" ] && echo 4096 > "$q/rps_flow_cnt" 2>/dev/null || true
	done
	for q in /sys/class/net/$dev/queues/tx-*; do
		[ -w "$q/xps_cpus" ] && echo f > "$q/xps_cpus" 2>/dev/null || true
	done
}

v6off() {
	[ -d "/sys/class/net/$1" ] || return 0
	sysctl -qw "net.ipv6.conf.${1}.disable_ipv6=1" 2>/dev/null || true
}

if [ "$1" = iface ]; then
	rps_on "$2"
	v6off "$2"
	exit 0
fi

uci_apply() {
	fw_need=0
	[ "$(uci -q get firewall.@defaults[0].flow_offloading)" = "0" ] || fw_need=1
	[ "$(uci -q get firewall.@defaults[0].flow_offloading_hw)" = "0" ] || fw_need=1
	[ "$(uci -q get firewall.@defaults[0].fullcone)" = "1" ] || fw_need=1
	[ "$(uci -q get firewall.@defaults[0].fullcone6)" = "0" ] || fw_need=1
	[ "$(uci -q get firewall.@defaults[0].drop_invalid)" = "0" ] || fw_need=1
	[ "$(uci -q get firewall.@defaults[0].synflood_protect)" = "1" ] || fw_need=1
	if [ "$fw_need" = 1 ]; then
		uci -q set firewall.@defaults[0].flow_offloading='0'
		uci -q set firewall.@defaults[0].flow_offloading_hw='0'
		uci -q set firewall.@defaults[0].fullcone='1'
		uci -q set firewall.@defaults[0].fullcone6='0'
		uci -q set firewall.@defaults[0].drop_invalid='0'
		uci -q set firewall.@defaults[0].synflood_protect='1'
		uci -q commit firewall
		/etc/init.d/firewall reload >/dev/null 2>&1 || true
	fi

	# packet_steering=2: all CPUs. Marks still work; flow offload stays off.
	[ "$(uci -q get network.globals.packet_steering)" = "2" ] \
		|| uci -q set network.globals.packet_steering='2'
	[ "$(uci -q get network.lan.ipv6)" = "0" ] || uci -q set network.lan.ipv6='0'
	[ "$(uci -q get network.wan.ipv6)" = "0" ] || uci -q set network.wan.ipv6='0'

	[ "$(uci -q get system.@system[0].conloglevel)" = "5" ] \
		|| uci -q set system.@system[0].conloglevel='5'
	[ "$(uci -q get system.@system[0].cronloglevel)" = "9" ] \
		|| uci -q set system.@system[0].cronloglevel='9'
	uci -q commit system

	wifi_need=0
	if uci -q get wireless.radio0 >/dev/null 2>&1; then
		[ "$(uci -q get wireless.radio0.legacy_rates)" = "0" ] || {
			uci -q set wireless.radio0.legacy_rates='0'
			wifi_need=1
		}
	fi
	if uci -q get wireless.radio1 >/dev/null 2>&1; then
		[ "$(uci -q get wireless.radio1.legacy_rates)" = "0" ] || {
			uci -q set wireless.radio1.legacy_rates='0'
			wifi_need=1
		}
	fi
	if uci -q get wireless.default_radio0 >/dev/null 2>&1; then
		[ "$(uci -q get wireless.default_radio0.disabled)" = "0" ] || {
			uci -q set wireless.default_radio0.disabled='0'
			wifi_need=1
		}
		for opt in wmm=1 disassoc_low_ack=0 skip_inactivity_poll=1 multicast_to_unicast=0 multicast_to_unicast_all=0 isolate=0; do
			k=${opt%=*}
			v=${opt#*=}
			[ "$(uci -q get wireless.default_radio0.$k)" = "$v" ] && continue
			uci -q set "wireless.default_radio0.$k=$v"
			wifi_need=1
		done
	fi
	if uci -q get wireless.default_radio1 >/dev/null 2>&1; then
		for opt in wmm=1 disassoc_low_ack=0 skip_inactivity_poll=1 multicast_to_unicast=0 multicast_to_unicast_all=0 isolate=0; do
			k=${opt%=*}
			v=${opt#*=}
			[ "$(uci -q get wireless.default_radio1.$k)" = "$v" ] && continue
			uci -q set "wireless.default_radio1.$k=$v"
			wifi_need=1
		done
	fi
	# Extra 5G hotel STAs steal the AP's 80 MHz. 2.4G STA is copper-cut
	# backup only — disable it while wan carrier is up (shared mt76 firmware).
	for s in sta5 sta51 sta52 sta53 sta54; do
		uci -q get "wireless.$s" >/dev/null 2>&1 || continue
		[ "$(uci -q get wireless.$s.disabled)" = "1" ] && continue
		uci -q set "wireless.$s.disabled=1"
		wifi_need=1
	done
	if uci -q get wireless.sta >/dev/null 2>&1; then
		if [ "$(hotel_wan_carrier)" = 1 ]; then
			[ "$(uci -q get wireless.sta.disabled)" = "1" ] || {
				uci -q set wireless.sta.disabled='1'
				wifi_need=1
			}
		fi
	fi
	# Leave hotel 161/HE80. UNII-1 36 is a different 80 MHz block (CN, non-DFS).
	if [ "$(uci -q get wireless.radio1.channel)" != "36" ]; then
		uci -q set wireless.radio1.channel='36'
		wifi_need=1
	fi
	uci -q commit wireless
	for s in wwan5 wwan51 wwan52 wwan53 wwan54; do
		uci -q get "network.$s" >/dev/null 2>&1 || continue
		[ "$(uci -q get network.$s.auto)" = "0" ] && continue
		uci -q set "network.$s.auto=0"
		uci -q set "network.$s.ipv6=0"
	done
	[ "$(uci -q get network.wwan.ipv6)" = "0" ] || uci -q set network.wwan.ipv6='0'
	uci -q commit network

	if grep -q nf_conntrack_helper /etc/sysctl.d/11-nf-conntrack.conf 2>/dev/null; then
		sed -i '/nf_conntrack_helper/d' /etc/sysctl.d/11-nf-conntrack.conf
	fi
	rm -f /etc/sysctl.d/99-hotel-multidial.conf
	if grep -q '^nf_conntrack_ftp' /etc/modules.d/nf-nathelper 2>/dev/null; then
		printf '# ftp alg off: conflicts with fullcone/tproxy\n' > /etc/modules.d/nf-nathelper
		rmmod nf_nat_ftp 2>/dev/null || true
		rmmod nf_conntrack_ftp 2>/dev/null || true
		hotel_log "SYS_ALG ftp_helper=off"
	fi
	if [ -x /etc/init.d/odhcpd ] && /etc/init.d/odhcpd enabled >/dev/null 2>&1; then
		/etc/init.d/odhcpd stop >/dev/null 2>&1 || true
		/etc/init.d/odhcpd disable >/dev/null 2>&1 || true
		hotel_log "SYS_V6 odhcpd=off"
	fi
	if [ -x /etc/init.d/radius ] && /etc/init.d/radius enabled >/dev/null 2>&1; then
		/etc/init.d/radius disable >/dev/null 2>&1 || true
	fi
	if [ -c /dev/watchdog ]; then
		[ "$(uci -q get system.@system[0].watchdog)" = "1" ] || {
			uci -q set system.@system[0].watchdog='1'
			uci commit system
			hotel_log "SYS_WATCHDOG on"
		}
	fi

	lan=$(uci -q get network.lan.ipaddr)
	lan=${lan%%/*}
	if [ -n "$lan" ]; then
		cur=$(uci -q get uhttpd.main.listen_http | tr '\n' ' ')
		want="$lan:80"
		case " $cur " in
			*" $want "*) ;;
			*)
				uci -q delete uhttpd.main.listen_http
				uci add_list uhttpd.main.listen_http="$want"
				uci commit uhttpd
				/etc/init.d/uhttpd reload >/dev/null 2>&1 || true
				hotel_log "SYS_HTTPD listen=$want"
				;;
		esac
	fi

	if [ "$wifi_need" = 1 ]; then
		wifi reload >/dev/null 2>&1 || true
		hotel_log "SYS_WIFI 2.4g_ap=on extra_5g_sta=off legacy_rates=0"
	fi
}

wan_sqm() {
	# Shape the hotel copper bottleneck. DSA wan is noqueue; eth0 mq+fq_codel
	# is the switch fabric and must not be the WAN shaper. No cake.ko here.
	dev=wan
	stamp=$HOTEL_DIR/wan_sqm.stamp
	if [ "${WAN_SQM:-auto}" = "off" ]; then
		old=$(cat "$stamp" 2>/dev/null || true)
		if [ "$old" = "off" ]; then
			return 0
		fi
		if command -v tc >/dev/null 2>&1; then
			tc qdisc del dev wan root 2>/dev/null || true
			tc qdisc del dev wan ingress 2>/dev/null || true
		fi
		nft delete table inet hotel_sqm 2>/dev/null || true
		echo off > "$stamp"
		return 0
	fi
	command -v tc >/dev/null 2>&1 || {
		hotel_log "SQM skip=no_tc"
		return 0
	}
	[ -d "/sys/class/net/$dev" ] || return 0
	speed=$(cat "/sys/class/net/$dev/speed" 2>/dev/null || echo 0)
	case "$speed" in
		10|100)
			pct=${WAN_SQM_PCT:-95}
			rate=$((speed * pct / 100))
			[ "$rate" -ge 1 ] || rate=$speed
			;;
		*)
			rate=0
			;;
	esac
	want="auto:$speed:$rate"
	old=$(cat "$stamp" 2>/dev/null || true)
	# Download police (nft limit+drop) collapses TCP well below the copper
	# rate. tc on wan only shapes egress = LAN upload. No ifb here.
	nft delete table inet hotel_sqm 2>/dev/null || true
	if [ "$want" = "$old" ]; then
		if [ "$rate" -gt 0 ]; then
			echo "$(tc qdisc show dev "$dev" 2>/dev/null)" | grep -q htb && return 0
		else
			echo "$(tc qdisc show dev "$dev" 2>/dev/null)" | grep -q fq_codel && return 0
		fi
	fi
	modprobe sch_htb 2>/dev/null || true
	modprobe sch_fq_codel 2>/dev/null || true
	tc qdisc del dev "$dev" root 2>/dev/null || true
	tc qdisc del dev "$dev" ingress 2>/dev/null || true
	if [ "$rate" -gt 0 ]; then
		if ! tc qdisc add dev "$dev" root handle 1: htb default 10; then
			hotel_log "SQM fail=htb_root speed=$speed"
			return 0
		fi
		if ! tc class add dev "$dev" parent 1: classid 1:10 htb rate "${rate}mbit" ceil "${rate}mbit" quantum 1514 burst 15k cburst 15k 2>/dev/null; then
			if ! tc class add dev "$dev" parent 1: classid 1:10 htb rate "${rate}mbit" ceil "${rate}mbit" quantum 1514; then
				tc qdisc del dev "$dev" root 2>/dev/null || true
				hotel_log "SQM fail=htb_class speed=$speed"
				return 0
			fi
		fi
		# 100 Mbit × ~20 ms ≈ 250 kB. Default 4 MB / 10240p is a lag reservoir.
		tc qdisc add dev "$dev" parent 1:10 handle 10: fq_codel \
			limit 1000 target 5ms interval 100ms memory_limit 250000 noecn 2>/dev/null || \
			tc qdisc add dev "$dev" parent 1:10 handle 10: fq_codel noecn 2>/dev/null || \
			tc qdisc add dev "$dev" parent 1:10 handle 10: fq_codel 2>/dev/null || true
		ip link set dev "$dev" txqueuelen 128 2>/dev/null || true
		command -v ethtool >/dev/null 2>&1 && ethtool -K "$dev" gro off gso off tso off 2>/dev/null || true
		echo "$want" > "$stamp"
		hotel_log "SQM wan=${rate}mbit htb+fq_codel download=off speed=$speed"
	else
		nft delete table inet hotel_sqm 2>/dev/null || true
		if tc qdisc add dev "$dev" root fq_codel noecn 2>/dev/null || \
			tc qdisc add dev "$dev" root fq_codel 2>/dev/null; then
			echo "$want" > "$stamp"
			hotel_log "SQM wan=fq_codel unshaped speed=$speed"
		fi
	fi
}

aql_tune() {
	# Cut Wi-Fi queueing delay. VO/VI stay tight; BE/BK still carry bulk.
	for phy in phy0 phy1; do
		lim=/sys/kernel/debug/ieee80211/$phy/aql_txq_limit
		[ -w "$lim" ] || continue
		echo 0 1500 4000 > "$lim" 2>/dev/null || true
		echo 1 1500 4000 > "$lim" 2>/dev/null || true
		echo 2 2500 6000 > "$lim" 2>/dev/null || true
		echo 3 2500 6000 > "$lim" 2>/dev/null || true
	done
}

[ "$1" = apply-uci ] && {
	uci_apply
	command -v tc >/dev/null 2>&1 || apk add tc-tiny >/dev/null 2>&1 || true
}

[ -f /etc/sysctl.d/99-hotel-perf.conf ] && sysctl -qp /etc/sysctl.d/99-hotel-perf.conf 2>/dev/null || true

[ -w /proc/irq/122/smp_affinity ] && echo 2 > /proc/irq/122/smp_affinity 2>/dev/null || true
[ -w /proc/irq/123/smp_affinity ] && echo 4 > /proc/irq/123/smp_affinity 2>/dev/null || true
[ -w /proc/irq/119/smp_affinity ] && echo 8 > /proc/irq/119/smp_affinity 2>/dev/null || true
[ -w /proc/irq/133/smp_affinity ] && echo 1 > /proc/irq/133/smp_affinity 2>/dev/null || true

rps_on eth0
rps_on wan
rps_on br-lan
rps_on phy0-ap0
rps_on phy1-ap0
for d in /sys/class/net/phy*-sta*; do
	[ -e "$d" ] || continue
	rps_on "${d##*/}"
done
n=1
while [ "$n" -le 20 ]; do
	rps_on "vwan$n"
	n=$((n + 1))
done

v6off wan
v6off eth0
v6off br-lan
v6off lan1
v6off lan2
v6off lan3
v6off lan4
v6off phy0-ap0
v6off phy1-ap0
n=1
while [ "$n" -le 20 ]; do
	v6off "vwan$n"
	n=$((n + 1))
done
for d in /sys/class/net/phy*-sta*; do
	[ -e "$d" ] || continue
	v6off "${d##*/}"
done

aql_tune
wan_sqm
exit 0
