// Shared primitives: paths, shell, files, logging, persistent state.
// Nothing in here knows about strands, tunnels or DNS.

import * as fs from "fs";
import * as ulog from "log";
import { md5 } from "digest";

export const VERSION = "5.6.2";
export const SHARE = fs.dirname(sourcepath(0, true));
export const RUN = getenv("PRISM_RUN") ?? "/tmp/prism";
export const ETC = getenv("PRISM_ETC") ?? "/etc/prism";
export const STATE_DIR = ETC + "/state";
export const UCI_DIR = getenv("PRISM_UCI");

let dry = false;
let verbose = false;

ulog.ulog_open(ulog.ULOG_SYSLOG, ulog.LOG_DAEMON, "prism");

export function set_mode(opt) {
	dry = !!opt.dry;
	verbose = !!opt.verbose;
};

export function is_dry() {
	return dry;
};

export function now() {
	return time();
};

export function uptime() {
	return int(split(fs.readfile("/proc/uptime") ?? "0", " ")[0]);
};

export function digest(s) {
	return md5(s);
};

// --- logging ---------------------------------------------------------------

export function info(fmt, ...args) {
	let msg = sprintf(fmt, ...args);
	if (verbose || dry)
		warn(msg, "\n");
	else
		ulog.ulog(ulog.LOG_INFO, "%s", msg);
};

export function err(fmt, ...args) {
	let msg = sprintf(fmt, ...args);
	warn("prism: ", msg, "\n");
	if (!dry)
		ulog.ulog(ulog.LOG_ERR, "%s", msg);
};

// A state transition worth keeping. A pass that changes nothing logs nothing.
export function event(fmt, ...args) {
	let msg = sprintf(fmt, ...args);
	if (dry) {
		warn("event: ", msg, "\n");
		return;
	}
	ulog.ulog(ulog.LOG_NOTICE, "%s", msg);
	let path = RUN + "/events.log";
	let st = fs.stat(path);
	if (st && st.size > 256000) {
		let keep = split(fs.readfile(path), "\n");
		fs.writefile(path, join("\n", slice(keep, length(keep) / 2)));
	}
	let f = fs.open(path, "a");
	if (f) {
		f.write(sprintf("%d %s\n", time(), msg));
		f.close();
	}
};

// --- shell -----------------------------------------------------------------

export function shq(s) {
	return "'" + replace("" + s, /'/g, "'\\''") + "'";
};

// Run a command that only reads. Returns { code, out }.
export function sh(cmd) {
	let p = fs.popen("{ " + cmd + "\n} 2>&1", "r");
	if (!p)
		return { code: -1, out: "" };
	let out = p.read("all") ?? "";
	return { code: p.close(), out };
};

export function ok(cmd) {
	return system("{ " + cmd + "\n} >/dev/null 2>&1") == 0;
};

// Run a command that changes the system. Dry runs print it instead.
export function act(cmd) {
	if (dry) {
		warn("would run: ", cmd, "\n");
		return true;
	}
	let r = sh(cmd);
	if (r.code != 0)
		err("command failed (%d): %s: %s", r.code, cmd, trim(r.out));
	return r.code == 0;
};

export function pidof(name) {
	return ok("pidof " + shq(name));
};

// --- files -----------------------------------------------------------------

export function read(path) {
	let s = fs.readfile(path);
	return s == null ? null : trim(s);
};

// Non-empty, non-comment lines of a list file.
export function lines(path) {
	let out = [];
	for (let line in split(fs.readfile(path) ?? "", "\n")) {
		line = trim(replace(line, /#.*$/, ""));
		if (length(line))
			push(out, line);
	}
	return out;
};

export function write_atomic(path, data, mode) {
	let tmp = path + ".tmp";
	if (fs.writefile(tmp, data) == null) {
		err("cannot write %s: %s", tmp, fs.error());
		return false;
	}
	if (mode != null)
		fs.chmod(tmp, mode);
	return fs.rename(tmp, path) == true;
};

// Returns true when the file content changed.
export function write_if_changed(path, data, mode) {
	if (fs.readfile(path) == data)
		return false;
	write_atomic(path, data, mode);
	return true;
};

// Kernel knobs under /proc and /sys. Writes only when the value differs.
export function knob(path, value) {
	let cur = read(path);
	if (cur == null || cur == "" + value)
		return false;
	if (dry) {
		warn("would set ", path, " = ", value, "\n");
		return true;
	}
	fs.writefile(path, "" + value);
	return true;
};

// Dry runs render into RUN/plan so a live instance never reads a draft.
export function outpath(name) {
	if (!dry)
		return RUN + "/" + name;
	fs.mkdir(RUN + "/plan");
	return RUN + "/plan/" + name;
};

export function load_json(path, fallback) {
	let s = fs.readfile(path);
	if (!s)
		return fallback;
	try {
		return json(s) ?? fallback;
	}
	catch (e) {
		err("bad json in %s: %s", path, e.message);
		return fallback;
	}
};

export function save_json(path, value, mode) {
	return write_atomic(path, sprintf("%.1J\n", value), mode);
};

// One reconciler at a time. Returns the handle (keep it referenced) or null.
export function lock(name) {
	let f = fs.open(RUN + "/" + name + ".lock", "w");
	if (!f)
		return null;
	return f.lock("xn") ? f : null;
};

export function init_dirs() {
	fs.mkdir(RUN);
	if (!dry)
		fs.mkdir(STATE_DIR);
};
