#!/bin/sh
# Read-only snapshot of the live router. Run through ssh with this file on
# stdin; a tar.gz comes back on stdout. Secrets are redacted or left behind.
main() {
S=/tmp/prism-snap.$$
mkdir -p "$S/info" "$S/root" || exit 1
RED='s/\(key\|password\|passwd\|sae_password\|secret\|uuid\|public-key\|short-id\|identity\|username\)\([^A-Za-z]*[=:][ ]*\).*/\1\2REDACTED/'
export RED
cap() { n="$1"; shift; echo "snap: $n" >&2; sh -c "$*" > "$S/info/$n" 2>&1 </dev/null; }

cap release 'cat /etc/openwrt_release; uname -a; cat /tmp/sysinfo/model /tmp/sysinfo/board_name; grep -c ^processor /proc/cpuinfo; uptime; free; df -h; date'
cap pkgs 'apk list -I 2>/dev/null || apk info -v 2>/dev/null || opkg list-installed'
cap tools 'for b in ucode lua luajit python3 jq curl wget nft tc ip ethtool flock timeout resolveip iw iwinfo smartdns dnsmasq mwan3 sing-box xray; do printf "%s=" $b; command -v $b || echo -; done; ls -la /usr/lib/ucode /usr/share/ucode /usr/lib/lua 2>&1; nft --version; readlink -f $(command -v ip); readlink -f $(command -v tc)'
cap nft_terse 'nft -t list ruleset'
cap nft_prism 'nft -t list table inet prism; nft list set inet prism strands; nft list map inet prism pattern; nft list set inet prism relay4; nft list set inet prism tunnel4_dns; nft list chain inet prism classify; nft list chain inet prism weave'
cap ip_link 'ip -br link; echo; ip -d link show'
cap ip_addr 'ip -4 -br addr; echo; ip -6 -br addr'
cap ip_rule 'ip rule; echo; ip -6 rule'
cap ip_route 'ip route show table all | grep -v "^broadcast\|^local "'
cap ubus_iface 'ubus call network.interface dump'
cap ubus_dev 'ubus call network.device status'
cap ubus_list 'ubus list'
cap ubus_service 'ubus call service list | sed "$RED"'
for c in prism network firewall dhcp system uhttpd dropbear wireless; do
	cap "uci_$c" "uci -q show $c | sed \"$RED\""
done
cap rc 'ls -la /etc/rc.d /etc/init.d; echo; cat /etc/crontabs/root; echo; cat /etc/rc.local; echo; cat /etc/sysupgrade.conf; ls -la /lib/upgrade/keep.d'
cap ps 'ps w; echo; top -bn1 | head -30; echo; for p in mihomo smartdns dnsmasq hostapd; do for i in $(pidof $p); do echo $p $i; grep -E "VmRSS|VmSize|Threads" /proc/$i/status; done; done'
cap listen 'netstat -lntup'
cap state_ls 'ls -la /tmp/prism /etc/prism /etc/prism/lists /usr/share/prism /usr/share/prism/lib /usr/share/prism/mod 2>&1'
cap state_json 'for f in status.json doctor.json smartdns.conf; do echo "=== $f"; cat /tmp/prism/$f; echo; done; prism strands'
cap events 'tail -n 400 /tmp/prism/events.log'
cap mihomo '/tmp/prism/mihomo -v; echo; sed "s/\(\"\(server\|password\|uuid\|public-key\|short-id\|secret\|sni\|servername\|obfs-password\)\": \)\"[^\"]*\"/\1\"REDACTED\"/" /tmp/prism/mihomo.yaml'
cap dns 'smartdns -v 2>&1 | head -3; dnsmasq -v 2>&1 | head -4; echo; for f in /var/etc/dnsmasq.conf.* /tmp/resolv.conf /tmp/resolv.conf.auto /tmp/resolv.conf.d/*; do echo "=== $f"; cat $f; done; ls -la /tmp/dnsmasq.d /tmp/dnsmasq.*.d 2>&1'
cap dns_test 'for h in www.taobao.com www.bilibili.com api.anthropic.com www.google.com; do echo "--- $h"; nslookup $h 127.0.0.1 2>&1 | tail -n 6; done
echo "--- udp53 to TEST-NET (reply means the network intercepts 53)"; nslookup www.baidu.com 203.0.113.53 2>&1 | tail -n 5
echo "--- udp53 alidns"; nslookup www.taobao.com 223.5.5.5 2>&1 | tail -n 5
echo "--- ali doh verify"; curl -4 -m 8 -sS -o /dev/null -w "http=%{http_code} verify=%{ssl_verify_result} t=%{time_total}\n" --resolve dns.alidns.com:443:223.5.5.5 "https://dns.alidns.com/resolve?name=www.taobao.com&type=A" 2>&1
echo "--- ali doh issuer"; curl -4 -m 8 -skv -o /dev/null --resolve dns.alidns.com:443:223.5.5.5 "https://dns.alidns.com/resolve?name=www.taobao.com&type=A" 2>&1 | grep -iE "issuer|subject|SSL connection" 
echo "--- dnspod doh"; curl -4 -m 8 -sS -o /dev/null -w "http=%{http_code} verify=%{ssl_verify_result} t=%{time_total}\n" --resolve doh.pub:443:1.12.12.12 "https://doh.pub/dns-query?name=www.taobao.com&type=A" 2>&1
echo "--- ali dot 853"; sh -c "echo | openssl s_client -connect 223.5.5.5:853 -servername dns.alidns.com 2>&1 | grep -iE \"issuer|verify return\"" 2>&1'
cap tc 'tc -s qdisc show; echo; tc -s class show dev wan'
cap sysctl 'sysctl -a 2>/dev/null | grep -E "tcp_congestion|available_congestion|multipath|conntrack_max|conntrack_count|ip_forward |\.all\.|\.default\.|\.wan\.|tcp_fastopen|default_qdisc|somaxconn"'
cap kernel 'lsmod; echo; cat /proc/interrupts; echo; ls /sys/class/leds; ls /sys/kernel/debug/ieee80211 2>&1'
cap wifi 'iw dev; echo; iwinfo 2>&1; echo; ubus call network.wireless status | sed "$RED"'
cap logs 'logread | tail -n 500; echo ===dmesg; dmesg | tail -n 120'
cap hashes 'find /usr/share/prism /usr/sbin/prism /etc/init.d/prism /etc/config/prism /etc/sysctl.d /etc/prism -type f ! -path "*/zashboard/*" 2>/dev/null | sort | xargs md5sum'
cap conntrack 'cat /proc/sys/net/netfilter/nf_conntrack_count; cat /proc/net/stat/nf_conntrack | head -3'

for p in /usr/share/prism/prism.uc /usr/share/prism/prismd.uc /usr/share/prism/lib 	/usr/share/prism/mod /usr/share/prism/portal /usr/share/prism/tpl /usr/sbin/prism 	/etc/init.d/prism /etc/config/prism /etc/prism/lists /etc/prism/provision.json 	/etc/prism/ARCHITECTURE.md /usr/share/rpcd/acl.d/prism.json /www/prism /etc/sysctl.d /etc/crontabs/root /etc/rc.local /etc/nftables.d; do
	[ -e "$p" ] || continue
	mkdir -p "$S/root$(dirname "$p")"
	cp -a "$p" "$S/root$(dirname "$p")/" 2>/dev/null
done
echo "snap: packing" >&2
tar czf - -C "$S" info root
rm -rf "$S"
echo "snap: done" >&2
}
main </dev/null
