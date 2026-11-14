/**
 * Braid 5.0 Optical Weave — Dual-Channel Time-Series Oscilloscope (#chart) & Sparklines
 */

import { QUIET, S, niceStep, rateText, clockText } from "../state.js";
import { $, el, svg } from "../dom.js";

export function sparkPath(row, max) {
	const pts = (row || []).slice(-60);
	const n = pts.length;
	if (n < 2) return "";
	return pts
		.map((v, i) => (i ? "L" : "M") + ((96 * i) / (n - 1)).toFixed(1) + " " + (20 - 18 * Math.min(1, (v || 0) / max)).toFixed(1))
		.join("");
}

export function renderChart() {
	const box = $("#chart");
	const d = S.series;
	const n = d.total.length;
	if (!box || S.page !== "overview") return;

	box.querySelector("svg")?.remove();
	box.querySelector(".empty-msg")?.remove();

	if (n < 2) {
		const empty = el("div", "empty-msg", "正在採集實時吞吐序列…");
		empty.style.cssText = "padding:60px;text-align:center;color:var(--ink-3)";
		box.append(empty);
		return;
	}

	const W = box.clientWidth - 12;
	const H = box.clientHeight - 12;
	if (W <= 0 || H <= 0) return;

	const L = 8, R = 8, T = 12, B = 22;
	const upRow = d.up.length === n ? d.up : d.total.map(() => 0);
	const peakBits = Math.max(...d.total, ...upRow, QUIET / 2) * 8;
	const stepBits = niceStep(peakBits);
	const lines = Math.max(1, Math.ceil((peakBits * 1.04) / stepBits));
	const maxBytes = (lines * stepBits) / 8;

	const x = (i) => L + (W - L - R) * (i / (n - 1));
	const y = (v) => T + (H - T - B) * (1 - Math.min(1, (v || 0) / maxBytes));

	const root = svg("svg", { viewBox: `0 0 ${W} ${H}`, role: "img", "aria-label": "實時吞吐示波器" });

	for (let k = 0; k <= lines; k++) {
		const v = (maxBytes * k) / lines;
		const yy = y(v);
		root.append(svg("line", { class: "grid-line", x1: L, x2: W - R, y1: yy, y2: yy }));
		if (k > 0) {
			const t = svg("text", { class: "tick", x: L + 2, y: yy - 4 });
			t.textContent = rateText(v);
			root.append(t);
		}
	}

	const buildPath = (row) => row.map((v, i) => (i ? "L" : "M") + x(i).toFixed(1) + " " + y(v).toFixed(1)).join("");
	const dnD = buildPath(d.total);
	const upD = buildPath(upRow);

	const area = svg("path", { class: "area", d: `${dnD}L${x(n - 1).toFixed(1)} ${y(0).toFixed(1)}L${x(0).toFixed(1)} ${y(0).toFixed(1)}Z` });
	const upPath = svg("path", { class: "line", d: upD, stroke: "var(--up)" });
	const dnPath = svg("path", { class: "line", d: dnD, stroke: "var(--down)" });
	root.append(area, upPath, dnPath);

	const ticks = n > 8 ? [0, Math.floor((n - 1) / 2), n - 1] : [0, n - 1];
	ticks.forEach((idx, k, arr) => {
		const t = svg("text", {
			class: "tick",
			x: x(idx),
			y: H - 4,
			"text-anchor": k === 0 ? "start" : k === arr.length - 1 ? "end" : "middle",
		});
		t.textContent = clockText(d.ts[idx]);
		root.append(t);
	});

	const cross = svg("line", { class: "cross", y1: T, y2: H - B, visibility: "hidden" });
	const m1 = svg("circle", { r: 4, fill: "var(--down)", visibility: "hidden" });
	const m2 = svg("circle", { r: 4, fill: "var(--up)", visibility: "hidden" });
	root.append(cross, m2, m1);
	box.prepend(root);

	const tip = $("#tip");
	root.onpointermove = (e) => {
		const r = root.getBoundingClientRect();
		const i = Math.max(0, Math.min(n - 1, Math.round(((e.clientX - r.left - L) / Math.max(1, r.width - L - R)) * (n - 1))));
		cross.setAttribute("x1", x(i));
		cross.setAttribute("x2", x(i));
		cross.setAttribute("visibility", "visible");
		m1.setAttribute("cx", x(i));
		m1.setAttribute("cy", y(d.total[i]));
		m1.setAttribute("visibility", "visible");
		m2.setAttribute("cx", x(i));
		m2.setAttribute("cy", y(upRow[i]));
		m2.setAttribute("visibility", "visible");

		if (tip) {
			tip.textContent = `${clockText(d.ts[i])}  ·  ↓ ${rateText(d.total[i])}  ·  ↑ ${rateText(upRow[i])}`;
			tip.style.left = Math.max(90, Math.min(r.width - 90, x(i))) + "px";
			tip.style.top = Math.max(24, y(Math.max(d.total[i], upRow[i]))) + "px";
			tip.style.opacity = "1";
		}
	};

	root.onpointerleave = () => {
		cross.setAttribute("visibility", "hidden");
		m1.setAttribute("visibility", "hidden");
		m2.setAttribute("visibility", "hidden");
		if (tip) tip.style.opacity = "0";
	};

	const spanMin = (d.ts[n - 1] - d.ts[0]) / 60;
	const rangeEl = $("#chart-range");
	if (rangeEl) {
		rangeEl.textContent = spanMin >= 1 ? `最近 ${Math.round(spanMin)} 分鐘` : `最近 ${Math.round(spanMin * 60)} 秒`;
	}
}
