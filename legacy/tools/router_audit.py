#!/usr/bin/env python3
"""Comprehensive hotel-suite router audit. Credentials from env."""
import json
import os
import sys

import paramiko

HOST = os.environ.get("HOTEL_ROUTER_HOST", "192.168.16.1")
USER = os.environ.get("HOTEL_ROUTER_USER", "root")
PASS = os.environ.get("HOTEL_ROUTER_PASS", "")


def run(c, cmd, timeout=60):
    _, o, e = c.exec_command(cmd, timeout=timeout)
    out = o.read().decode("utf-8", "replace")
    err = e.read().decode("utf-8", "replace")
    code = o.channel.recv_exit_status()
    return code, out, err


def main():
    if not PASS:
        print("Set HOTEL_ROUTER_PASS", file=sys.stderr)
        sys.exit(2)
    c = paramiko.SSHClient()
    c.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    c.connect(HOST, username=USER, password=PASS, timeout=15, allow_agent=False, look_for_keys=False)

    sections = {}

    _, out, _ = run(c, "hotelctl doctor json 2>/dev/null || /usr/lib/hotel/doctor.sh json")
    try:
        sections["doctor"] = json.loads(out.strip().split("\n")[-1])
    except json.JSONDecodeError:
        sections["doctor_raw"] = out

    _, out, _ = run(c, "cat /tmp/hotel/status.json 2>/dev/null")
    try:
        sections["status"] = json.loads(out)
    except json.JSONDecodeError:
        sections["status_raw"] = out[:2000]

    checks = {
        "uptime_load": "uptime; cat /proc/loadavg",
        "mem_disk": "free -m; df -h /overlay /tmp",
        "conntrack": "cat /proc/sys/net/netfilter/nf_conntrack_count /proc/sys/net/netfilter/nf_conntrack_max",
        "wan_phy": "cat /sys/class/net/wan/speed /sys/class/net/wan/carrier /sys/class/net/wan/operstate 2>/dev/null",
        "sqm": "tc -s qdisc show dev wan 2>/dev/null",
        "routes_dup": "ip route show table main | grep '^default'",
        "legs_probe": "awk -F'\\t' '{print $1,$6,$7}' /tmp/hotel/legs.tsv 2>/dev/null",
        "hash_marks": "cat /tmp/hotel/hash.marks /tmp/hotel-online 2>/dev/null",
        "led_file": "cat /tmp/hotel/led 2>/dev/null",
        "wifi_guard_state": "cat /tmp/hotel/wifi.act.* /tmp/hotel/wifi.bad /tmp/hotel/wifi.recover.ts 2>/dev/null; ls /tmp/hotel/wifi.* 2>/dev/null",
        "events_tail": "tail -30 /tmp/hotel/events.log 2>/dev/null",
        "cron": "cat /etc/crontabs/root 2>/dev/null",
        "init_enabled": "ls /etc/rc.d/S*hotel* /etc/rc.d/S*smartdns* 2>/dev/null",
        "watchdog": "ls -la /dev/watchdog* 2>/dev/null; uci show system.@system[0].watchdog 2>/dev/null",
        "listen_ports": "netstat -lntp 2>/dev/null",
        "secret_perms": "ls -la /etc/hotel/clash.secret /etc/hotel/proxy-nodes.json /etc/hotel/mihomo.yaml /etc/hotel-portal.code 2>/dev/null",
        "mihomo_mem": "ps w | grep mihomo | grep -v grep",
        "nft_tproxy": "nft list chain inet hotel_split tproxy_pre 2>/dev/null",
        "nft_hijack": "nft list chain inet hotel_split dns_hijack 2>/dev/null",
        "dns_chain": "hotelctl dns status 2>/dev/null",
        "proxy_chain": "hotelctl proxy status 2>/dev/null",
        "hotplug_iface": "cat /etc/hotplug.d/iface/99-hotel-multidial 2>/dev/null | head -20",
        "hotplug_net": "cat /etc/hotplug.d/net/99-hotel-perf 2>/dev/null",
        "rc_local": "cat /etc/rc.local 2>/dev/null",
        "portal_auth": "ls -la /usr/sbin/hotel-portal-auth.sh 2>/dev/null; head -5 /usr/sbin/hotel-portal-auth.sh 2>/dev/null",
        "version_diff": "md5sum /usr/sbin/hotel-led.sh /usr/sbin/hotel-guard.sh /usr/lib/hotel/doctor.sh 2>/dev/null",
        "dns_latency": "for h in www.baidu.com www.google.com github.com; do nslookup $h 127.0.0.1 2>/dev/null | tail -2; done",
        "canary_history": "cat /tmp/hotel/canary.code /tmp/hotel/canary.fail /tmp/hotel/canary.ok 2>/dev/null",
    }

    for name, cmd in checks.items():
        _, out, err = run(c, cmd)
        sections[name] = out.strip()
        if err.strip():
            sections[name + "_err"] = err.strip()[:500]

    c.close()

    report_path = os.path.join(os.path.dirname(__file__), "audit_report.json")
    with open(report_path, "w", encoding="utf-8") as f:
        json.dump(sections, f, ensure_ascii=False, indent=2)
    print(report_path)
    return sections


if __name__ == "__main__":
    main()
