#!/bin/sh
# Single-source version manager for Prism (backend + web UI cache-busters).
# Usage:
#   tools/version.sh          Show current version & verify sync
#   tools/version.sh --check  Exit non-zero if any file drifts from VERSION
#   tools/version.sh X.Y.Z    Set version everywhere across backend & web UI
set -e
cd "$(dirname "$0")/.."

VER_FILE="prism/usr/share/prism/VERSION"
CORE_UC="prism/usr/share/prism/lib/core.uc"
INDEX_HTML="prism/www/prism/index.html"
STATE_JS="prism/www/prism/js/state.js"

if [ "$1" = "--check" ]; then
	ver=$(tr -d ' \t\r\n' < "$VER_FILE")
	[ -n "$ver" ] || { echo "empty $VER_FILE" >&2; exit 1; }
	fail=0
	grep -q "export const VERSION = \"$ver\";" "$CORE_UC" || { echo "drift: $CORE_UC" >&2; fail=1; }
	grep -q "export const UI_VERSION = '$ver';" "$STATE_JS" || { echo "drift: $STATE_JS" >&2; fail=1; }
	for f in "$INDEX_HTML" $(find prism/www/prism/js -name '*.js' | sort); do
		if grep -Eq '\?v=[^"'\'']+' "$f" && grep -E '\?v=[^"'\'']+' "$f" | grep -qv "?v=$ver"; then
			echo "drift: $f has mismatched ?v= token (expected ?v=$ver)" >&2
			fail=1
		fi
	done
	[ "$fail" = 0 ] && echo "version OK: $ver" || exit 1
	exit 0
fi

if [ -n "$1" ]; then
	ver="$1"
	printf '%s\n' "$ver" > "$VER_FILE"
else
	ver=$(tr -d ' \t\r\n' < "$VER_FILE")
fi

# Update backend core.uc & frontend state.js & index.html + ES module ?v= tags
sed -i "s/^export const VERSION = \".*\";/export const VERSION = \"$ver\";/" "$CORE_UC"
sed -i "s/^export const UI_VERSION = '.*';/export const UI_VERSION = '$ver';/" "$STATE_JS"
sed -i -E "s/<title>PRISM [^<]*<\/title>/<title>PRISM v$ver · Optical Spectrum \&amp; Privacy Router<\/title>/" "$INDEX_HTML"
sed -i -E "s/(PRISM v?)[0-9]+[.][0-9]+[.][0-9]+/\\1$ver/g" "$INDEX_HTML"
sed -i -E "s/(id=\"hdr-ver\">)v[^<]+/\1v$ver/" "$INDEX_HTML"
sed -i -E "s/\?v=[A-Za-z0-9._-]+/?v=$ver/g" "$INDEX_HTML"

for f in $(find prism/www/prism/js -name '*.js' | sort); do
	sed -i -E "s/\?v=[A-Za-z0-9._-]+/?v=$ver/g" "$f"
done

echo "synchronized prism version -> $ver"
