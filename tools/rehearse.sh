#!/bin/sh
# Rehearse local code on the router without touching the live Braid: the tree
# goes to a scratch dir and runs against a private run dir and config.
#   tools/rehearse.sh plan --full
set -e
cd "$(dirname "$0")/.."
DEV=/tmp/braid-rehearsal
SHARE=/usr/share/braid
# Until Braid is installed the assets and secrets still sit in the old places.
tar czf - --owner=0 --group=0 -C braid --exclude='*.gz' --exclude=zashboard --exclude=relays.json . |
	tools/rsh "rm -rf $DEV/tree $DEV/etc && mkdir -p $DEV/tree $DEV/run $DEV/uci $DEV/etc \
		&& tar xzf - -C $DEV/tree \
		&& cp $DEV/tree/etc/config/braid $DEV/uci/braid \
		&& cp -r $DEV/tree/etc/braid/. $DEV/etc/ \
		&& for d in /usr/share/braid /usr/share/hotel; do [ -f \$d/mihomo.gz ] && ln -sf \$d/mihomo.gz \$d/cn-domains.gz \$d/ad-domains.gz $DEV/tree$SHARE/ && break; done \
		&& if [ -d /etc/braid ]; then ln -sf /etc/braid/relays.json /etc/braid/controller.secret /etc/braid/portal.secret /etc/braid/zashboard $DEV/etc/; \
		   else ln -sf /etc/hotel/proxy-nodes.json $DEV/etc/relays.json; ln -sf /etc/hotel/clash.secret $DEV/etc/controller.secret; ln -sf /etc/hotel-portal.code $DEV/etc/portal.secret; ln -sf /etc/hotel/zashboard $DEV/etc/; fi \
		&& for r in /tmp/braid /tmp/hotel; do [ -x \$r/mihomo ] && ln -sf \$r/mihomo $DEV/run/mihomo && break; done; true"
[ $# -gt 0 ] || exit 0
tools/rsh "BRAID_RUN=$DEV/run BRAID_ETC=$DEV/etc BRAID_UCI=$DEV/uci ucode -S $DEV/tree$SHARE/braid.uc $*"
