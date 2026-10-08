#!/bin/sh
# Snapshot tunables + datapath health into /tmp/hotel/status.json and metrics.csv

. /usr/lib/hotel/common.sh
hotel_dirs

LOCK=/var/run/hotel-observe.lock
exec 8>"$LOCK"
flock -n 8 || exit 0

TS=$(date +%s)
ISO=$(date -Iseconds 2>/dev/null || date)
LEGS="$HOTEL_DIR/legs.tsv"
: > "$LEGS"

ETH_DEVS=$(eth_dev_list)
STA_DEVS=$(sta_dev_list)
hotel_ip4_cache 2>/dev/null || ip -4 -o addr show > "$HOTEL_DIR/ip4"
STATE=$(cat "$HOTEL_STATE" 2>/dev/null || true)
MODE=$(echo "$STATE" | awk '{print $2}')
if [ "${DATAPATH:-ecmp10}" = "plain" ]; then
	ALL="wan"
	HASH_MARKS=""
	SLOTS=""
	SCORES=""
	MODE="${MODE:-none}"
else
	ALL="$ETH_DEVS $STA_DEVS"
	HASH_MARKS=$(cat "$HOTEL_DIR/hash.marks" 2>/dev/null || true)
	if [ -z "$HASH_MARKS" ]; then
		HASH_MARKS=$(echo "$STATE" | awk '{for(i=3;i<=NF;i++) if($i ~ /^[0-9]+$/) printf "%s ", $i}')
	fi
	SLOTS=$(cat "$HOTEL_SLOTS" 2>/dev/null || true)
	SCORES=$(cat /tmp/hotel-scores 2>/dev/null || true)
