/**
 * Braid 5.0 Optical Weave — View 04: Live Kernel & Tunnel Flow Table
 */

import { ANON, S, deviceName, rateText, sizeText } from "../state.js";
import { $, el } from "../dom.js";
import { askLogin } from "../api.js";

export function ingestConnections(list) {
	const now = performance.now() / 1000;
	const dt = S.connAt ? now - S.connAt : 0;
	const prev = S.connPrev;
	const next = {};
	for (const c of list) {
		const p = prev[c.key];
		c.rd = p && dt > 0 ? Math.max(0, c.down - p.down) / dt : 0;
		c.ru = p && dt > 0 ? Math.max(0, c.up - p.up) / dt : 0;
		next[c.key] = { down: c.down, up: c.up };
	}
	S.conns = list;
	S.connPrev = next;
	S.connAt = now;
}

export function renderConnections(pollFn) {
	if (S.page !== "connections") return;
	const seg = $("#conn-route-seg");
	seg.replaceChildren(
		...[["all", "全部"], ["tunnel", "台灣家寬隧道"], ["direct", "多線直連"], ["vip", "VIP 專線"]].map(([v, label]) => {
			const b = el("button", S.connRoute === v ? "on" : "", label);
			b.type = "button";
			b.onclick = () => {
				S.connRoute = v;
				renderConnections(pollFn);
			};
			return b;
		})
	);

	const empty = $("#conn-empty");
	const wrap = $("#conn-table-wrap");
	const tbody = $("#connections-tbody");

	if (S.sid === ANON) {
		empty.style.display = "block";
		wrap.style.display = "none";
		empty.replaceChildren("實時連接表屬於局域網隱私數據，請先登錄管理員帳號查看。");
		const btn = el("button", "btn primary", "立即登錄");
		btn.style.marginLeft = "12px";
		btn.onclick = () => askLogin(pollFn);
		empty.append(btn);
		return;
	}

	wrap.style.display = "block";
	const q = ($("#conn-q")?.value || "").trim().toLowerCase();
	const rows = S.conns
		.filter((c) => {
			if (S.connRoute === "tunnel" && c.route !== "tunnel") return false;
			if (S.connRoute === "direct" && c.route !== "direct") return false;
			if (S.connRoute === "vip" && !c.vip) return false;
			if (!q) return true;
			return [deviceName(c.src), c.src, c.dst, c.via, c.proto, String(c.port)].join(" ").toLowerCase().includes(q);
		})
		.sort((a, b) => ((b.rd + b.ru) - (a.rd + a.ru)) || ((b.down + b.up) - (a.down + a.up)))
		.slice(0, 220);

	const nDirect = S.conns.filter((c) => c.route === "direct").length;
	const nVip = S.conns.filter((c) => c.vip).length;
	$("#conn-cap").textContent = `共 ${S.conns.length} 條活躍連接：${S.conns.length - nDirect} 條走台灣家寬隧道 · ${nDirect} 條走多線直連 · ${nVip} 條獨享 VIP 0x100`;

	if (!rows.length) {
		empty.style.display = "block";
		empty.textContent = "沒有符合篩選條件的活躍連接";
		tbody.replaceChildren();
		return;
	}
	empty.style.display = "none";

	tbody.replaceChildren(
		...rows.map((c) => {
			const tr = el("tr");
			const c1 = el("td");
			c1.append(el("div", "", deviceName(c.src)), el("div", "sub-meta", c.src));

			const c2 = el("td");
			c2.append(el("div", "", c.dst), el("div", "sub-meta", `${(c.proto || "tcp").toUpperCase()} : ${c.port}`));

			const c3 = el("td");
			const bCls = c.vip ? "gold" : c.route === "tunnel" ? "violet" : "blue";
			const bTxt = (c.vip ? "★ VIP · " : c.route === "tunnel" ? "TUNNEL · " : "DIRECT · ") + (c.via || "—");
			c3.append(el("span", "bp-badge " + bCls, bTxt));

			tr.append(
				c1,
				c2,
				c3,
				el("td", "num", c.rd ? rateText(c.rd) : "—"),
				el("td", "num", c.ru ? rateText(c.ru) : "—"),
				el("td", "num sub-meta", `${sizeText(c.down)} / ${sizeText(c.up)}`)
			);
			return tr;
		})
	);
}
