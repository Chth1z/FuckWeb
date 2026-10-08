#!/usr/bin/env python3
import os, paramiko
PASS = os.environ.get("HOTEL_ROUTER_PASS", "")
c = paramiko.SSHClient()
c.set_missing_host_key_policy(paramiko.AutoAddPolicy())
c.connect("192.168.16.1", username="root", password=PASS, timeout=15, allow_agent=False, look_for_keys=False)
script = r"""
uci show wireless.default_radio0 2>/dev/null | head -15
uci show wireless.default_radio1 2>/dev/null | head -15
echo '--- DNS ---'
for h in www.baidu.com github.com google.com; do
  echo "== $h =="
  nslookup $h 127.0.0.1 2>&1 | tail -4
done
echo '--- CURL CN ---'
curl -4 -m 10 -sS -o /dev/null -w 'baidu dns=%{time_namelookup} conn=%{time_connect} ttfb=%{time_starttransfer} total=%{time_total}\n' http://www.baidu.com || echo baidu FAIL
curl -4 -m 10 -sS -o /dev/null -w 'qq dns=%{time_namelookup} conn=%{time_connect} ttfb=%{time_starttransfer} total=%{time_total}\n' http://www.qq.com || echo qq FAIL
echo '--- CURL PROXY ---'
curl -4 -m 15 -sS -o /dev/null -w 'google dns=%{time_namelookup} conn=%{time_connect} ttfb=%{time_starttransfer} total=%{time_total}\n' https://www.google.com || echo google FAIL
curl -4 -m 15 -sS -o /dev/null -w 'github dns=%{time_namelookup} conn=%{time_connect} ttfb=%{time_starttransfer} total=%{time_total}\n' https://github.com || echo github FAIL
echo '--- PROXY DELAY ---'
SEC=$(cat /etc/hotel/clash.secret)
LAN=$(cat /tmp/hotel/lan.ip)
for p in AUTO DIRECT; do
  echo -n "$p "
  curl -4 -m 12 -sS -H "Authorization: Bearer $SEC" "http://${LAN}:9090/proxies/${p}/delay?timeout=8000&url=https%3A%2F%2Fcp.cloudflare.com%2Fgenerate_204"
  echo
done
echo '--- LEGS TTFB sort ---'
awk -F'\t' '{printf "%s ttfb=%s\n", $1, $7}' /tmp/hotel/legs.tsv | sort -t= -k2 -n | head -6
echo '--- worst ---'
awk -F'\t' '{printf "%s ttfb=%s\n", $1, $7}' /tmp/hotel/legs.tsv | sort -t= -k2 -nr | head -3
"""
_, o, _ = c.exec_command(script, timeout=90)
print(o.read().decode("utf-8", "replace"))
c.close()
