#!/bin/sh
# Push the braid tree to the router and reload it. Rolls back to the previous
# code if the health report is not clean afterwards.
#   tools/deploy.sh            code, lists and the dashboard page
#   tools/deploy.sh --config   also /etc/config/braid. The router owns that
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

if grep -rlI "$(printf '\r')" braid --exclude-dir=zashboard >/dev/null; then
	echo "CRLF line endings in braid/; fix before deploying" >&2
	exit 1
fi

EXCLUDE=""
[ "$ASSETS" = 1 ] || EXCLUDE="--exclude=*.gz --exclude=zashboard"
[ "$SECRETS" = 1 ] || EXCLUDE="$EXCLUDE --exclude=relays.json"
[ "$CONFIG" = 1 ] || EXCLUDE="$EXCLUDE --exclude=./etc/config/braid"

STAGE=/tmp/braid-stage
# shellcheck disable=SC2086
tar czf - --owner=0 --group=0 -C braid $EXCLUDE . |
	tools/rsh "rm -rf $STAGE && mkdir -p $STAGE/tree && tar xzf - -C $STAGE/tree"

tools/rsh sh -s <<'REMOTE'
set -e
STAGE=/tmp/braid-stage
PREV=/tmp/braid-prev.tgz
KEEP="etc/config/braid etc/init.d/braid etc/braid/lists etc/braid/guard.nft etc/braid/provision.json etc/sysctl.d/99-braid.conf usr/sbin/braid usr/share/braid/braid.uc usr/share/braid/braidd.uc usr/share/braid/lib usr/share/braid/mod usr/share/braid/portal usr/share/braid/tpl usr/share/nftables.d/ruleset-post/30-braid-guard.nft usr/share/rpcd/acl.d/braid.json www/braid"
guard_before=0
[ ! -f /etc/braid/guard.nft ] || guard_before=1

cd /
have=""
for f in $KEEP; do [ -e "$f" ] && have="$have $f"; done
[ -n "$have" ] && tar czf "$PREV" $have
acl_before=$(md5sum /usr/share/rpcd/acl.d/braid.json 2>/dev/null | cut -d' ' -f1)

cp -a "$STAGE/tree/." /
chmod 755 /usr/sbin/braid /etc/init.d/braid
chmod 600 /etc/braid/relays.json /etc/braid/controller.secret /etc/braid/portal.secret 2>/dev/null || true
[ "$acl_before" = "$(md5sum /usr/share/rpcd/acl.d/braid.json | cut -d' ' -f1)" ] || /etc/init.d/rpcd restart

restore() {
	echo "deploy: $1; restoring the previous version" >&2
	if [ -f "$PREV" ]; then
		tar xzf "$PREV" -C /
		if [ "$guard_before" = 0 ]; then
			rm -f /etc/braid/guard.nft /usr/share/nftables.d/ruleset-post/30-braid-guard.nft
			nft delete table inet braid_guard 2>/dev/null || true
		fi
		fw4 reload
		/etc/init.d/braid restart
	fi
	exit 1
}

braid plan >/tmp/braid-plan.out 2>&1 || true
grep -q '^braid: ' /tmp/braid-plan.out && { cat /tmp/braid-plan.out >&2; restore "plan reported errors"; }

sysctl -qp /etc/sysctl.d/99-braid.conf 2>/dev/null || true
braid provision
/etc/init.d/braid enable
# braidd holds its code in memory: restart that one instance. The tunnel and
# the resolver keep running, and so does the kernel state.
/etc/init.d/braid start
ubus call service signal '{"name":"braid","instance":"braidd","signal":15}' >/dev/null 2>&1 || true
n=0
until sleep 6 && braid doctor && ubus call braid status >/dev/null 2>&1; do
	n=$((n + 1))
	[ "$n" -ge 10 ] && restore "health report not clean"
done
rm -rf "$STAGE"
echo DEPLOY_OK
REMOTE