fi
EVENT=$(awk 'END{print}' "$HOTEL_DIR/events.log" 2>/dev/null)
CT=$(cat /proc/sys/net/netfilter/nf_conntrack_count 2>/dev/null || echo 0)
CTMAX=$(cat /proc/sys/net/netfilter/nf_conntrack_max 2>/dev/null || echo 0)
LOAD=$(awk '{print $1}' /proc/loadavg)
MEMFREE=$(awk '/MemAvailable:/{print $2}' /proc/meminfo)
GUA=$(cat "$HOTEL_DIR/gua" 2>/dev/null || echo 0)
AAAA=$(cat "$HOTEL_DIR/aaaa_filter" 2>/dev/null || echo 1)
SD_CONF=${SMARTDNS_CONF:-/tmp/hotel/smartdns.conf}
SD_MODE=$(awk '/^response-mode /{print $2; exit}' "$SD_CONF" 2>/dev/null)
SD_SPEED=$(awk '/^speed-check-mode /{print $2; exit}' "$SD_CONF" 2>/dev/null)
SD_BIND=$(awk '/^bind /{print $2; exit}' "$SD_CONF" 2>/dev/null)
SD_PORT=${SD_BIND##*:}
SD_EN=0
pidof smartdns >/dev/null 2>&1 && SD_EN=1
DNS_SERVER=$(uci -q get dhcp.@dnsmasq[0].server | tr '\n' ' ')
PROXY_ACT=0
[ -f /var/run/hotel-proxy.active ] && proxy_running && PROXY_ACT=1
PROXY_NFT=0
nft list chain inet hotel_split tproxy_pre >/dev/null 2>&1 && PROXY_NFT=1
PXSKIP=0
nft list chain inet hotel pre 2>/dev/null | grep -Eq '0x00004000|16384' && PXSKIP=1
CANARY_DOWN=0
[ -f "$HOTEL_DIR/canary.down" ] && CANARY_DOWN=1
CANARY_OK=0
CANARY_CODE=$(cat "$HOTEL_DIR/canary.code" 2>/dev/null || echo 0)

enc_canary_url() {
	echo "$CANARY_URL" | sed -e 's/:/%3A/g' -e 's/\//%2F/g'
}

canary_enc_tag() {
	printf '%s' "$1" | lua -e '
		local s = io.read("*a") or ""
		s = s:gsub("\r", ""):gsub("\n$", "")
		s = s:gsub("([^%w%-_%.~])", function(ch)
			return string.format("%%%02X", string.byte(ch))
		end)
		io.write(s)
	'
}

canary_delay() {
	tag="$1"
	[ -n "$tag" ] && [ -n "$2" ] || return 1
	enc_tag=$(canary_enc_tag "$tag")
	[ -n "$enc_tag" ] || return 1
	body=$(curl -4 -m 8 -sS -H "Authorization: Bearer $2" \
		"http://${3}:9090/proxies/${enc_tag}/delay?timeout=${CANARY_TIMEOUT}&url=${4}" 2>/dev/null || true)
	d=$(echo "$body" | sed -n 's/.*"delay":\([0-9][0-9]*\).*/\1/p')
	[ -n "$d" ] && [ "$d" -gt 0 ] 2>/dev/null && [ "$d" -lt 30000 ] || return 1
	echo "$d"
}

canary_probe() {
	# AUTO is the group that carries traffic. Probe it first.
	# Other tags only if AUTO is down, so a live backup node does not fail-open.
	lan=$(cat "$HOTEL_DIR/lan.ip" 2>/dev/null || echo 192.168.16.1)
	secret=$(cat /etc/hotel/clash.secret 2>/dev/null || true)
	enc=$(enc_canary_url)
	best=0
	if [ -n "$secret" ]; then
		best=$(canary_delay AUTO "$secret" "$lan" "$enc" || true)
		if [ -z "$best" ] || [ "$best" -le 0 ] 2>/dev/null; then
			best=0
			while IFS= read -r tag || [ -n "$tag" ]; do
				[ -n "$tag" ] || continue
				[ "$tag" = AUTO ] && continue
				best=$(canary_delay "$tag" "$secret" "$lan" "$enc" || true)
				[ -n "$best" ] && [ "$best" -gt 0 ] 2>/dev/null && break
				best=0
			done < "$HOTEL_DIR/proxy.tags"
		fi
	fi
	if [ "$best" -gt 0 ] 2>/dev/null; then
		echo "$best" > "$HOTEL_DIR/canary.code"
		return 0
	fi
	code=$(curl -4 -m 8 -sS -o /dev/null -w "%{http_code}" \
		-x "http://127.0.0.1:${MIXED_PORT}" "$CANARY_URL" 2>/dev/null || echo 000)
	echo "$code" > "$HOTEL_DIR/canary.code"
	[ "$code" = "204" ] || [ "$code" = "200" ]
}

if [ "$PROXY_ACT" = 1 ]; then
	now=$TS
	last=$(cat "$HOTEL_DIR/canary.ts" 2>/dev/null || echo 0)
	prev=$(cat "$HOTEL_DIR/canary.ok" 2>/dev/null || echo 0)
	run=1
	if [ "$CANARY_DOWN" = 0 ] && [ "$prev" = 1 ] && [ $((now - last)) -lt 180 ]; then
		run=0
		CANARY_OK=1
	fi
	if [ "$run" = 1 ]; then
		echo "$now" > "$HOTEL_DIR/canary.ts"
		if canary_probe; then
			echo 0 > "$HOTEL_DIR/canary.fail"
			echo 1 > "$HOTEL_DIR/canary.ok"
			CANARY_OK=1
			CANARY_CODE=$(cat "$HOTEL_DIR/canary.code" 2>/dev/null || echo 0)
			if [ "$CANARY_DOWN" = 1 ]; then
				rm -f "$HOTEL_DIR/canary.down"
				CANARY_DOWN=0
				/usr/sbin/hotel-proxy.sh hook >/dev/null 2>&1 || true
				hotel_log CANARY_UP
			fi
		else
			echo 0 > "$HOTEL_DIR/canary.ok"
			CANARY_OK=0
			CANARY_CODE=$(cat "$HOTEL_DIR/canary.code" 2>/dev/null || echo 0)
			n=$(cat "$HOTEL_DIR/canary.fail" 2>/dev/null || echo 0)
			n=$((n + 1))
			echo "$n" > "$HOTEL_DIR/canary.fail"
			started=$(cat /var/run/hotel-proxy.started 2>/dev/null || echo 0)
			age=$((now - started))
			if [ "$n" -ge "${CANARY_FAILS:-3}" ] && [ "$CANARY_DOWN" = 0 ] \
				&& [ "$age" -ge "${CANARY_GRACE:-90}" ]; then
				/usr/sbin/hotel-proxy.sh failopen >/dev/null 2>&1 || true
				CANARY_DOWN=1
			fi
		fi
	fi
else
	echo 0 > "$HOTEL_DIR/canary.ok"
fi

n_eth=0
n_sta=0
n_up=0
n_200=0
rx_sum=0
tx_sum=0

for dev in $ALL; do
	[ -d "/sys/class/net/$dev" ] || continue
	ipaddr=$(ip4_of "$dev")
	rx=$(cat "/sys/class/net/$dev/statistics/rx_bytes" 2>/dev/null || echo 0)
	tx=$(cat "/sys/class/net/$dev/statistics/tx_bytes" 2>/dev/null || echo 0)
	rxd=$(cat "$HOTEL_DIR/rx.$dev" 2>/dev/null || echo 0)
	# rxd file is absolute bytes snapshot; delta from scores file instead
	m=$(leg_mark "$dev")
	probe=$(cat "/tmp/hotel-probe.$dev" 2>/dev/null || echo "000")
	code=$(echo "$probe" | awk '{print $1}')
	ttfb=$(echo "$probe" | awk '{print $2}')
	: "${ttfb:=0}"
	fs=$(cat "/tmp/hotel-fs.$dev" 2>/dev/null || echo 0)
	fail=$(cat "/tmp/hotel-fail.$dev" 2>/dev/null || echo 0)
	inhash=0
	echo " $HASH_MARKS " | grep -q " $m " && inhash=1
	role=none
	if is_eth "$dev"; then
		role=eth
		n_eth=$((n_eth + 1))
	else
		role=sta
		n_sta=$((n_sta + 1))
	fi
	[ -n "$ipaddr" ] && n_up=$((n_up + 1))
	[ "$code" = "200" ] && n_200=$((n_200 + 1))
	rx_sum=$((rx_sum + rx))
	tx_sum=$((tx_sum + tx))
	printf '%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\n' \
		"$dev" "$m" "${ipaddr:--}" "$rx" "$tx" "$code" "$ttfb" "$fs" "$fail" "$inhash" "$role" >> "$LEGS"
done

n_hash=$(echo $HASH_MARKS | awk '{print NF}')
slot_hist=$(echo "$SLOTS" | awk '{
	for(i=1;i<=NF;i++) c[$i]++
	n=0
	for(k in c){ if(n++) printf ","; printf "\"%s\":%d", k, c[k] }
}')
score_json=$(echo "$SCORES" | awk '{
	n=0
	for(i=1;i<=NF;i++){
		split($i,a,":")
		if(a[1]=="") continue
		if(n++) printf ","
		printf "\"%s\":%s", a[1], a[2]+0
	}
}')
gini=$(echo "$SCORES" | awk '{
	n=0; s=0
	for(i=1;i<=NF;i++){
		split($i,a,":"); v=a[2]+0; n++; x[n]=v; s+=v
	}
	if(n<2 || s==0){ print 0; exit }
	for(i=1;i<=n;i++) for(j=i+1;j<=n;j++) if(x[j]<x[i]){ t=x[i]; x[i]=x[j]; x[j]=t }
	acc=0; num=0
	for(i=1;i<=n;i++){ acc+=x[i]; num+=acc }
	# Gini ~ (n+1)/n - 2*num/(n*s)
	printf "%.4f", ((n+1)/n) - (2*num)/(n*s)
}')

race_json='[]'

awk -v ts="$TS" -v iso="$ISO" -v ver="$POLICY_VER" -v mode="${MODE:-none}" \
	-v dp="${DATAPATH:-ecmp10}" \
	-v nslots="$NSLOTS" -v auth="$AUTH_BATCH" -v failk="$FAIL_KEEP" \
	-v mss="$MSS" -v upl="$UPLINK_MBYTES" -v event="${EVENT:-}" \
	-v neth="$n_eth" -v nsta="$n_sta" -v nup="$n_up" -v n200="$n_200" \
	-v nhash="${n_hash:-0}" -v ct="$CT" -v ctmax="$CTMAX" -v load="$LOAD" \
	-v mem="$MEMFREE" -v gua="$GUA" -v aaaa="$AAAA" \
	-v sden="${SD_EN:-0}" -v sdport="${SD_PORT:-}" -v sdmode="${SD_MODE:-}" \
	-v sdspeed="${SD_SPEED:-}" -v sdbind="${SD_BIND:-}" -v dnssrv="$DNS_SERVER" \
	-v proxyact="$PROXY_ACT" -v proxynft="$PROXY_NFT" \
	-v pxskip="$PXSKIP" -v canok="$CANARY_OK" -v candown="$CANARY_DOWN" -v cancode="$CANARY_CODE" \
	-v slots="$SLOTS" -v shist="$slot_hist" -v sjson="$score_json" \
	-v gini="$gini" -v race="$race_json" -v rxsum="$rx_sum" -v txsum="$tx_sum" \
	-v marks="$HASH_MARKS" '
BEGIN {
	gsub(/"/, "", event)
	gsub(/"/, "", iso)
	gsub(/"/, "", dnssrv)
	gsub(/"/, "", sdbind)
	gsub(/"/, "", sdmode)
	gsub(/"/, "", sdspeed)
	gsub(/"/, "", dp)
	printf "{"
	printf "\"ts\":%s,", ts+0
	printf "\"iso\":\"%s\",", iso
	printf "\"policy\":\"%s\",\"datapath\":\"%s\",\"mode\":\"%s\",", ver, dp, mode
	printf "\"event\":\"%s\",", event
	printf "\"params\":{\"nslots\":%s,\"auth_batch\":%s,\"fail_keep\":%s,\"mss\":%s,\"uplink_mbytes\":%s},", nslots+0, auth+0, failk+0, mss+0, upl+0
	printf "\"health\":{\"eth\":%s,\"sta\":%s,\"up\":%s,\"http200\":%s,\"hash\":%s,\"ct\":%s,\"ct_max\":%s,\"load1\":%s,\"mem_avail_kb\":%s,\"rx_sum\":%s,\"tx_sum\":%s},", neth+0, nsta+0, nup+0, n200+0, nhash+0, ct+0, ctmax+0, load+0, mem+0, rxsum+0, txsum+0
	printf "\"harvest\":{\"marks\":\"%s\",\"slots\":\"%s\",\"weights\":{%s},\"scores\":{%s},\"gini\":%s},", marks, slots, shist, sjson, gini+0
	printf "\"dns\":{\"smartdns\":%s,\"port\":%s,\"bind\":\"%s\",\"response_mode\":\"%s\",\"speed_check\":\"%s\",\"aaaa_filter\":%s,\"gua\":%s,\"dnsmasq_server\":\"%s\",\"race\":%s},", sden+0, sdport+0, sdbind, sdmode, sdspeed, aaaa+0, gua+0, dnssrv, race
	printf "\"proxy\":{\"active\":%s,\"nft\":%s,\"px_skip\":%s,\"canary_ok\":%s,\"canary_down\":%s,\"canary_code\":%s},", proxyact+0, proxynft+0, pxskip+0, canok+0, candown+0, cancode+0
	printf "\"legs\":["
	first=1
}
{
	if(!first) printf ","
	first=0
	printf "{\"dev\":\"%s\",\"mark\":%s,\"ip\":\"%s\",\"rx\":%s,\"tx\":%s,\"http\":%s,\"ttfb\":%s,\"fs\":%s,\"fail\":%s,\"in_hash\":%s,\"role\":\"%s\"}", $1, $2+0, $3, $4+0, $5+0, $6+0, $7+0, $8+0, $9+0, $10+0, $11
}
END {
	printf "]}\n"
}' "$LEGS" > "$HOTEL_DIR/status.json"

hotel_jsonl "$HOTEL_DIR/run.jsonl" "{\"ts\":$TS,\"policy\":\"$POLICY_VER\",\"mode\":\"${MODE:-none}\",\"hash\":${n_hash:-0},\"http200\":$n_200,\"ct\":$CT,\"load1\":$LOAD,\"proxy\":$PROXY_ACT,\"nft\":$PROXY_NFT,\"gini\":$gini}"
echo "$TS,$MODE,$n_hash,$n_200,$CT,$rx_sum,$gini,$LOAD,$GUA,$AAAA" >> "$HOTEL_DIR/metrics.csv"
nlines=$(wc -l < "$HOTEL_DIR/metrics.csv")
if [ "$nlines" -gt 2880 ]; then
	tail -n 1440 "$HOTEL_DIR/metrics.csv" > "$HOTEL_DIR/metrics.csv.new"
	mv "$HOTEL_DIR/metrics.csv.new" "$HOTEL_DIR/metrics.csv"
fi

if [ -f /var/run/hotel-proxy.active ] && ! proxy_running; then
	/usr/sbin/hotel-proxy.sh teardown >/dev/null 2>&1 || true
fi
if [ -x /usr/sbin/hotel-guard.sh ]; then
	/usr/sbin/hotel-guard.sh all >/dev/null 2>&1 || true
fi
if [ -x /usr/lib/hotel/doctor.sh ]; then
	/usr/lib/hotel/doctor.sh json > "$HOTEL_DIR/doctor.json" 2>/dev/null || true
	if ! hotel_boot_grace && grep -q '"ok":0,' "$HOTEL_DIR/doctor.json" 2>/dev/null; then
		hotel_log "DOCTOR_FAIL $(sed -n 's/.*"fail":\[\([^]]*\)\].*/\1/p' "$HOTEL_DIR/doctor.json" | tr -d '"')"
	fi
fi
[ "$1" = "--led" ] && /usr/sbin/hotel-led.sh >/dev/null 2>&1 || true
exit 0
