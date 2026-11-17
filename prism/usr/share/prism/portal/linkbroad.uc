// Linkbroad captive portal, access-code login.
//
// A portal plugin exports login_cmd(dev, secret): a shell snippet that logs
// one strand in and exits 0 on success. Snippets for several devices
// run in parallel, so they must not share files.

import { shq, RUN, STATE_DIR } from "../lib/core.uc";

const BASE = "https://portal.linkbroad.com";
const CACHE = STATE_DIR + "/portal_ip.txt";
const FALLBACK_IP = "106.14.39.79";
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36";

export function login_cmd(dev, secret) {
	let jar = RUN + "/portal." + dev + ".jar";
	let curl = sprintf("curl -4 --interface %s -k -m 7 --connect-timeout 4 -sS --resolve \"portal.linkbroad.com:443:$pip\" -A %s -c %s -b %s", dev, shq(UA), jar, jar);
	return join("\n", [
		"rm -f " + jar,
		"pip=$(nslookup -type=a -timeout=2 -retry=1 portal.linkbroad.com 127.0.0.1 2>/dev/null | awk '/^Name:/{f=1} f&&/^Address/{print $2; exit}')",
		"[ -n \"$pip\" ] && [ \"$pip\" != \"$(cat " + CACHE + " 2>/dev/null)\" ] && printf '%s\\n' \"$pip\" > " + CACHE + ".tmp.$$ 2>/dev/null && mv -f " + CACHE + ".tmp.$$ " + CACHE + " 2>/dev/null || [ -n \"$pip\" ] || pip=$(cat " + CACHE + " 2>/dev/null)",
		"[ -z \"$pip\" ] && pip=" + FALLBACK_IP,
		curl + " -o /dev/null " + shq(BASE + "/portal.php?lang=zh-CN") + " || true",
		curl + " -H " + shq("Referer: " + BASE + "/portal.php?lang=zh-CN")
			+ " -H " + shq("Origin: " + BASE)
			+ " --data-urlencode userid=code"
			+ " --data-urlencode " + shq("passwd=" + secret)
			+ " --data-urlencode lang=zh-cn --data-urlencode type=code "
			+ shq(BASE + "/common/to_auth.php")
			+ " | grep -q 'showResult(\"accept\"'",
		"rc=$?",
		"rm -f " + jar,
		"exit $rc",
	]);
};
