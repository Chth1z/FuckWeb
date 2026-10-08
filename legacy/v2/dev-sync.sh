#!/bin/sh
# Copy the suite into a scratch dir on the router and run it there against a
# private run dir and config. Touches nothing the live stack uses.
#   tools/dev-sync.sh plan --full
set -e
cd "$(dirname "$0")/.."
DEV=/tmp/hotel-dev
SHARE=/usr/share/hotel

tar czf - --owner=0 --group=0 -C hotel-suite --exclude='*.gz' --exclude=zashboard --exclude=proxy-nodes.json . |
	tools/rsh "rm -rf $DEV/suite $DEV/etc && mkdir -p $DEV/suite $DEV/run $DEV/uci $DEV/etc \
		&& tar xzf - -C $DEV/suite \
		&& cp $DEV/suite/etc/config/hotel $DEV/uci/hotel \
		&& ln -sf $SHARE/mihomo.gz $SHARE/cn-domains.gz $SHARE/ad-domains.gz $DEV/suite$SHARE/ \
		&& cp -r $DEV/suite/etc/hotel/. $DEV/etc/ \
		&& ln -sf /etc/hotel/proxy-nodes.json /etc/hotel/clash.secret /etc/hotel/zashboard $DEV/etc/"
[ $# -gt 0 ] || exit 0
tools/rsh "HOTEL_RUN=$DEV/run HOTEL_ETC=$DEV/etc HOTEL_UCI=$DEV/uci ucode -S $DEV/suite$SHARE/hotel.uc $*"
