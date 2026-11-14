/**
 * Braid 5.0 Optical Weave — DOM & SVG Construction Helpers
 */

import { clockText } from "./state.js";

export const $ = (s, r = document) => r.querySelector(s);
export const $$ = (s, r = document) => [...r.querySelectorAll(s)];

export function el(tag, cls, text) {
	const e = document.createElement(tag);
	if (cls) e.className = cls;
	if (text != null) e.textContent = text;
	return e;
}

export function svg(tag, attrs = {}) {
	const e = document.createElementNS("http://www.w3.org/2000/svg", tag);
	for (const k in attrs) e.setAttribute(k, attrs[k]);
	return e;
}

export function segBarEl(frac, cls = "") {
	const wrap = el("span", "seg-bar" + (cls ? " " + cls : ""));
	const fill = el("i");
	fill.style.width = (100 * Math.max(0, Math.min(1, frac || 0))).toFixed(1) + "%";
	wrap.append(fill);
	return wrap;
}

let toastTimer = null;
export function toast(text) {
	const t = $("#toast");
	if (!t) return;
	t.textContent = text;
	t.classList.add("on");
	clearTimeout(toastTimer);
	toastTimer = setTimeout(() => t.classList.remove("on"), 2400);
}

export function renderEventList(container, list) {
	if (!container) return;
	if (!list || !list.length) {
		container.replaceChildren(el("div", "sub-meta", "暫無狀態轉換事件"));
		return;
	}
	container.replaceChildren(
		...list.map((e) => {
			const row = el("div", "log-row");
			const m = /^([A-Z]+)\s+(.*)$/.exec(e.msg || "");
			const tagRaw = m ? m[1] : "SYS";
			const bodyText = m ? m[2] : (e.msg || "");
			const tagCls = tagRaw.includes("STRAND")
				? "strands"
				: tagRaw.includes("WEAVE") || tagRaw.includes("VIP")
				? "weave"
				: tagRaw.includes("TUNNEL") || tagRaw.includes("CAGE")
				? "tunnel"
				: tagRaw.includes("PORTAL")
				? "portal"
				: "guard";

			const timeEl = el("span", "log-time", clockText(e.ts));
			const tagEl = el("span", "log-tag " + tagCls, tagRaw.toLowerCase());
			const msgEl = el("span", "log-msg", bodyText);
			const metaEl = el("span", "log-meta", "p=1.00  sharp → kernel");
			row.append(timeEl, tagEl, msgEl, metaEl);
			return row;
		})
	);
}
