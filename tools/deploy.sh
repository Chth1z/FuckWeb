#!/bin/sh
# Push the prism tree to the router and reload it. Rolls back to the previous
# code if the health report is not clean afterwards.
#   tools/deploy.sh            code, lists and the dashboard page
#   tools/deploy.sh --config   also /etc/config/prism. The router owns that
#                              file (the dashboard writes sites, devices and
#                              settings into it), so this overwrites them.
#   tools/deploy.sh --assets   also mihomo.gz, the domain lists and zashboard
#   tools/deploy.sh --secrets  also relays.json
set -e
cd "$(dirname "$0")/.."
ASSETS=0
SECRETS=0
CONFIG=0
for a in "$@"; do
	case "$a" in
		--assets) ASSETS=1 ;;
		--secrets) SECRETS=1 ;;
		--config) CONFIG=1 ;;
		*) echo "usage: $0 [--config] [--assets] [--secrets]"; exit 1 ;;
	esac
done

if grep -rlI "$(printf '\r')" prism --exclude-dir=zashboard >/dev/null; then
	echo "CRLF line endings in prism/; fix before deploying" >&2
	exit 1
fi

if [ -f tools/version.sh ]; then
	sh tools/version.sh --check
fi

EXCLUDE=""
[ "$ASSETS" = 1 ] || EXCLUDE="--exclude=*.gz --exclude=zashboard"
[ "$SECRETS" = 1 ] || EXCLUDE="$EXCLUDE --exclude=relays.json"
[ "$CONFIG" = 1 ] || EXCLUDE="$EXCLUDE --exclude=./etc/config/prism"

STAGE=/tmp/prism-stage
# shellcheck disable=SC2086
tar czf - --owner=0 --group=0 -C prism $EXCLUDE . |
	tools/rsh "rm -rf $STAGE && mkdir -p $STAGE/tree && tar xzf - -C $STAGE/tree"

tools/rsh sh -s <<'REMOTE'
set -e
STAGE=/tmp/prism-stage
PREV=/tmp/prism-prev.tgz
KEEP="etc/config/prism etc/hotplug.d/dhcp/50-prism etc/init.d/prism etc/prism/lists etc/prism/guard.nft etc/prism/provision.json etc/sysctl.d/99-prism.conf lib/upgrade/keep.d/prism usr/sbin/prism usr/share/prism/VERSION usr/share/prism/prism.uc usr/share/prism/prismd.uc usr/share/prism/bin usr/share/prism/lib usr/share/prism/mod usr/share/prism/portal usr/share/prism/tpl usr/share/nftables.d/ruleset-post/30-prism-guard.nft usr/share/rpcd/acl.d/prism.json www/prism"
guard_before=0
[ ! -f /etc/prism/guard.nft ] || guard_before=1

cd /
have=""
for f in $KEEP; do [ -e "$f" ] && have="$have $f"; done
[ -n "$have" ] && tar czf "$PREV" $have
acl_before=$(md5sum /usr/share/rpcd/acl.d/prism.json 2>/dev/null | cut -d' ' -f1)
dhcp_before=$(md5sum /etc/hotplug.d/dhcp/50-prism 2>/dev/null | cut -d' ' -f1)

rm -rf /www/prism/css /www/prism/js
cp -a "$STAGE/tree/." /
chmod -R u=rwX,go=rX /www/prism 2>/dev/null || true
for pid in $(ps w | awk '/braidd\.uc/{print $1}'); do
	kill -9 "$pid" 2>/dev/null || true
done
if [ -d /etc/braid ] || [ -d /usr/share/braid ] || [ -x /etc/init.d/braid ]; then
	if [ -x /etc/init.d/braid ]; then
		/etc/init.d/braid disable 2>/dev/null || true
		/etc/init.d/braid stop 2>/dev/null || true
	fi
	mkdir -p /etc/prism /etc/prism/state /usr/share/prism /tmp/prism
	for f in relays.json controller.secret portal.secret zashboard; do
		[ -e "/etc/braid/$f" ] && [ ! -e "/etc/prism/$f" ] && cp -a "/etc/braid/$f" "/etc/prism/$f"
	done
	for f in selected.json portal_ip.txt; do
		[ -f "/etc/braid/state/$f" ] && [ ! -f "/etc/prism/state/$f" ] && cp -a "/etc/braid/state/$f" "/etc/prism/state/$f"
	done
	for f in mihomo.gz cn-domains.gz ad-domains.gz; do
		[ -f "/usr/share/braid/$f" ] && [ ! -f "/usr/share/prism/$f" ] && cp -a "/usr/share/braid/$f" "/usr/share/prism/$f"
	done
	for f in mihomo cn.list cn.list.stamp ad.list ad.list.stamp events.log cache.db; do
		[ -e "/tmp/braid/$f" ] && [ ! -e "/tmp/prism/$f" ] && cp -a "/tmp/braid/$f" "/tmp/prism/$f"
	done
	if [ -f /etc/config/braid ] && [ ! -f /etc/config/prism ]; then
		sed 's/^config braid/config prism/' /etc/config/braid >/etc/config/prism
	fi
	rm -f /usr/share/nftables.d/ruleset-post/30-braid-guard.nft /etc/sysctl.d/99-braid.conf /usr/share/rpcd/acl.d/braid.json /lib/upgrade/keep.d/braid /usr/sbin/braid /etc/init.d/braid /etc/config/braid /etc/rc.d/*braid*
	rm -rf /etc/braid /usr/share/braid /www/braid /tmp/braid
	nft delete table inet braid 2>/dev/null || true
	nft delete table inet braid_guard 2>/dev/null || true
fi
chmod 755 /usr/sbin/prism /etc/init.d/prism
chmod 600 /etc/prism/relays.json /etc/prism/controller.secret /etc/prism/portal.secret 2>/dev/null || true
[ "$acl_before" = "$(md5sum /usr/share/rpcd/acl.d/prism.json | cut -d' ' -f1)" ] || /etc/init.d/rpcd restart
if [ "$dhcp_before" != "$(md5sum /etc/hotplug.d/dhcp/50-prism 2>/dev/null | cut -d' ' -f1)" ] || ! grep -q '^dhcp-script=' /var/etc/dnsmasq.conf.* 2>/dev/null; then
	/etc/init.d/dnsmasq restart
fi

restore() {
	echo "deploy: $1; restoring the previous version" >&2
	if [ -f "$PREV" ]; then
		tar xzf "$PREV" -C /
		if [ "$guard_before" = 0 ]; then
			rm -f /etc/prism/guard.nft /usr/share/nftables.d/ruleset-post/30-prism-guard.nft
			nft delete table inet prism_guard 2>/dev/null || true
		fi
		fw4 reload
		/etc/init.d/prism restart
	fi
	exit 1
}

prism plan >/tmp/prism-plan.out 2>&1 || true
grep -q '^prism: ' /tmp/prism-plan.out && { cat /tmp/prism-plan.out >&2; restore "plan reported errors"; }

sysctl -qp /etc/sysctl.d/99-prism.conf 2>/dev/null || true
prism provision
/etc/init.d/prism enable
# prismd holds its code in memory: restart that one instance. The tunnel and
# the resolver keep running, and so does the kernel state.
/etc/init.d/prism start
ubus call service signal '{"name":"prism","instance":"prismd","signal":15}' >/dev/null 2>&1 || true
n=0
until sleep 6 && prism doctor && ubus call prism status >/dev/null 2>&1; do
	n=$((n + 1))
	[ "$n" -ge 10 ] && restore "health report not clean"
done
rm -rf "$STAGE"
echo DEPLOY_OK
REMOTE
