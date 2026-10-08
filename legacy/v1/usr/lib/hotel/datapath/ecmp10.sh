#!/bin/sh
# Adapter: hotel 21-MAC harvest. Sticky ct + idle-biased 42-slot map.
# Not part of the DNS/split/proxy stack. Unplug with DATAPATH=plain.

. /usr/lib/hotel/common.sh

cmd="${1:-apply}"

egress() {
	els=""
	if [ -f "$HOTEL_DIR/sb_dst4.ips" ]; then
		while read -r ip; do
			[ -n "$ip" ] || continue
			els="$els $ip,"
		done < "$HOTEL_DIR/sb_dst4.ips"
		els=$(echo "$els" | sed 's/,$//')
	fi
	nft list set inet hotel sb_dst4 >/dev/null 2>&1 || return 0
	if [ -n "$els" ]; then
		nft -f - <<EOF
flush set inet hotel sb_dst4
add element inet hotel sb_dst4 { $els }
EOF
	else
		nft flush set inet hotel sb_dst4 2>/dev/null || true
	fi
}

teardown() {
	wipe_fwmark
	nft delete table inet hotel 2>/dev/null || true
	rm -f "$HOTEL_STATE" /tmp/hotel-policy.ok "$HOTEL_DIR"/acct.* "$HOTEL_DIR"/ewma.* "$HOTEL_DIR"/raw.*
	hotel_log DATAPATH_OFF
}

if [ "$cmd" = "egress" ]; then
	egress
	exit 0
fi
if [ "$cmd" = "teardown" ]; then
	teardown
	exit 0
fi

