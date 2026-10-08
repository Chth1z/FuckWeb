#!/bin/sh
# Auth one WAN via Linkbroad access code.
dev="$1"
code="$2"
[ -n "$dev" ] && [ -n "$code" ] || exit 1
UA="Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36"
CK=/tmp/ck_${dev}.txt
rm -f "$CK"
curl -4 --interface "$dev" -k -m 12 -sS -A "$UA" -c "$CK" -b "$CK" -o /dev/null "https://portal.linkbroad.com/portal.php?lang=zh-CN" || true
body=$(curl -4 --interface "$dev" -k -m 12 -sS -A "$UA" -c "$CK" -b "$CK" \
  -H "Referer: https://portal.linkbroad.com/portal.php?lang=zh-CN" \
  -H "Origin: https://portal.linkbroad.com" \
  --data-urlencode "userid=code" \
  --data-urlencode "passwd=$code" \
  --data-urlencode "lang=zh-cn" \
  --data-urlencode "type=code" \
  "https://portal.linkbroad.com/common/to_auth.php")
echo "$body"
echo "$body" | grep -q showResult\(\"accept\" && echo AUTH_OK || echo AUTH_FAIL
