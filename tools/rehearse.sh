#!/bin/sh
# Rehearse local code on the router without touching the live Prism: the tree
# goes to a scratch dir and runs against a private run dir and config.
#   tools/rehearse.sh plan --full
set -e
cd "$(dirname "$0")/.."
DEV=/tmp/prism-rehearsal
SHARE=/usr/share/prism
case "$*" in
	""|plan|"plan --full") ;;
	*) echo "usage: tools/rehearse.sh [plan [--full]]" >&2; exit 2 ;;
esac
# Until Prism is installed the assets and secrets still sit in the old places.
tar czf - --owner=0 --group=0 -C prism --exclude='*.gz' --exclude=zashboard --exclude=relays.json . |
	tools/rsh "set -e; umask 077; rm -rf $DEV/tree $DEV/etc && mkdir -p $DEV/tree $DEV/run $DEV/uci $DEV/etc \
		&& tar xzf - -C $DEV/tree \
		&& if [ -f /etc/config/prism ]; then cp /etc/config/prism $DEV/uci/prism; elif [ -f /etc/config/braid ]; then sed 's/^config braid/config prism/' /etc/config/braid > $DEV/uci/prism; else cp $DEV/tree/etc/config/prism $DEV/uci/prism; fi \
		&& cp -r $DEV/tree/etc/prism/. $DEV/etc/ \
		&& for d in /usr/share/prism /usr/share/braid /usr/share/hotel; do [ -f \$d/mihomo.gz ] && ln -sf \$d/mihomo.gz \$d/cn-domains.gz \$d/ad-domains.gz $DEV/tree$SHARE/ && break; done \
		&& if [ -d /etc/prism/state ]; then cp -r /etc/prism/state $DEV/etc/; fi \
		&& if [ -d /etc/prism ]; then ln -sf /etc/prism/relays.json /etc/prism/controller.secret /etc/prism/portal.secret /etc/prism/zashboard $DEV/etc/; \
		   elif [ -d /etc/braid ]; then ln -sf /etc/braid/relays.json /etc/braid/controller.secret /etc/braid/portal.secret /etc/braid/zashboard $DEV/etc/; \
		   else ln -sf /etc/hotel/proxy-nodes.json $DEV/etc/relays.json; ln -sf /etc/hotel/clash.secret $DEV/etc/controller.secret; ln -sf /etc/hotel-portal.code $DEV/etc/portal.secret; ln -sf /etc/hotel/zashboard $DEV/etc/; fi \
		&& for r in /tmp/prism /tmp/braid /tmp/hotel; do [ -x \$r/mihomo ] && ln -sf \$r/mihomo $DEV/run/mihomo && break; done"
[ $# -gt 0 ] || exit 0
tools/rsh "PRISM_RUN=$DEV/run PRISM_ETC=$DEV/etc PRISM_UCI=$DEV/uci ucode -S $DEV/tree$SHARE/prism.uc $*"
