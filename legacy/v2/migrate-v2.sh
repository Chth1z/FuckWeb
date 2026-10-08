#!/bin/sh
# One-time move from hotel-suite v2 to Braid. Runs on the router.
#
#   migrate-v2.sh run       precheck, switch, health gate, then wait for
#                           `confirm`; anything short of that rolls back
#   migrate-v2.sh confirm   accept Braid and remove hotel-suite
#   migrate-v2.sh rollback  go back to hotel-suite now
#   migrate-v2.sh status    current phase and the tail of the log
#
# The Braid tree must already be unpacked in $STAGE/tree. Kernel state is
# never torn down in between: Braid's first pass replaces the old nft table
# in one transaction and reuses the per-strand routing that is already there.

STAGE=/tmp/braid-stage
LOG=/tmp/braid-migrate.log
PHASE=/tmp/braid-migrate.phase
CONFIRM=/tmp/braid-migrate.confirm
GATE_SEC=150
CONFIRM_SEC=480

log() {
	echo "$(date +%T) $*" >> "$LOG"
	logger -t braid-migrate "$*"
}

phase() {
	echo "$1" > "$PHASE"
	log "PHASE $1"
}

precheck() {
	[ -f "$STAGE/tree/usr/share/braid/braid.uc" ] || { log "no staged tree"; return 1; }
	[ -x /usr/sbin/hotel ] || { log "hotel-suite v2 is not installed here"; return 1; }
	mkdir -p "$STAGE/run" "$STAGE/etc" "$STAGE/uci"
	cp -r "$STAGE/tree/etc/braid/." "$STAGE/etc/"
	cp "$STAGE/tree/etc/config/braid" "$STAGE/uci/braid"
	ln -sf /etc/hotel/proxy-nodes.json "$STAGE/etc/relays.json"
	ln -sf /etc/hotel/clash.secret "$STAGE/etc/controller.secret"
	ln -sf /etc/hotel-portal.code "$STAGE/etc/portal.secret"
	ln -sf /etc/hotel/zashboard "$STAGE/etc/zashboard"
	ln -sf /usr/share/hotel/mihomo.gz /usr/share/hotel/cn-domains.gz /usr/share/hotel/ad-domains.gz \
		"$STAGE/tree/usr/share/braid/"
	ln -sf /tmp/hotel/mihomo "$STAGE/run/mihomo"
	out=$(BRAID_RUN="$STAGE/run" BRAID_ETC="$STAGE/etc" BRAID_UCI="$STAGE/uci" \
		ucode -S "$STAGE/tree/usr/share/braid/braid.uc" plan --full 2>&1)
	echo "$out" | grep -q '^nft: full rebuild valid' || { log "plan failed: $out"; return 1; }
	echo "$out" | grep -q '^braid: ' && { log "plan reported errors: $out"; return 1; }
	[ -s "$STAGE/run/plan/mihomo.yaml" ] || { log "no tunnel config rendered"; return 1; }
	return 0
}