score_legs() {
	devs="$1"
	hotel_dirs
	alpha=${SCORE_EWMA:-0.3}
	nft list chain inet hotel acct > "$HOTEL_DIR/acct.nft" 2>/dev/null || : > "$HOTEL_DIR/acct.nft"
	map=""
	for dev in $devs; do
		map="$map $dev:$(leg_mark "$dev")"
	done
	# One nft dump, one awk: same acct./ewma./raw. files as the old per-leg loop.
	awk -v map="$map" -v dir="$HOTEL_DIR" -v alpha="$alpha" '
	BEGIN {
		n = split(map, mp, " ")
		for (i = 1; i <= n; i++) {
			if (mp[i] == "") continue
			if (split(mp[i], kv, ":") != 2) continue
			dev = kv[1]
			order[++norder] = dev
			mark[dev] = kv[2] + 0
			want[dev] = 1
		}
	}
	$1 == "iifname" {
		saw_acct = 1
		iface = $2
		gsub(/"/, "", iface)
		gsub(/,/, "", iface)
		if (!want[iface]) next
		for (i = 1; i <= NF; i++) {
			if ($i == "bytes") {
				cur[iface] = $(i + 1) + 0
				break
			}
		}
	}
	END {
		for (i = 1; i <= norder; i++) {
			dev = order[i]
			m = mark[dev]
			if (saw_acct) {
				c = cur[dev] + 0
				prevf = dir "/acct." dev
			} else {
				txf = "/sys/class/net/" dev "/statistics/tx_bytes"
				c = 0
				if ((getline line < txf) > 0) c = line + 0
				close(txf)
				prevf = dir "/tx." dev
			}
			has_prev = 0
			pr = 0
			if ((getline line < prevf) > 0) {
				pr = line + 0
				has_prev = 1
			}
			close(prevf)
			if (!has_prev) delta = 0
			else {
				delta = c - pr
				if (delta < 0) delta = 0
			}
			print c + 0 > prevf
			close(prevf)
			ewmaf = dir "/ewma." m
			old = ""
			if ((getline line < ewmaf) > 0) old = line
			close(ewmaf)
			a = alpha + 0
			if (old == "" || a <= 0 || a >= 1) ewma = delta + 0
			else ewma = a * delta + (1 - a) * (old + 0)
			ewma = sprintf("%.0f", ewma)
			print ewma > ewmaf
			close(ewmaf)
			rawf = dir "/raw." m
			print delta + 0 > rawf
			close(rawf)
			printf " %s:%s", m, ewma
		}
		printf "\n"
	}' "$HOTEL_DIR/acct.nft"
}

assign_slots() {
	healthy="$1"
	scores="$2"
	hotel_dirs
	awk -v healthy="$healthy" -v scores="$scores" -v ns="$NSLOTS" -v hf="$HOTEL_DIR/harvest.tsv" '
	BEGIN {
		nh = split(healthy, h, " ")
		if (nh < 1) exit 1
		nscores = split(scores, sp, " ")
		for (i = 1; i <= nscores; i++) {
			nkv = split(sp[i], kv, ":")
			if (nkv == 2) d[kv[1] + 0] = kv[2] + 0
		}
		for (i = 1; i <= nh; i++) {
			for (j = i + 1; j <= nh; j++) {
				di = d[h[i] + 0] + 0
				dj = d[h[j] + 0] + 0
				if (dj < di || (dj == di && (h[j] + 0) < (h[i] + 0))) {
					t = h[i]; h[i] = h[j]; h[j] = t
				}
			}
		}
		extra = ns - nh
		if (extra < 0) extra = 0
		for (i = 1; i <= nh; i++) w[i] = 1
		ih = int((nh + 1) / 2)
		if (ih < 1) ih = 1
		k = 0
		while (extra > 0) {
			idx = (k % ih) + 1
			w[idx]++
			extra--
			k++
		}
		for (i = 1; i <= nh; i++)
			printf "%s\t%s\t%s\t%s\n", h[i], d[h[i] + 0] + 0, w[i], i > hf
		nout = 0
		while (nout < ns) {
			progress = 0
			for (i = 1; i <= nh && nout < ns; i++) {
				if (w[i] <= 0) continue
				printf "%s%s", h[i], (nout == ns - 1 ? "\n" : " ")
				w[i]--
				nout++
				progress = 1
			}
			if (progress == 0) {
				while (nout < ns) {
					printf "%s%s", h[1], (nout == ns - 1 ? "\n" : " ")
					nout++
				}
				exit 0
			}
		}
	}'
}

LOCK=/var/run/hotel-datapath.lock
exec 9>"$LOCK"
flock -n 9 || exit 0
hotel_dirs
date +%s > "$HOTEL_DIR/datapath.busy"
trap 'rm -f "$HOTEL_DIR/datapath.busy"' EXIT

NOW=$(date +%s)
T0=$NOW
if [ -f /tmp/hotel-burst ]; then
	sleep 5
	rm -f /tmp/hotel-burst
fi

probe_dev() {
	dev="$1"
	line=$(curl -4 --interface "$dev" -m "$PROBE_TIMEOUT" -sS -o /dev/null \
		-w "%{http_code} %{time_starttransfer} %{time_connect}" \
		"$PROBE_URL" 2>/dev/null || echo "000 0 0")
	echo "$line" > "/tmp/hotel-probe.$dev"
}

try_auth_only() {
	dev="$1"
	[ -f "$CODEFILE" ] || return 1
	[ -x /usr/sbin/hotel-portal-auth.sh ] || return 1
	park=/tmp/hotel-park.$dev
	if [ -f "$park" ]; then
		p=$(cat "$park" 2>/dev/null || echo 0)
		[ $((NOW - p)) -lt "$PARK_SEC" ] && return 1
		rm -f "$park"
	fi
	failf=/tmp/hotel-fail.$dev
	f=$(cat "$failf" 2>/dev/null || echo 0)
	f=$((f + 1))
	echo "$f" > "$failf"
	[ "$f" -ge "$PARK_FAILS" ] && echo "$NOW" > "$park"
	code=$(cat "$CODEFILE")
	/usr/sbin/hotel-portal-auth.sh "$dev" "$code" >/dev/null 2>&1 || true
}

ETH_DEVS=$(eth_dev_list)
STA_DEVS=$(sta_dev_list)
ALL="$ETH_DEVS $STA_DEVS"
hotel_ip4_cache

CANDS=""
for dev in $ALL; do
	[ -d "/sys/class/net/$dev" ] || continue
	ipaddr=$(ip4_of "$dev")
	[ -n "$ipaddr" ] || continue
	arp_leg "$dev"
	tbl=$(leg_tbl "$dev")
	ip route replace 192.168.128.0/19 dev "$dev" src "$ipaddr" scope link table "$tbl"
	ip route replace default via 192.168.128.1 dev "$dev" src "$ipaddr" table "$tbl"
	CANDS="$CANDS $dev"
done

for dev in $CANDS; do
	okts="$HOTEL_DIR/okts.$dev"
	code=$(awk '{print $1}' "/tmp/hotel-probe.$dev" 2>/dev/null || echo 000)
	last=$(cat "$okts" 2>/dev/null || echo 0)
	if [ "$code" = "200" ] && [ $((NOW - last)) -lt "${PROBE_OK_SEC:-600}" ]; then
		continue
	fi
	probe_dev "$dev" &
done
wait

NEEDAUTH=""
for dev in $CANDS; do
	code=$(awk '{print $1}' "/tmp/hotel-probe.$dev" 2>/dev/null || echo 000)
	if [ "$code" = "200" ]; then
		echo "$NOW" > "$HOTEL_DIR/okts.$dev"
		rm -f "/tmp/hotel-fail.$dev" "/tmp/hotel-park.$dev"
		echo 0 > "/tmp/hotel-fs.$dev"
	else
		NEEDAUTH="$NEEDAUTH $dev"
	fi
done

njob=0
for dev in $NEEDAUTH; do
	try_auth_only "$dev" &
	njob=$((njob + 1))
	if [ "$njob" -ge "$AUTH_BATCH" ]; then
		wait
		njob=0
	fi
done
wait

for dev in $NEEDAUTH; do
	rm -f "/tmp/hotel-probe.$dev"
	probe_dev "$dev" &
done
wait

ETH_HASH=""
STA_HASH=""
ETH_HDEVS=""
STA_HDEVS=""
for dev in $ALL; do
	echo " $CANDS " | grep -q " $dev " || continue
	code=$(awk '{print $1}' "/tmp/hotel-probe.$dev" 2>/dev/null || echo 000)
	ipaddr=$(ip4_of "$dev")
	fs=$(cat "/tmp/hotel-fs.$dev" 2>/dev/null || echo 0)
	if [ "$code" = "200" ]; then
		echo 0 > "/tmp/hotel-fs.$dev"
		good=1
	else
		fs=$((fs + 1))
		echo "$fs" > "/tmp/hotel-fs.$dev"
		if [ "$fs" -ge "$FAIL_KEEP" ]; then
			good=0
		else
			good=1
		fi
		echo "PORTAL $dev $ipaddr http=$code fs=$fs keep=$good"
	fi
	[ "$good" = 1 ] || continue
	m=$(leg_mark "$dev")
	echo "ONLINE $dev $ipaddr mark $m table $(leg_tbl "$dev")"
	if is_eth "$dev"; then
		ETH_HASH="$ETH_HASH $m"
		ETH_HDEVS="$ETH_HDEVS $dev"
	else
		STA_HASH="$STA_HASH $m"
		STA_HDEVS="$STA_HDEVS $dev"
	fi
done

if [ -n "$(echo $ETH_HASH)" ]; then
	HASH_MARKS=$(echo $ETH_HASH)
	HASH_DEVS=$(echo $ETH_HDEVS)
	MODE=eth
else
	HASH_MARKS=$(echo $STA_HASH)
	HASH_DEVS=$(echo $STA_HDEVS)
	MODE=sta
fi

[ -n "$HASH_MARKS" ] || {
	echo "NO_LEGS panic"
	hotel_log "PANIC no_legs"
	/usr/sbin/hotel-panic.sh
	/usr/sbin/hotel-led.sh >/dev/null 2>&1 || true
	exit 1
}

SCORES=$(score_legs "$HASH_DEVS")
SLOTS=$(assign_slots "$HASH_MARKS" "$SCORES")
[ -n "$SLOTS" ] || SLOTS=$(echo "$HASH_MARKS" | awk -v ns="$NSLOTS" '{n=NF; for(i=0;i<ns;i++) printf "%s%s", $((i%n)+1), (i==ns-1?"\n":" ")}')
echo "$SLOTS" > "$HOTEL_SLOTS"
echo "$SCORES" > /tmp/hotel-scores

MAPELS=$(echo "$SLOTS" | awk '{for(i=1;i<=NF;i++) printf "%s%d : %s", (i==1?"":", "), i-1, $i}')
FIRSTMARK=$(echo $HASH_MARKS | awk '{print $1}')
FIRSTDEV=""
for dev in $ALL; do
	[ "$(leg_mark "$dev")" = "$FIRSTMARK" ] || continue
	FIRSTDEV=$dev
	break
done
[ -n "$FIRSTDEV" ] || FIRSTDEV=wan

UPLIMS=""
if [ "${UPLINK_MBYTES:-0}" -gt 0 ]; then
	for dev in $HASH_DEVS; do
		UPLIMS="${UPLIMS}		iifname ${LANIIF} oifname \"${dev}\" limit rate over ${UPLINK_MBYTES} mbytes/second drop
"
	done
fi

ACCT=""
for dev in $HASH_DEVS; do
	ACCT="${ACCT}		iifname \"${dev}\" oifname ${LANIIF} counter
"
done

CORE="ecmp10 $MODE $HASH_MARKS mss=$MSS acct=iif ewma=${SCORE_EWMA:-0.3}"
echo "$HASH_MARKS" > "$HOTEL_DIR/hash.marks"
OLD=$(cat "$HOTEL_STATE" 2>/dev/null || true)
OLDSLOTS=$(cat /tmp/hotel-slots.prev 2>/dev/null || true)
HAVE_TABLE=0
nft list table inet hotel >/dev/null 2>&1 && HAVE_TABLE=1

finish() {
	ev="$1"
	echo "$SLOTS" > /tmp/hotel-slots.prev
	hotel_log "$ev MODE=$MODE MARKS=$HASH_MARKS"
	echo "$ev VER=ecmp10 MODE=$MODE FIRST=$FIRSTDEV MARKS=$HASH_MARKS"
	echo SLOTS=$SLOTS
	echo SCORES=$SCORES
	dt=$(($(date +%s) - T0))
	algo=$(awk -v ts="$NOW" -v ev="$ev" -v mode="$MODE" \
		-v nslots="$NSLOTS" -v first="$FIRSTDEV" -v dt="$dt" \
		-v slots="$SLOTS" -v marks="$HASH_MARKS" '
		BEGIN {
			printf "{\"ts\":%s,\"event\":\"%s\",\"ver\":\"ecmp10\",\"mode\":\"%s\",\"first\":\"%s\",\"dt_s\":%s,\"nslots\":%s,\"marks\":\"%s\",\"slots\":\"%s\",\"rank\":[",
				ts+0, ev, mode, first, dt+0, nslots+0, marks, slots
			n=0
		}
		{
			if (n++) printf ","
			printf "{\"mark\":%s,\"rx_delta\":%s,\"weight\":%s,\"rank\":%s}", $1+0, $2+0, $3+0, $4+0
		}
		END { printf "]}\n" }
	' "$HOTEL_DIR/harvest.tsv" 2>/dev/null)
	[ -n "$algo" ] && hotel_jsonl "$HOTEL_DIR/algo.jsonl" "$algo"
	# UNCHANGED/MAPUPD must not delete tproxy or dns_hijack — that is a 2-minute flap.
	# cron already runs observe every minute; only rebuild needs a snapshot.
	if [ "$ev" = "REBUILT" ]; then
		/usr/sbin/hotel-split.sh >/dev/null 2>&1 || true
		egress
		/usr/sbin/hotel-proxy.sh hook >/dev/null 2>&1 || true
		/usr/sbin/hotel-observe.sh --led >/dev/null 2>&1 || true
	fi
}

if [ "$HAVE_TABLE" = 1 ] && [ "$CORE" = "$OLD" ]; then
	if [ "$SLOTS" = "$OLDSLOTS" ]; then
		finish UNCHANGED
		exit 0
	fi
	nft -f - <<EOF || { echo MAP_FAIL; hotel_log MAP_FAIL; exit 1; }
flush map inet hotel sl
add element inet hotel sl { $MAPELS }
EOF
	finish MAPUPD
	exit 0
fi

first_ip=$(ip4_of "$FIRSTDEV")
while ip route show table main | grep -q '^default '; do
	ip route del default 2>/dev/null || break
done
if [ -n "$first_ip" ]; then
	ip route replace default via 192.168.128.1 dev "$FIRSTDEV" proto static src "$first_ip" metric 10 2>/dev/null || \
		ip route replace default via 192.168.128.1 dev "$FIRSTDEV" 2>/dev/null || true
else
	ip route replace default via 192.168.128.1 dev "$FIRSTDEV" 2>/dev/null || true
fi
wipe_fwmark

m=1
while [ "$m" -le 21 ]; do
	ip rule add fwmark "$m" table $((200 + m)) pref $((MARK_PREF + m))
	m=$((m + 1))
done
m=40
while [ "$m" -le 50 ]; do
	ip rule add fwmark "$m" table $((200 + m)) pref $((MARK_PREF + m))
	m=$((m + 1))
done

i=0
for dev in $ALL; do
	i=$((i + 1))
	pref=$((FROM_PREF + i))
	ipaddr=$(ip4_of "$dev")
	[ -n "$ipaddr" ] || continue
	ip rule add from "$ipaddr" table "$(leg_tbl "$dev")" pref "$pref"
done

nft delete table inet hotel 2>/dev/null || true
nft -f - <<EOF || { echo NFT_FAIL; hotel_log NFT_FAIL; exit 1; }
table inet hotel {
	map sl {
		type mark : mark
		elements = { $MAPELS }
	}
	set sb_dst4 {
		type ipv4_addr;
	}
	chain pre {
		type filter hook prerouting priority -95; policy accept;
		iifname $LANIIF meta mark $TPROXY_MARK return
		iifname $LANIIF ct mark != 0 meta mark set ct mark return
		iifname $LANIIF ip daddr { 10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16, 198.51.100.0/24, 100.64.0.0/10, 224.0.0.0/4, 255.255.255.255 } return
		iifname $LANIIF ct state new meta l4proto { tcp, udp } ct mark set numgen inc mod $NSLOTS
		iifname $LANIIF ct state new meta l4proto { tcp, udp } ct mark set ct mark map @sl
		iifname $LANIIF meta mark set ct mark
	}
	chain sb_out {
		type route hook output priority -150; policy accept;
		meta mark != 0 return
		ip daddr @sb_dst4 ct mark != 0 meta mark set ct mark return
		ip daddr @sb_dst4 ct state new meta l4proto { tcp, udp } ct mark set numgen inc mod $NSLOTS
		ip daddr @sb_dst4 ct state new ct mark set ct mark map @sl
		ip daddr @sb_dst4 meta mark set ct mark
	}
	chain in {
		type filter hook input priority -160; policy accept;
		iifname $LANIIF accept
		iifname "lo" accept
		ct state established,related accept
		udp dport { 67, 68 } accept
		ip protocol icmp accept
		tcp dport { 53, 80, 443, 9090, 61235 } drop
		udp dport { 53, 853, 61235 } drop
		tcp dport 853 drop
	}
	chain fw {
		type filter hook forward priority 0; policy accept;
		iifname $LANIIF tcp flags syn tcp option maxseg size set $MSS
$UPLIMS
	}
	chain acct {
		type filter hook forward priority 20; policy accept;
$ACCT
	}
}
EOF

echo "$CORE" > "$HOTEL_STATE"
echo "ecmp10" > /tmp/hotel-policy.ok
rm -f "$HOTEL_DIR"/acct.wan "$HOTEL_DIR"/acct.vwan* "$HOTEL_DIR"/acct.phy*
finish REBUILT
exit 0
