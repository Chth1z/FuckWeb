/**
 * Braid 5.0 Optical Weave — View 05: TW-HOME Privacy Cage & nftables Classification Pipeline
 */

import { RULE_META, S, countText, sizeText } from "../state.js";
import { $, el, segBarEl } from "../dom.js";
import { write } from "../api.js";

export function renderTunnelAndRules() {
	if (S.page !== "tunnel") return;
	const t = S.status?.tunnel || {};
	const live = S.tunnel || {};

	if (live.dashboard) $("#zashboard-link").href = live.dashboard;

	const sumBox = $("#tunnel-summary");
	const activeRelay = live.selected === "TW-HOME" && live.tw_home
		? `TW-HOME ↦ ${live.tw_home}`
		: live.selected === "AUTO" && live.auto
		? `AUTO ↦ ${live.auto}`
		: (live.selected || "TW-HOME");

	const kvItems = [
		["隧道狀態 (MIHOMO)", t.on ? "● ACTIVE 承載流量中" : "▲ STANDBY 未承載"],
		["金絲雀探測延遲", t.canary_ms ? `${t.canary_ms} ms (失敗 ${t.canary_fails || 0} 次)` : "—"],
		["當前生效出口", activeRelay],
		["防漏保護不變量", "0x20000000 FAIL-CLOSED (零直連洩漏)"],
	];
	sumBox.replaceChildren(
		...kvItems.map(([k, v]) => {
			const cell = el("div", "");
			cell.append(el("div", "sub-meta", k), el("div", "", v));
			return cell;
		})
	);

	const relays = (live.relays || [])
		.filter((r) => r.name !== "DIRECT")
		.sort((a, b) => (b.name === "TW-HOME") - (a.name === "TW-HOME") || (b.name === "AUTO") - (a.name === "AUTO") || (a.delay || 9e9) - (b.delay || 9e9));

	$("#relays-grid").replaceChildren(
		...relays.map((r) => {
			const isSel = r.name === live.selected;
			const isSubActive = (live.selected === "TW-HOME" && r.name === live.tw_home) || (live.selected === "AUTO" && r.name === live.auto);
			const btn = el("button", "relay-card" + (isSel ? " sel" : ""));
			btn.type = "button";
			const nameRow = el("div", "r-name", r.name);
			const metaRow = el("div", "r-meta");
			const desc = r.name === "TW-HOME"
				? "台灣家寬零跳IP容災組"
				: r.name === "AUTO"
				? "自動延遲優選組"
				: `${r.type}${isSubActive ? " · 當前生效" : ""}`;
			const lat = el("span", "", r.delay ? `${r.delay} ms` : "—");
			lat.style.color = !r.delay ? "var(--ink-3)" : r.delay < 160 ? "var(--mint)" : r.delay < 350 ? "var(--amber)" : "var(--crimson)";
			metaRow.append(el("span", "", desc), lat);
			btn.append(nameRow, metaRow);
			btn.onclick = () => write("select", { name: r.name });
			return btn;
		})
	);

	const r = S.rules;
	if (!r) return;
	const z = r.sizes || {};
	$("#rules-sizes").replaceChildren(
		el("span", "math", `|@domestic4| = ${z.domestic4 || 0} CIDRs`),
		el("span", "math", `|@tunnel4| = ${z.tunnel4 || 0} CIDRs`),
		el("span", "math", `|D_tunnel| = ${z.tunnel_domains || 0} domains`),
		el("span", "math", `|@tunnel4_dns| = ${z.tunnel4_dns || 0} IPs`),
		el("span", "math", `|@relay4| = ${z.relay4 || 0} IPs`)
	);

	const totalBytes = Math.max(1, ...(r.rules || []).map((x) => x.bytes || 0));
	$("#rules-flow").replaceChildren(
		...(r.rules || []).map((x, idx) => {
			const meta = RULE_META[x.tag] || [x.tag, "PASS", "blue"];
			const row = el("div", "");
			row.style.cssText = "display:grid;grid-template-columns:28px 1.3fr 1fr auto;gap:10px;align-items:center;padding:7px 10px;background:#0a0c12;border:1px solid var(--hair)";
			const num = el("span", "sub-meta", `#${idx + 1}`);
			const titleCol = el("div", "");
			titleCol.append(el("div", "", meta[0]), el("div", "sub-meta", `rule tag: ${x.tag}`));
			const meterCol = el("div", "");
			meterCol.append(
				segBarEl((x.bytes || 0) / totalBytes, meta[2] === "violet" ? "" : meta[2]),
				el("div", "sub-meta", `${countText(x.packets)} pkts · ${sizeText(x.bytes)}`)
			);
			const badge = el("span", "bp-badge " + meta[2], meta[1]);
			row.append(num, titleCol, meterCol, badge);
			return row;
		})
	);
}
