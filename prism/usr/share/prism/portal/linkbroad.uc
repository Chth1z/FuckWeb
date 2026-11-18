// Linkbroad captive portal, access-code login.
//
// A portal plugin exports address() and login_cmd(dev, secret, ip): a shell snippet that logs
// one strand in and exits 0 on success. Snippets for several devices
// run in parallel, so they must not share files.

import { shq, sh, read, write_if_changed, RUN, STATE_DIR } from "../lib/core.uc";

const BASE = "https://portal.linkbroad.com";
const CACHE = STATE_DIR + "/portal_ip.txt";
const FALLBACK_IP = "106.14.39.79";
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36";

export function address() {
	let r = sh("nslookup -type=a -timeout=2 -retry=1 portal.linkbroad.com 127.0.0.1");
	let ips = match(r.out, /Name:[^\n]*\nAddress[^:]*:[ \t]*([0-9.]+)/);
	if (ips && length(iptoarr(ips[1])) == 4) {
		write_if_changed(CACHE, ips[1] + "\n", 0o600);
		return ips[1];
	}
	return read(CACHE) || FALLBACK_IP;
};

export function login_cmd(dev, secret, ip) {
	let jar = RUN + "/portal." + dev + ".jar";
	let curl = sprintf("curl -4 --noproxy '*' --interface %s -m 7 --connect-timeout 4 -sS --resolve %s -A %s -c %s -b %s",
		shq(dev), shq("portal.linkbroad.com:443:" + ip), shq(UA), jar, jar);
	return join("\n", [
		"rm -f " + jar,
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
