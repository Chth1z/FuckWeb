#!/usr/bin/env python3
"""Read-only network experience probe for hotel-suite router."""
import json
import os
import sys

import paramiko

HOST = os.environ.get("HOTEL_ROUTER_HOST", "192.168.16.1")
USER = os.environ.get("HOTEL_ROUTER_USER", "root")
PASS = os.environ.get("HOTEL_ROUTER_PASS", "")


def run(c, cmd, timeout=90):
    _, o, e = c.exec_command(cmd, timeout=timeout)
    return o.read().decode("utf-8", "replace"), e.read().decode("utf-8", "replace")


def main():
    if not PASS:
        print("Set HOTEL_ROUTER_PASS", file=sys.stderr)
        sys.exit(2)
    c = paramiko.SSHClient()
    c.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    c.connect(HOST, username=USER, password=PASS, timeout=15, allow_agent=False, look_for_keys=False)

    script = r"""
set -e
echo '=== STATUS ==='
cat /tmp/hotel/status.json 2>/dev/null || echo '{}'
echo '=== DOCTOR ==='
hotelctl doctor json 2>/dev/null || /usr/lib/hotel/doctor.sh json
echo '=== POLICY ==='
cat /etc/hotel/policy
echo '=== SYSCTL PERF ==='
sysctl net.core.rmem_max net.core.wmem_max net.ipv4.tcp_fastopen \
  net.ipv4.tcp_congestion_control net.netfilter.nf_conntrack_count \
  net.netfilter.nf_conntrack_max 2>/dev/null
echo '=== SQM ==='
tc -s qdisc show dev wan 2>/dev/null
echo '=== WIFI PHY0 ==='
iw dev phy0-ap0 link 2>/dev/null; iw dev phy0-ap0 station dump 2>/dev/null | head -40
echo '=== WIFI PHY1 ==='
iw dev phy1-ap0 link 2>/dev/null; iw dev phy1-ap0 station dump 2>/dev/null | head -40
echo '=== WIFI UCI ==='
uci show wireless.default_radio0 wireless.default_radio1 wireless.radio0 wireless.radio1 2>/dev/null
echo '=== FIREWALL PERF ==='
uci show firewall.@defaults[0] 2>/dev/null | grep -E 'offload|fullcone|synflood'
echo '=== DNS BENCH ==='
for h in www.baidu.com www.qq.com github.com google.com cloudflare.com; do
  t=$( (date +%s%3N; nslookup $h 127.0.0.1 2>/dev/null | tail -1; date +%s%3N) | awk 'NR==1{s=$1} END{print $1-s}')
  echo "$h ${t}ms"
done
echo '=== DNS PATH ==='
grep -E '^(bind|server|server-https|nameserver|speed-check|response-mode|cache-size)' /tmp/hotel/smartdns.conf 2>/dev/null | head -20
echo '=== PROXY DELAY ==='
SEC=$(cat /etc/hotel/clash.secret 2>/dev/null)
LAN=$(cat /tmp/hotel/lan.ip 2>/dev/null)
for p in AUTO PROXY DIRECT; do
  body=$(curl -4 -m 12 -sS -H "Authorization: Bearer $SEC" \
    "http://${LAN}:9090/proxies/${p}/delay?timeout=8000&url=https%3A%2F%2Fcp.cloudflare.com%2Fgenerate_204" 2>/dev/null || echo '{}')
  echo "$p $body"
done
echo '=== CURL CN ==='
for u in http://www.baidu.com http://www.qq.com; do
  curl -4 -m 8 -sS -o /dev/null -w "$u code=%{http_code} dns=%{time_namelookup} conn=%{time_connect} ttfb=%{time_starttransfer} total=%{time_total}\n" "$u" 2>/dev/null || echo "$u FAIL"
done
echo '=== CURL PROXY ==='
for u in https://www.google.com https://github.com; do
  curl -4 -m 15 -sS -o /dev/null -w "$u code=%{http_code} dns=%{time_namelookup} conn=%{time_connect} ttfb=%{time_starttransfer} total=%{time_total}\n" "$u" 2>/dev/null || echo "$u FAIL"
done
echo '=== LEGS TTFB ==='
awk -F'\t' '{printf "%s http=%s ttfb=%.3f rx=%s\n", $1,$6,$7,$4}' /tmp/hotel/legs.tsv 2>/dev/null | sort -t= -k3 -n
echo '=== HARVEST ==='
echo "gini=$(grep -o '"gini":[0-9.]*' /tmp/hotel/status.json)"
echo "scores=$(grep -o '"scores":{[^}]*}' /tmp/hotel/status.json | head -c 500)"
echo '=== CONNTRACK TOP ==='
cat /proc/net/nf_conntrack 2>/dev/null | awk '{print $4}' | sort | uniq -c | sort -rn | head -8
echo '=== RECENT EVENTS ==='
tail -15 /tmp/hotel/events.log 2>/dev/null
echo '=== ROUTES DEFAULT ==='
ip route show table main | grep '^default'
echo '=== MIHOMO YAML SNIP ==='
grep -E '^(mode:|tcp-concurrent:|keep-alive|unified-delay|find-process)' /etc/hotel/mihomo.yaml 2>/dev/null
"""
    out, err = run(c, script, timeout=120)
    c.close()
    path = os.path.join(os.path.dirname(__file__), "experience_probe.txt")
    with open(path, "w", encoding="utf-8") as f:
        f.write(out)
        if err.strip():
            f.write("\n=== STDERR ===\n")
            f.write(err)
    print(path)


if __name__ == "__main__":
    main()
