#!/bin/sh
# One-time move from the v1 shell suite to hotel v2. Runs on the router.
#
#   migrate-v1.sh run       precheck, back up v1, switch, health gate, then
#                           wait for `confirm`; anything short of that rolls
#                           back to v1 on its own
#   migrate-v1.sh confirm   accept v2 and remove v1
#   migrate-v1.sh rollback  go back to v1 now
#   migrate-v1.sh status    current phase and the tail of the log
#
# The v2 tree must already be unpacked in $STAGE/suite. v1 files stay in place
# until `confirm`, so rollback never depends on the backup archive alone.

STAGE=/tmp/hotel-stage
LOG=/tmp/hotel-migrate.log
PHASE=/tmp/hotel-migrate.phase
CONFIRM=/tmp/hotel-migrate.confirm
HOLD=/tmp/hotel-v1-hold
BACKUP=/etc/hotel/backup-v1.tgz
GATE_SEC=150
CONFIRM_SEC=480

V1_FILES="/usr/sbin/hotel-dns.sh /usr/sbin/hotel-guard.sh /usr/sbin/hotel-history.sh
/usr/sbin/hotel-led.sh /usr/sbin/hotel-multidial.sh /usr/sbin/hotel-observe.sh
/usr/sbin/hotel-panic.sh /usr/sbin/hotel-perf.sh /usr/sbin/hotel-portal-auth.sh
/usr/sbin/hotel-portal-auth-all.sh /usr/sbin/hotel-portal-wan.sh /usr/sbin/hotel-proxy.sh
/usr/sbin/hotel-split.sh /usr/sbin/hotelctl /usr/lib/hotel
/etc/init.d/hotel-multidial /etc/init.d/hotel-proxy /etc/init.d/hotel-smartdns
/etc/hotplug.d/iface/99-hotel-multidial /etc/hotplug.d/net/99-hotel-perf
/etc/sysctl.d/99-hotel-perf.conf /etc/hotel/policy /etc/hotel/ARCHITECTURE
/etc/hotel/claude-domains.list /etc/hotel/direct4.nft /etc/hotel/ruleset
/etc/hotel/datapath.pin /etc/hotel/history /etc/hotel/mihomo.yaml
/www/hotel-ui.html /www/zashboard"
# Restored on rollback, kept on confirm.
V1_SHARED="/etc/init.d/smartdns /etc/rc.local /etc/crontabs/root
/etc/config/dhcp /etc/config/network /etc/config/smartdns"

log() {
	echo "$(date +%T) $*" >> "$LOG"
	logger -t hotel-migrate "$*"
}

phase() {
	echo "$1" > "$PHASE"
	log "PHASE $1"
}

existing() {
	for f in "$@"; do
		[ -e "$f" ] || [ -L "$f" ] && echo "$f"
	done
}

# The staged code must produce a ruleset this kernel accepts before anything
# on the live system is touched.
precheck() {
	[ -f "$STAGE/suite/usr/share/hotel/hotel.uc" ] || { log "no staged suite"; return 1; }
	[ -x /usr/sbin/hotel-multidial.sh ] || { log "v1 is not installed here"; return 1; }
	mkdir -p "$STAGE/run" "$STAGE/etc" "$STAGE/uci"
	cp -r "$STAGE/suite/etc/hotel/." "$STAGE/etc/"
	cp "$STAGE/suite/etc/config/hotel" "$STAGE/uci/hotel"
	ln -sf /etc/hotel/proxy-nodes.json /etc/hotel/clash.secret /etc/hotel/zashboard "$STAGE/etc/"
	ln -sf /usr/share/hotel/mihomo.gz /usr/share/hotel/cn-domains.gz /usr/share/hotel/ad-domains.gz \
		"$STAGE/suite/usr/share/hotel/"
	ln -sf /tmp/hotel/mihomo "$STAGE/run/mihomo"
	out=$(HOTEL_RUN="$STAGE/run" HOTEL_ETC="$STAGE/etc" HOTEL_UCI="$STAGE/uci" \
		ucode -S "$STAGE/suite/usr/share/hotel/hotel.uc" plan --full 2>&1)
	echo "$out" | grep -q '^nft: full rebuild valid' || { log "plan failed: $out"; return 1; }
	echo "$out" | grep -q '^hotel: ' && { log "plan reported errors: $out"; return 1; }
	[ -s "$STAGE/run/plan/mihomo.yaml" ] || { log "no mihomo config rendered"; return 1; }
	return 0
}

