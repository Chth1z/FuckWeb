#!/bin/sh
# Push hotel-suite to the router and reload it. Rolls back to the previous
# code if the health report is not clean afterwards.
#   tools/deploy.sh            code, config and lists
#   tools/deploy.sh --assets   also mihomo.gz, the domain lists and the dashboard
#   tools/deploy.sh --secrets  also proxy-nodes.json
set -e
cd "$(dirname "$0")/.."
ASSETS=0
SECRETS=0
for a in "$@"; do
	case "$a" in
		--assets) ASSETS=1 ;;
		--secrets) SECRETS=1 ;;
		*) echo "usage: $0 [--assets] [--secrets]"; exit 1 ;;
	esac
done

if grep -rlI "$(printf '\r')" hotel-suite --exclude-dir=zashboard >/dev/null; then
	echo "CRLF line endings in hotel-suite; fix before deploying" >&2
	exit 1
fi

EXCLUDE=""
[ "$ASSETS" = 1 ] || EXCLUDE="--exclude=*.gz --exclude=zashboard"
[ "$SECRETS" = 1 ] || EXCLUDE="$EXCLUDE --exclude=proxy-nodes.json"

STAGE=/tmp/hotel-stage
# shellcheck disable=SC2086
tar czf - --owner=0 --group=0 -C hotel-suite $EXCLUDE . |
	tools/rsh "rm -rf $STAGE && mkdir -p $STAGE/suite && tar xzf - -C $STAGE/suite"

tools/rsh sh -s <<'REMOTE'
set -e
STAGE=/tmp/hotel-stage
PREV=/tmp/hotel-prev.tgz
KEEP="etc/config/hotel etc/init.d/hotel etc/hotel/lists etc/hotel/provision.json etc/sysctl.d/99-hotel.conf usr/sbin/hotel usr/share/hotel/hotel.uc usr/share/hotel/supervisor.uc usr/share/hotel/lib usr/share/hotel/mod usr/share/hotel/portal usr/share/hotel/tpl"

cd /
have=""
for f in $KEEP; do [ -e "$f" ] && have="$have $f"; done
[ -n "$have" ] && tar czf "$PREV" $have

cp -a "$STAGE/suite/." /
chmod 755 /usr/sbin/hotel /etc/init.d/hotel
chmod 600 /etc/hotel/proxy-nodes.json /etc/hotel/clash.secret 2>/dev/null || true
ln -sf hotel /usr/sbin/hotelctl

restore() {
	echo "deploy: $1; restoring the previous version" >&2
	[ -f "$PREV" ] && tar xzf "$PREV" -C / && /etc/init.d/hotel reload
	exit 1
}

hotel plan >/tmp/hotel-plan.out 2>&1 || true
grep -q '^hotel: ' /tmp/hotel-plan.out && { cat /tmp/hotel-plan.out >&2; restore "plan reported errors"; }

sysctl -qp /etc/sysctl.d/99-hotel.conf 2>/dev/null || true
hotel provision
/etc/init.d/hotel enable
/etc/init.d/hotel reload
n=0
until hotel doctor; do
	n=$((n + 1))
	[ "$n" -ge 10 ] && restore "health report not clean"
	sleep 6
done
rm -rf "$STAGE"
echo DEPLOY_OK
REMOTE
