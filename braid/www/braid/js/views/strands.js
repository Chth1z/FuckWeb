/**
 * Braid 5.0 Optical Weave — View 02: 126-Slot ISWRR Chromatic Matrix & 21-Channel WAN Table
 */

import { QUIET, S, strandColor, rateParts, rateText, sizeText } from "../state.js";
import { $, el, svg, segBarEl } from "../dom.js";
import { sparkPath } from "../canvas/oscilloscope.js";

export function setStrandHover(dev) {
	S.hover = dev;
	const st = S.status?.strands.find((x) => x.dev === dev);
	const id = st?.id;
	const p = $("#pattern");
	if (!p) return;
	p.classList.toggle("dim", id != null);
	[...p.children].forEach((c) => c.classList.toggle("on", id != null && +c.dataset.id === id));
}

export function renderStrands() {
	const s = S.status;
	if (!s || S.page !== "strands") return;
	const w = s.weave || {};
	const pat = w.pattern || [];
	const N = s.strands.length || 21;
	const p = $("#pattern");

	$("#weave-cap").textContent = pat.length
		? `${pat.length} 個 ISWRR 槽位，每 ${w.interval || 2} 秒按令牌桶儲能與純網路 RTT 動態重排 · VIP 專線: ${w.vip_dev || "—"}`
		: "單線模式";

	p.replaceChildren(
		...pat.map((id, slotIdx) => {
			const cell = el("i", "pattern-slot");
			cell.dataset.id = id;
			const strandIdx = Math.max(0, id - 1);
			const color = strandColor(strandIdx, N, 0.9, 58);
			cell.style.background = color;
			cell.style.color = color;
			cell.title = `Slot #${slotIdx} → strand #${id} (${s.strands[strandIdx]?.dev || "vwan"})`;
			return cell;
		})
	);

	const topDown = Math.max(QUIET, ...s.strands.map((x) => Math.max(x.now || 0, x.rate || 0, x.peak || 0)));
	const topUp = Math.max(QUIET, ...s.strands.map((x) => Math.max(x.up_now || 0, x.up || 0, x.up_peak || 0)));
	const sparkTop = Math.max(QUIET, ...s.strands.map((x) => Math.max(...(S.series.strands[x.dev] || [0]).slice(-60))));

	const tbody = $("#strands-tbody");
	tbody.replaceChildren(
		...s.strands.map((x, idx) => {
			const tr = el("tr", x.healthy ? "" : "off");
			const hueColor = strandColor(idx, N, 1, 60);

			const c1 = el("td");
			const idWrap = el("div", "strand-id-cell");
			const sw = el("i", "spec-swatch");
			sw.style.background = hueColor;
			sw.style.boxShadow = `0 0 8px ${hueColor}`;
			const info = el("div", "");
			info.append(
				el("div", "", `${x.dev} · #${x.id}`),
				el("div", "sub-meta", `${x.ip || "無地址"} ↦ ${x.gw || "—"}`)
			);
			idWrap.append(sw, info);
			c1.append(idWrap);

			const c2 = el("td");
			let badgeCls = "mint";
			let badgeTxt = "● CHARGED 滿桶";
			if (!x.healthy) {
				badgeCls = "crimson";
				badgeTxt = x.parked ? "⏸ PARKED 停靠" : "✕ OFFLINE 離線";
			} else if (x.vip) {
				badgeCls = "gold";
				badgeTxt = "★ VIP 遊戲專線 (0x100)";
			} else if (x.bucket === "draining") {
				badgeCls = "amber";
				badgeTxt = "⚡ DRAINING 脈衝釋放";
			} else if (x.bucket === "cooling") {
				badgeCls = "blue";
				badgeTxt = `❄ COOLING 冷卻 (${x.cooldown_rem || 0}s)`;
			} else if (x.bucket === "depleted") {
				badgeCls = "crimson";
				badgeTxt = "○ DEPLETED 0槽保護";
			}
			c2.append(el("span", "bp-badge " + badgeCls, badgeTxt));

			const pct = x.tokens_pct ?? Math.round(Math.min(100, Math.max(0, (x.tokens ?? 1e6) / 10000)));
			const kb = Math.round((x.tokens ?? 1e6) / 1000);
			const c3 = el("td");
			const tokWrap = el("div", "seg-meter");
			tokWrap.append(
				segBarEl(pct / 100, pct >= 85 ? "mint" : pct >= 25 ? "gold" : "crimson"),
				el("span", "", `${pct}% · ${kb} KB`)
			);
			c3.append(tokWrap);

			const rttMs = x.ttfb_ms ?? Math.round((x.ttfb || 0) * 1000);
			const c4 = el("td", "num", x.healthy ? `${rttMs} ms` : `HTTP ${x.http || 0}`);
			if (x.healthy && rttMs > 0 && rttMs <= 35) c4.style.color = "var(--mint)";

			const rDown = x.now || x.rate || 0;
			const c5 = el("td");
			const mDown = el("div", "seg-meter");
			mDown.append(segBarEl(rDown / topDown), el("span", "", rateText(rDown)));
			c5.append(mDown);

			const rUp = x.up_now || x.up || 0;
			const c6 = el("td");
			const mUp = el("div", "seg-meter");
			mUp.append(segBarEl(rUp / topUp, "up"), el("span", "", rateText(rUp)));
			c6.append(mUp);

			const c7 = el("td", "num sub-meta", `${rateParts(x.peak || 0)[0]} / ${rateText(x.up_peak || 0)}`);
			const c8 = el("td", "num sub-meta", `${sizeText(x.down_bytes)} / ${sizeText(x.up_bytes)}`);

			const c9 = el("td", "num", x.vip ? "VIP" : String(x.slots || 0));
			if (x.vip) c9.style.color = "var(--gold)";

			const c10 = el("td");
			const sp = svg("svg", { class: "spark", viewBox: "0 0 96 22", "aria-hidden": "true" });
			const pEl = svg("path", { d: sparkPath(S.series.strands[x.dev] || [], sparkTop), stroke: hueColor });
			sp.append(pEl);
			c10.append(sp);

			tr.append(c1, c2, c3, c4, c5, c6, c7, c8, c9, c10);
			tr.onpointerenter = () => setStrandHover(x.dev);
			tr.onpointerleave = () => setStrandHover(null);
			return tr;
		})
	);

	if (S.hover) setStrandHover(S.hover);
}