backup() {
	tar czf "$BACKUP" $(existing $V1_FILES $V1_SHARED) 2>>"$LOG" || return 1
	log "backup $(wc -c < "$BACKUP") bytes -> $BACKUP"
}

install_v2() {
	rm -f "$STAGE"/suite/usr/share/hotel/*.gz
	[ -s /etc/hotel/proxy-nodes.json ] && rm -f "$STAGE/suite/etc/hotel/proxy-nodes.json"
	[ -d /etc/hotel/zashboard ] && rm -rf "$STAGE/suite/etc/hotel/zashboard"
	cp -a "$STAGE/suite/." / || return 1
	chmod 755 /usr/sbin/hotel /etc/init.d/hotel
	chmod 600 /etc/hotel/proxy-nodes.json /etc/hotel/clash.secret /etc/hotel-portal.code 2>/dev/null
	log "v2 files installed"
}

# Stop everything that would run v1 scripts, without touching the kernel
# state they built: forwarding keeps working on the old rules meanwhile.
quiesce_v1() {
	sed -i '/hotel-/d' /etc/crontabs/root
	/etc/init.d/cron restart >/dev/null 2>&1
	mkdir -p "$HOLD"
	mv /etc/hotplug.d/iface/99-hotel-multidial "$HOLD/" 2>/dev/null
	mv /etc/hotplug.d/net/99-hotel-perf "$HOLD/" 2>/dev/null
	for s in hotel-multidial hotel-proxy hotel-smartdns; do
		/etc/init.d/$s disable >/dev/null 2>&1
	done
	flock /var/run/hotel-datapath.lock true
	flock /var/run/hotel-observe.lock true
	log "v1 control plane quiet"
}

# The outage window: old daemons down, new service up. `service delete`
# kills the instance without running v1's stop hook, which would tear the
# old tproxy rules out before the new table replaces them.
switch() {
	ubus call service delete '{"name":"hotel-proxy"}' >/dev/null 2>&1
	ubus call service delete '{"name":"smartdns"}' >/dev/null 2>&1
	/etc/init.d/smartdns disable >/dev/null 2>&1
	rm -f /tmp/hotel/smartdns.conf /tmp/hotel/state.json
	/etc/init.d/hotel enable
	/etc/init.d/hotel start >>"$LOG" 2>&1
	log "v2 service started"
}

healthy() {
	/usr/sbin/hotel doctor >/dev/null 2>&1 || return 1
	ucode -e 'import { readfile } from "fs";
		let s = json(readfile("/tmp/hotel/status.json"));
		exit(s.ok && s.proxy.on && s.proxy.canary_ms > 0 && s.uplink.healthy > 0 ? 0 : 1);' 2>/dev/null || return 1
	[ "$(curl -4 -m 8 -sS -o /dev/null -w '%{http_code}' -x http://127.0.0.1:7890 \
		https://cp.cloudflare.com/generate_204 2>/dev/null)" = 204 ] || return 1
	nslookup -type=a www.baidu.com 127.0.0.1 >/dev/null 2>&1 || return 1
	nslookup -type=a api.anthropic.com 127.0.0.1 >/dev/null 2>&1 || return 1
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
	log "health gate failed: $(/usr/sbin/hotel doctor 2>&1 | tr '\n' ' ')"
	return 1
}

# v1 policy routing. v2 uses its own preference and table ranges, and the
# main default route is netifd's either way.
drop_v1_routes() {
	p=90
	while [ "$p" -le 250 ]; do
		while ip rule del pref "$p" 2>/dev/null; do :; done
		p=$((p + 1))
	done
	t=201
	while [ "$t" -le 250 ]; do
		ip route flush table "$t" 2>/dev/null
		t=$((t + 1))
	done
	log "v1 routing state removed"
}

rollback() {
	phase rolling-back
	/etc/init.d/hotel stop >>"$LOG" 2>&1
	/etc/init.d/hotel disable >/dev/null 2>&1
	tar xzf "$BACKUP" -C / $(tar tzf "$BACKUP" | grep -E '^(etc/init.d/smartdns|etc/rc.local|etc/crontabs/root|etc/config/)' ) 2>>"$LOG"
	mv "$HOLD/99-hotel-multidial" /etc/hotplug.d/iface/ 2>/dev/null
	mv "$HOLD/99-hotel-perf" /etc/hotplug.d/net/ 2>/dev/null
	rm -f /tmp/hotel/*.digest /tmp/hotel/smartdns.conf /tmp/hotel-online /tmp/hotel-policy.ok
	/etc/init.d/cron restart >/dev/null 2>&1
	/etc/init.d/dnsmasq restart >/dev/null 2>&1
	for s in smartdns hotel-multidial hotel-proxy; do
		/etc/init.d/$s enable >/dev/null 2>&1
	done
	/usr/sbin/hotel-dns.sh apply >>"$LOG" 2>&1
	/usr/sbin/hotel-multidial.sh >>"$LOG" 2>&1
	/etc/init.d/hotel-proxy start >>"$LOG" 2>&1
	sleep 5
	/usr/sbin/hotel-proxy.sh hook >>"$LOG" 2>&1
	rm -f /usr/sbin/hotel /etc/init.d/hotel /etc/config/hotel /lib/upgrade/keep.d/hotel /etc/sysctl.d/99-hotel.conf
	rm -rf /usr/share/hotel/lib /usr/share/hotel/mod /usr/share/hotel/portal /usr/share/hotel/tpl \
		/usr/share/hotel/hotel.uc /usr/share/hotel/supervisor.uc /etc/hotel/lists /etc/hotel/provision.json
	phase rolled-back
}

commit() {
	phase committing
	# Give the package its own init script back before v1's copy goes away.
	if [ -f /usr/lib/hotel/smartdns.init.pkg ]; then
		cp /usr/lib/hotel/smartdns.init.pkg /etc/init.d/smartdns
		chmod 755 /etc/init.d/smartdns
	fi
	/etc/init.d/smartdns disable >/dev/null 2>&1
	uci -q set smartdns.@smartdns[0].enabled='0' && uci commit smartdns
	rm -rf $V1_FILES "$HOLD"
	ln -sf hotel /usr/sbin/hotelctl
	printf '%s\n' '# Put your custom commands here that should be executed once' \
		'# the system init finished. By default this file does nothing.' '' 'exit 0' > /etc/rc.local
	rm -f /tmp/hotel-online /tmp/hotel-policy.ok /tmp/hotel-slots* /tmp/hotel-scores /tmp/hotel-probe.* \
		/tmp/hotel-fs.* /tmp/hotel-fail.* /tmp/hotel-park.* /tmp/hotel-last.log /tmp/hotel-multidial.log \
		/tmp/hotel-burst /tmp/hotel-snapshot.tgz /var/run/hotel-proxy.* /var/run/hotel-*.lock /var/run/hotel-hp.pending
	find /tmp/hotel -maxdepth 1 -type f ! -name state.json ! -name status.json ! -name doctor.json \
		! -name events.log ! -name smartdns.conf ! -name mihomo.yaml ! -name mihomo ! -name 'cn.list*' \
		! -name 'ad.list*' ! -name 'smartdns.log*' ! -name cache.db ! -name tick.lock ! -name ruleset.nft -exec rm -f {} +
	phase committed
}

run() {
	: > "$LOG"
	rm -f "$CONFIRM"
	phase precheck
	precheck || { phase failed-precheck; return 1; }
	backup || { phase failed-precheck; return 1; }
	phase switching
	install_v2 || { rollback; return 1; }
	quiesce_v1
	switch
	if ! gate; then
		rollback
		return 1
	fi
	drop_v1_routes
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
