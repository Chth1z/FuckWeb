#!/usr/bin/env python3
"""Deploy hotel-suite to ImmortalWrt router. Requires HOTEL_ROUTER_PASS env."""
import os
import posixpath
import sys

import paramiko

HOST = os.environ.get("HOTEL_ROUTER_HOST", "192.168.16.1")
USER = os.environ.get("HOTEL_ROUTER_USER", "root")
PASS = os.environ.get("HOTEL_ROUTER_PASS", "")
ROOT = os.path.join(os.path.dirname(__file__), "..", "hotel-suite")
BINARY_EXT = {
    ".gz", ".srs", ".db", ".so", ".png", ".ico", ".jpg", ".jpeg",
    ".webp", ".ttf", ".woff", ".woff2", ".gif",
}


def ssh():
    if not PASS:
        print("Set HOTEL_ROUTER_PASS", file=sys.stderr)
        sys.exit(2)
    c = paramiko.SSHClient()
    c.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    c.connect(HOST, username=USER, password=PASS, timeout=15, allow_agent=False, look_for_keys=False)
    return c


def run(c, cmd, timeout=180):
    _, o, e = c.exec_command(cmd, timeout=timeout)
    out = o.read().decode("utf-8", "replace")
    err = e.read().decode("utf-8", "replace")
    return o.channel.recv_exit_status(), out, err


def put(c, local, remote, binary):
    data = open(local, "rb").read()
    if not binary:
        data = data.replace(b"\r\n", b"\n")
    stdin, stdout, stderr = c.exec_command(f"cat > {remote}")
    chan = stdin.channel
    view = memoryview(data)
    off = 0
    while off < len(view):
        sent = chan.send(view[off : off + 32768])
        if sent == 0:
            raise RuntimeError(f"put stalled {remote}")
        off += sent
    chan.shutdown_write()
    stdout.read()
    if chan.recv_exit_status() != 0:
        raise RuntimeError(f"put failed {remote}: {stderr.read()!r}")


def main():
    files = []
    for dirpath, _, filenames in os.walk(ROOT):
        for name in filenames:
            local = os.path.join(dirpath, name)
            rel = os.path.relpath(local, ROOT).replace("\\", "/")
            remote = posixpath.join("/", rel)
            files.append((local, remote, os.path.splitext(name)[1].lower() in BINARY_EXT))
    files.sort(key=lambda x: (x[2], x[1]))

    c = ssh()
    run(
        c,
        "mkdir -p /etc/hotel/ruleset /usr/lib/hotel /usr/lib/hotel/datapath "
        "/usr/share/hotel /tmp/hotel /var/run /etc/sysctl.d",
    )

    for local, remote, binary in files:
        run(c, f"mkdir -p {posixpath.dirname(remote)}")
        put(c, local, remote, binary)
        print("PUT", remote)

    scripts = [
        "/usr/lib/hotel/common.sh", "/usr/lib/hotel/datapath.sh",
        "/usr/lib/hotel/datapath/ecmp10.sh", "/usr/lib/hotel/datapath/plain.sh",
        "/usr/lib/hotel/doctor.sh", "/usr/sbin/hotel-guard.sh",
        "/usr/sbin/hotel-multidial.sh", "/usr/sbin/hotel-observe.sh",
        "/usr/sbin/hotel-dns.sh", "/usr/sbin/hotel-led.sh", "/usr/sbin/hotelctl",
        "/usr/sbin/hotel-perf.sh", "/usr/sbin/hotel-panic.sh",
        "/usr/sbin/hotel-split.sh", "/usr/sbin/hotel-proxy.sh",
        "/usr/sbin/hotel-portal-auth.sh",
    ]
    for p in scripts:
        code, out, err = run(c, f"sh -n {p}; echo rc:$?")
        if "rc:0" not in out:
            print("SYNTAX_FAIL", p, out, err, file=sys.stderr)
            sys.exit(1)

    run(
        c,
        """
chmod 755 /usr/lib/hotel/common.sh /usr/lib/hotel/datapath.sh \
  /usr/lib/hotel/datapath/ecmp10.sh /usr/lib/hotel/datapath/plain.sh \
  /usr/lib/hotel/doctor.sh /usr/sbin/hotel-guard.sh \
  /usr/sbin/hotel-multidial.sh /usr/sbin/hotel-observe.sh \
  /usr/sbin/hotel-dns.sh /usr/sbin/hotel-led.sh /usr/sbin/hotelctl \
  /usr/sbin/hotel-perf.sh /usr/sbin/hotel-panic.sh /usr/sbin/hotel-split.sh \
  /usr/sbin/hotel-proxy.sh /usr/sbin/hotel-portal-auth.sh
/usr/sbin/hotel-perf.sh apply-uci >/dev/null 2>&1 || true
/usr/sbin/hotel-split.sh >/dev/null 2>&1 || true
/usr/sbin/hotel-dns.sh apply >/tmp/hotel/dns.log 2>&1 || true
/usr/sbin/hotel-multidial.sh >/tmp/hotel-multidial.log 2>&1 || true
/etc/init.d/hotel-proxy restart >/tmp/hotel/proxy-restart.log 2>&1 || true
/usr/sbin/hotel-proxy.sh hook >/dev/null 2>&1 || true
/usr/sbin/hotel-observe.sh --led >/dev/null 2>&1 || true
hotelctl doctor json
""",
        timeout=240,
    )

    code, out, err = run(c, "hotelctl doctor json")
    print(out)
    if '"ok":0' in out.replace(" ", ""):
        print("DOCTOR_FAIL", file=sys.stderr)
        sys.exit(1)
    c.close()
    print("DEPLOY_OK")


if __name__ == "__main__":
    main()
