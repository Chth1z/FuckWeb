#!/bin/sh
# Run on the router after rehearsal. Three isolated namespaces, no Internet.
# All target addresses below are assigned to the isolated test WAN namespace.
set -eu
BASE=${1:-/tmp/prism-rehearsal/run/plan}
C=bp-c-$$
R=bp-r-$$
W=bp-w-$$
fixture=$(mktemp -d /tmp/prism-privacy.XXXXXX)
cleanup() {
    rm -rf "$fixture"
    for ns in "$C" "$R" "$W"; do ip netns delete "$ns" 2>/dev/null || true; done
}
trap cleanup EXIT INT TERM
ip netns add "$C"
ip netns add "$R"
ip netns add "$W"
ip -n "$C" link add eth0 type veth peer name br-lan netns "$R"
ip -n "$R" link add wan type veth peer name eth0 netns "$W"
for ns in "$C" "$R" "$W"; do ip -n "$ns" link set lo up; done
ip -n "$C" addr add 10.200.0.2/24 dev eth0
ip -n "$C" link set eth0 up
ip -n "$C" route add default via 10.200.0.1
ip -n "$R" addr add 10.200.0.1/24 dev br-lan
ip -n "$R" addr add 10.201.0.1/24 dev wan
ip -n "$R" addr add 198.51.100.1/32 dev lo
ip -n "$R" link set br-lan up
ip -n "$R" link set wan up
ip -n "$R" route add default via 10.201.0.2
ip -n "$R" rule add pref 50 fwmark 0x4000/0x4000 lookup 100
ip -n "$R" route add local default dev lo table 100
ip -n "$W" addr add 10.201.0.2/24 dev eth0
ip -n "$W" link set eth0 up
ip -n "$W" route add default via 10.201.0.1
for ns in "$C" "$R" "$W"; do ip netns exec "$ns" sysctl -qw net.ipv6.conf.all.disable_ipv6=0; done
ip -n "$C" -6 addr add fd00:200::2/64 dev eth0 nodad
ip -n "$C" -6 route add default via fd00:200::1
ip -n "$R" -6 addr add fd00:200::1/64 dev br-lan nodad
ip -n "$R" -6 addr add fd00:201::1/64 dev wan nodad
ip -n "$R" -6 route add default via fd00:201::2
ip -n "$W" -6 addr add fd00:201::2/64 dev eth0 nodad
ip -n "$W" -6 addr add 2001:db8:777::1/128 dev lo nodad
ip -n "$W" -6 route add default via fd00:201::1
for addr in 223.5.5.5 203.0.113.10 18.176.216.3; do ip -n "$W" addr add "$addr/32" dev lo; done
ip netns exec "$R" sysctl -qw net.ipv4.ip_forward=1
ip netns exec "$R" sysctl -qw net.ipv6.conf.all.forwarding=1
ip netns exec "$C" ping -6 -c 3 -W 2 2001:db8:777::1 >/dev/null
ip netns exec "$R" nft -f "$BASE/ruleset.nft"
ip netns exec "$R" nft -f "$BASE/guard.nft"
# Exercise the production shaper exclusively on this namespace's veth.
(cd /tmp/prism-rehearsal/tree/usr/share/prism && ip netns exec "$R" ucode -S -e '
import { shape } from "./mod/host.uc";
for (let rate in [95, 9]) {
	assert(shape("wan", rate), "expected HTB update");
	assert(!shape("wan", rate), "HTB did not converge");
}
print("PASS shaper 95 and 9 Mbit/s idempotent\n");
')
ip netns exec "$W" nft -f - <<'NFT'
table inet audit {
 counter seen {}
 chain input { type filter hook input priority 0; policy accept;
  meta l4proto tcp counter name seen
 }
}
NFT
probe() {
    want=$1 addr=$2 port=$3 label=$4
    ip netns exec "$W" nft reset counter inet audit seen >/dev/null
    ip netns exec "$C" curl --noproxy '*' --connect-timeout 1 --max-time 1 -s "http://$addr:$port/" >/dev/null 2>&1 || true
    got=$(ip netns exec "$W" nft list counter inet audit seen | awk '/packets/ { print $2 }')
    if { [ "$want" = pass ] && [ "$got" -gt 0 ]; } || { [ "$want" = block ] && [ "$got" -eq 0 ]; }; then
        echo "PASS $label ($got WAN packets)"
    else
        echo "FAIL $label: want=$want WAN packets=$got" >&2
        exit 1
    fi
}
probe block 223.5.5.5 8080 unverified_domestic
# sysfs can reflect the parent mount's netns. Ask rtnetlink for the namespace device.
client_mac=$(ip -n "$C" -o link show dev eth0 | awk '{for(i=1;i<=NF;i++) if($i=="link/ether") print $(i+1)}')
for t in prism prism_guard; do
    ip netns exec "$R" nft add element inet "$t" verified_pairs "{ $client_mac . 10.200.0.2 }"
done
ip netns exec "$R" nft -f - <<'NFT'
table inet check_marks {
 counter approved {}
 counter egress {}
 chain forward { type filter hook forward priority 0; policy accept;
  ip daddr 223.5.5.5 meta mark & 0x20000000 != 0 ct mark & 0x20000000 == 0 counter name approved
 }
 chain post { type filter hook postrouting priority 0; policy accept;
  oifname "wan" counter name egress
 }
}
NFT
strand_pkts() {
    ip netns exec "$R" nft -j list set inet prism strands_up |
        jsonfilter -e '@.nftables[*].set.elem[@.elem.val="wan"].elem.counter.packets'
}
before=$(strand_pkts)
probe pass 223.5.5.5 8080 domestic_direct_live
after=$(strand_pkts)
egress=$(ip netns exec "$R" nft list counter inet check_marks egress | awk '/packets/ {print $2}')
[ "$egress" -gt 0 ] && [ "$((after-before))" -eq "$egress" ] || exit 1
echo "PASS single WAN accounting ($egress packets)"
approved=$(ip netns exec "$R" nft list counter inet check_marks approved | awk '/packets/ {print $2}')
[ "$approved" -gt 0 ]
echo "PASS direct authorization only on packet mark ($approved packets)"
probe block 18.176.216.3 80 unapproved_relay_port_live
probe block 203.0.113.10 8080 foreign_tunnel_without_listener
ip netns exec "$R" nft add element inet prism tunnel4 '{ 223.5.5.5 }'
probe block 223.5.5.5 8080 forced_tunnel_precedes_domestic
ip netns exec "$R" nft delete table inet prism
probe block 223.5.5.5 8080 domestic_closed_after_service_stop
probe block 203.0.113.10 8080 foreign_closed_after_service_stop
probe pass 18.176.216.3 443 proxy_transport_survives_stop
probe pass 18.176.216.3 22 ssh_maintenance_survives_stop
probe block 18.176.216.3 80 other_relay_ports_closed
probe block 223.5.5.5 53 dns_intercept_survives_stop
probe block 223.5.5.5 853 dot_rejected_after_stop
probe block '[2001:db8:777::1]' 8080 ipv6_closed_after_stop
# Exercise the shipped fw4 include before first policy generation and after persistence.
include=/tmp/prism-rehearsal/tree/usr/share/nftables.d/ruleset-post/30-prism-guard.nft
sed "s@/etc/prism/@$fixture/@" "$include" > "$fixture/reload.nft"
ip netns exec "$R" nft -f "$fixture/reload.nft"
probe block 18.176.216.3 443 first_boot_without_policy
cp "$BASE/guard.nft" "$fixture/guard.nft"
echo "add element inet prism_guard verified_pairs { $client_mac . 10.200.0.2 }" >> "$fixture/guard.nft"
ip netns exec "$R" nft -f "$fixture/reload.nft"
probe pass 18.176.216.3 443 relay_after_guard_reload
probe block 203.0.113.10 8080 firewall_reload_without_prism
echo 'PRIVACY_NETNS_OK'