install_braid() {
	rm -f "$STAGE"/tree/usr/share/braid/*.gz
	cp -a "$STAGE/tree/." / || return 1
	mkdir -p /etc/braid /usr/share/braid /tmp/braid
	cp -p /etc/hotel/proxy-nodes.json /etc/braid/relays.json
	cp -p /etc/hotel/clash.secret /etc/braid/controller.secret
	cp -p /etc/hotel-portal.code /etc/braid/portal.secret
	chmod 600 /etc/braid/relays.json /etc/braid/controller.secret /etc/braid/portal.secret
	chmod 755 /usr/sbin/braid /etc/init.d/braid
	# Same filesystem: these moves are renames, and rollback renames them back.
	mv /usr/share/hotel/mihomo.gz /usr/share/hotel/cn-domains.gz /usr/share/hotel/ad-domains.gz /usr/share/braid/
	mv /etc/hotel/zashboard /etc/braid/zashboard
	/etc/init.d/rpcd restart >/dev/null 2>&1
	log "braid files installed"
}

# The outage window: the old daemons go away, the new service comes up.
# `service delete` kills the instances without running hotel's stop hook, so
# the kernel keeps forwarding on the old table until Braid replaces it.
switch() {
	touch /tmp/hotel/stopped
	/etc/init.d/hotel disable >/dev/null 2>&1
	ubus call service delete '{"name":"hotel"}' >/dev/null 2>&1
	sleep 1
	mv /tmp/hotel/mihomo /tmp/braid/mihomo 2>/dev/null
	/etc/init.d/braid enable
	/etc/init.d/braid start >>"$LOG" 2>&1
	log "braid service started"
}

healthy() {
	/usr/sbin/braid doctor >/dev/null 2>&1 || return 1
	ubus call braid status 2>/dev/null | ucode -e 'import { stdin } from "fs";
		let s = json(stdin.read("all"));
		let up = length(filter(s.strands, (x) => x.healthy));
		exit(s.ok && s.tunnel.on && s.tunnel.canary_ms > 0 && up > 0 && length(s.weave.pattern) > 0 ? 0 : 1);' 2>/dev/null || return 1
	[ "$(curl -4 -m 8 -sS -o /dev/null -w '%{http_code}' -x http://127.0.0.1:7890 \
		https://cp.cloudflare.com/generate_204 2>/dev/null)" = 204 ] || return 1
	nslookup -type=a www.baidu.com 127.0.0.1 >/dev/null 2>&1 || return 1
	nslookup -type=a api.anthropic.com 127.0.0.1 >/dev/null 2>&1 || return 1
	lan=$(uci -q get network.lan.ipaddr | cut -d/ -f1)
	[ "$(curl -4 -m 5 -sS -o /dev/null -w '%{http_code}' "http://$lan/braid/" 2>/dev/null)" = 200 ] || return 1
	return 0
}

gate() {
	t=0
	while [ "$t" -lt "$GATE_SEC" ]; do
		sleep 6
		t=$((t + 6))
		if healthy; then
			log "health gate passed after ${t}s"
			return 0
		fi
	done
	log "health gate failed: $(/usr/sbin/braid doctor 2>&1 | tr '\n' ' ')"
	return 1
}

remove_braid() {
	rm -f /usr/sbin/braid /etc/init.d/braid /etc/config/braid /lib/upgrade/keep.d/braid \
		/etc/sysctl.d/99-braid.conf /usr/share/rpcd/acl.d/braid.json
	rm -rf /usr/share/braid /etc/braid /www/braid /tmp/braid
	/etc/init.d/rpcd reload >/dev/null 2>&1
}

rollback() {
	phase rolling-back
	/etc/init.d/braid stop >>"$LOG" 2>&1
	/etc/init.d/braid disable >/dev/null 2>&1
	mv /usr/share/braid/mihomo.gz /usr/share/braid/cn-domains.gz /usr/share/braid/ad-domains.gz /usr/share/hotel/ 2>/dev/null
	mv /etc/braid/zashboard /etc/hotel/zashboard 2>/dev/null
	remove_braid
	rm -f /tmp/hotel/stopped
	/etc/init.d/hotel enable
	/etc/init.d/hotel start >>"$LOG" 2>&1
	phase rolled-back
}

commit() {
	phase committing
	[ -f /etc/hotel/backup-v1.tgz ] && mv /etc/hotel/backup-v1.tgz /etc/braid/backup-v1.tgz
	rm -f /usr/sbin/hotel /usr/sbin/hotelctl /etc/init.d/hotel /etc/config/hotel /etc/hotel-portal.code \
		/etc/sysctl.d/99-hotel.conf /lib/upgrade/keep.d/hotel
	rm -rf /usr/share/hotel /etc/hotel /tmp/hotel
	phase committed
}

run() {
	: > "$LOG"
	rm -f "$CONFIRM"
	phase precheck
	precheck || { phase failed-precheck; return 1; }
	phase switching
	install_braid || { rollback; return 1; }
	switch
	if ! gate; then
		rollback
		return 1
	fi
	phase await-confirm
	t=0
	while [ "$t" -lt "$CONFIRM_SEC" ]; do
		[ -f "$CONFIRM" ] && { commit; return 0; }
		sleep 3
		t=$((t + 3))
	done
	log "no confirmation within ${CONFIRM_SEC}s"
	rollback
	return 1
}

case "$1" in
	run) run ;;
	confirm) touch "$CONFIRM" ;;
	rollback) rollback ;;
	status) cat "$PHASE" 2>/dev/null; tail -n "${2:-15}" "$LOG" 2>/dev/null ;;
	*) echo "usage: $0 run|confirm|rollback|status"; exit 1 ;;
esac
