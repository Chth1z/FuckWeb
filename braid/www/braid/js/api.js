/**
 * Braid 5.0 Optical Weave — ubus JSON-RPC 2.0 Client & Session Authentication
 */

import { ANON, S } from "./state.js";
import { $, toast } from "./dom.js";

let rpcSeq = 0;
let afterLogin = null;
let onStateChange = () => {};
let onRefreshAll = () => {};

export function registerApiHooks({ render, refreshAll }) {
	onStateChange = render;
	onRefreshAll = refreshAll;
}

export async function ubus(object, method, args = {}) {
	const res = await fetch("/ubus", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({
			jsonrpc: "2.0",
			id: ++rpcSeq,
			method: "call",
			params: [S.sid, object, method, args],
		}),
	});
	const j = await res.json();
	if (j.error) {
		throw Object.assign(new Error(j.error.message || "RPC Denied"), {
			denied: j.error.code === -32002,
		});
	}
	if (!j.result || j.result[0] !== 0) {
		const code = j.result ? j.result[0] : -1;
		throw Object.assign(new Error("ubus status " + code), {
			denied: code === 6,
		});
	}
	return j.result[1] || {};
}

export function signOut() {
	S.sid = ANON;
	sessionStorage.removeItem("braid.sid");
	S.conns = [];
	S.config = null;
	const btn = $("#btn-auth");
	if (btn) btn.textContent = "登錄";
	onStateChange();
}

export function askLogin(then) {
	afterLogin = then || null;
	const err = $("#login-err");
	if (err) err.textContent = "";
	$("#scrim")?.classList.add("open");
	setTimeout(() => $("#pass")?.focus(), 50);
}

export async function write(method, args = {}, done = null) {
	if (S.sid === ANON) return askLogin(() => write(method, args, done));
	try {
		const r = await ubus("braid", method, args);
		if (r.ok === false) throw new Error(r.error || "執行失敗");
		toast("✓ 指令已生效: braid." + method);
		setTimeout(onRefreshAll, 750);
		if (done) done();
	} catch (e) {
		if (e.denied) {
			signOut();
			askLogin(() => write(method, args, done));
		} else {
			toast("✗ " + e.message);
		}
	}
}

export function bindAuthModal(pollFn) {
	const btnAuth = $("#btn-auth");
	if (btnAuth) {
		btnAuth.onclick = () => (S.sid === ANON ? askLogin() : signOut());
		if (S.sid !== ANON) btnAuth.textContent = "退出";
	}

	const btnCancel = $("#login-cancel");
	if (btnCancel) {
		btnCancel.onclick = () => $("#scrim")?.classList.remove("open");
	}

	const form = $("#login-form");
	if (form) {
		form.onsubmit = async (e) => {
			e.preventDefault();
			const goBtn = $("#login-go");
			if (goBtn) goBtn.disabled = true;
			try {
				const r = await ubus("session", "login", {
					username: $("#user").value,
					password: $("#pass").value,
				});
				S.sid = r.ubus_rpc_session;
				sessionStorage.setItem("braid.sid", S.sid);
				$("#pass").value = "";
				$("#scrim")?.classList.remove("open");
				if (btnAuth) btnAuth.textContent = "退出";
				toast("✓ 已獲取 root 管理權限");
				onStateChange();
				const fn = afterLogin;
				afterLogin = null;
				if (fn) fn();
				else if (pollFn) pollFn();
			} catch (err) {
				const errEl = $("#login-err");
				if (errEl) errEl.textContent = "認證失敗：帳號或密碼不正確";
			}
			if (goBtn) goBtn.disabled = false;
		};
	}
}
