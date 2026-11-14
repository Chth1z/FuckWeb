/**
 * Braid 5.0 Optical Weave — Dark Side of the Moon Optical Dispersion Engine (#topo)
 */

import { QUIET, S, strandColor, strandWavelengthNm, rateText, sizeText, asciiBlocks } from "../state.js";
import { $, el } from "../dom.js";

export const topo = {
	pulses: [],
	hover: null,
	pointer: { x: -1, y: -1, active: false },
	smoothWeights: [],
	smoothGlow: [],
	reduce: matchMedia("(prefers-reduced-motion: reduce)").matches,
};

export function setupTopoEvents() {
	const c = $("#topo");
	const tip = $("#topo-tip");
	if (!c || !tip) return;

	c.addEventListener("pointermove", (e) => {
		const r = c.getBoundingClientRect();
		topo.pointer.x = e.clientX - r.left;
		topo.pointer.y = e.clientY - r.top;
		topo.pointer.active = true;
		if (topo.reduce) drawTopo();
	});

	c.addEventListener("pointerleave", () => {
		topo.pointer.active = false;
		topo.hover = null;
		tip.style.opacity = "0";
		if (topo.reduce) drawTopo();
	});
}

function cubicPoint(x0, y0, cx1, cy1, cx2, cy2, x1, y1, t) {
	const k = 1 - t;
	const k2 = k * k, k3 = k2 * k;
	const t2 = t * t, t3 = t2 * t;
	return [
		k3 * x0 + 3 * k2 * t * cx1 + 3 * k * t2 * cx2 + t3 * x1,
		k3 * y0 + 3 * k2 * t * cy1 + 3 * k * t2 * cy2 + t3 * y1,
	];
}

function pointInTriangle(px, py, ax, ay, bx, by, cx, cy) {
	const v0x = cx - ax, v0y = cy - ay;
	const v1x = bx - ax, v1y = by - ay;
	const v2x = px - ax, v2y = py - ay;
	const dot00 = v0x * v0x + v0y * v0y;
	const dot01 = v0x * v1x + v0y * v1y;
	const dot02 = v0x * v2x + v0y * v2y;
	const dot11 = v1x * v1x + v1y * v1y;
	const dot12 = v1x * v2x + v1y * v2y;
	const inv = 1 / (dot00 * dot11 - dot01 * dot01 || 1);
	const u = (dot11 * dot02 - dot01 * dot12) * inv;
	const v = (dot00 * dot12 - dot01 * dot02) * inv;
	return u >= 0 && v >= 0 && u + v <= 1;
}

function updateTopoTooltip() {
	const tip = $("#topo-tip");
	const h = topo.hover;
	const s = S.status;
	if (!tip || !h || !s || !topo.pointer.active) {
		if (tip) tip.style.opacity = "0";
		return;
	}
	const c = $("#topo");
	const W = c.clientWidth;
	const H = c.clientHeight;
	tip.replaceChildren();

	if (h.kind === "strand") {
		const st = s.strands[h.index];
		if (!st) {
			tip.style.opacity = "0";
			return;
		}
		const head = el("div", "tt-head");
		const left = el("span", "", `${st.dev.toUpperCase()} · #${st.id}`);
		left.style.color = strandColor(h.index, s.strands.length, 1, 66);
		const right = el("span", "", `λ ≈ ${strandWavelengthNm(h.index, s.strands.length)} nm`);
		right.style.color = "var(--ink-2)";
		head.append(left, right);
		tip.append(head);

		const stateMap = {
			charged: "CHARGED (滿桶 20M 脈衝就緒)",
			draining: "DRAINING (20M 脈衝釋放中)",
			cooling: `COOLING (冷卻回血 ${st.cooldown_rem || 0}s)`,
			depleted: "DEPLETED (0 槽位限速保護)",
		};
		const rows = [
			["IPv4 / GW", `${st.ip || "—"} ↦ ${st.gw || "—"}`],
			["調度狀態", st.vip ? "★ VIP 遊戲專線 (0x100)" : (stateMap[st.bucket] || st.bucket)],
			["瞬時速率 R(t)", `↓ ${rateText(st.now || st.rate || 0)} · ↑ ${rateText(st.up_now || st.up || 0)}`],
			["平滑峰值 Peak", `↓ ${rateText(st.peak || 0)} · ↑ ${rateText(st.up_peak || 0)}`],
			["純網路延遲 τ_net", st.healthy ? `${st.ttfb_ms ?? Math.round((st.ttfb || 0) * 1000)} ms (HTTP ${st.http})` : `離線 (HTTP ${st.http || 0})`],
			["令牌桶儲能 B_i", `${asciiBlocks(st.tokens_pct ?? 100, 8)} ${st.tokens_pct ?? 100}% (${Math.round((st.tokens ?? 1e6) / 1000)} KB)`],
			["ISWRR 槽位 w_i", st.vip ? "獨立 VIP 通道 (0x100)" : `${st.slots || 0} / ${(s.weave?.pattern || []).length} slots`],
		];
		for (const [k, v] of rows) {
			const r = el("div", "tt-row");
			r.append(el("span", "", k), el("b", "", v));
			tip.append(r);
		}
	} else if (h.kind === "device") {
		const d = h.device;
		const head = el("div", "tt-head");
		head.append(el("span", "", d.name || d.host || d.ip || "LAN 終端"), el("span", "", d.link || "LAN"));
		tip.append(head);
		const rows = [
			["IPv4 / MAC", `${d.ip || "—"} · ${d.mac || ""}`],
			["實時吞吐 R_d", `↓ ${rateText(d.down || 0)} · ↑ ${rateText(d.up || 0)}`],
			["累計流量 Σ", `↓ ${sizeText(d.down_bytes)} · ↑ ${sizeText(d.up_bytes)}`],
			["分流策略", (d.policy || "auto").toUpperCase()],
		];
		for (const [k, v] of rows) {
			const r = el("div", "tt-row");
			r.append(el("span", "", k), el("b", "", v));
			tip.append(r);
		}
	} else if (h.kind === "prism") {
		const w = s.weave || {};
		const head = el("div", "tt-head");
		head.append(el("span", "", "BRAID 5.0 DISPERSIVE PRISM"), el("span", "", `${s.healthy_count || 0}/${s.strand_count || 21} UP`));
		tip.append(head);
		const rows = [
			["總合下行 ∑ R_↓", rateText(s.rate || 0)],
			["總合上行 ∑ R_↑", rateText(s.rate_up || 0)],
			["編織槽位 @pattern", `${(w.pattern || []).length} slots (ISWRR)`],
			["VIP 遊戲專線", `${w.vip_dev || "—"} (#${w.vip_id || "—"}) · ct mark | 0x100`],
			["令牌桶分佈", `${w.charged_count || 0} 滿桶 · ${w.draining_count || 0} 釋放 · ${w.cooling_count || 0} 冷卻`],
			["台灣家寬牢籠", s.tunnel?.on ? `ACTIVE (${s.tunnel.canary_ms || "—"} ms)` : "STANDBY"],
		];
		for (const [k, v] of rows) {
			const r = el("div", "tt-row");
			r.append(el("span", "", k), el("b", "", v));
			tip.append(r);
		}
	}

	const px = Math.max(130, Math.min(W - 130, topo.pointer.x));
	const py = Math.max(150, Math.min(H - 20, topo.pointer.y));
	tip.style.left = px + "px";
	tip.style.top = py + "px";
	tip.style.opacity = "1";
}

export function drawTopo() {
	const c = $("#topo");
	const s = S.status;
	if (!c || S.page !== "overview") return;
	const dpr = window.devicePixelRatio || 1;
	const W = c.clientWidth;
	const H = c.clientHeight;
	if (!W || !H) return;
	if (c.width !== Math.round(W * dpr) || c.height !== Math.round(H * dpr)) {
		c.width = Math.round(W * dpr);
		c.height = Math.round(H * dpr);
	}
	const g = c.getContext("2d");
	g.setTransform(dpr, 0, 0, dpr, 0, 0);
	g.clearRect(0, 0, W, H);

	g.strokeStyle = "rgba(255, 255, 255, 0.022)";
	g.lineWidth = 1;
	const step = 48;
	for (let x = step; x < W; x += step) {
		g.beginPath(); g.moveTo(x, 0); g.lineTo(x, H); g.stroke();
	}
	for (let y = step; y < H; y += step) {
		g.beginPath(); g.moveTo(0, y); g.lineTo(W, y); g.stroke();
	}

	g.strokeStyle = "rgba(255, 255, 255, 0.16)";
	for (const [fx, fy] of [[18, 18], [W - 18, 18], [18, H - 18], [W - 18, H - 18]]) {
		g.beginPath();
		g.moveTo(fx - 5, fy); g.lineTo(fx + 5, fy);
		g.moveTo(fx, fy - 5); g.lineTo(fx, fy + 5);
		g.stroke();
	}

	if (!s || !s.strands || !s.strands.length) return;

	const narrow = W < 640;
	const cx = W * (narrow ? 0.40 : 0.38);
	const cy = H * 0.52;
	const R = Math.min(W * 0.14, H * 0.36, 118);
	const side = R * 1.732;
	const triH = side * 0.866;

	const Ax = cx, Ay = cy - triH * 0.58;
	const Bx = cx - side * 0.5, By = cy + triH * 0.42;
	const Cx = cx + side * 0.5, Cy = cy + triH * 0.42;

	const incT = 0.44;
	const entryX = Ax + (Bx - Ax) * incT;
	const entryY = Ay + (By - Ay) * incT;

	const exitT1 = 0.25, exitT2 = 0.78;
	const exitX1 = Ax + (Cx - Ax) * exitT1, exitY1 = Ay + (Cy - Ay) * exitT1;
	const exitX2 = Ax + (Cx - Ax) * exitT2, exitY2 = Ay + (Cy - Ay) * exitT2;

	const onlineDevs = S.devices
		.filter((d) => d.online)
		.sort((a, b) => (b.down + b.up) - (a.down + a.up))
		.slice(0, narrow ? 4 : 6);
	const devList = onlineDevs.length
		? onlineDevs
		: [{ name: "LAN 聚合入口", ip: s.lan_ip || "192.168.16.1", down: s.rate || 0, up: s.rate_up || 0, link: "LAN", policy: "auto" }];

	const devMaxRate = Math.max(QUIET, ...devList.map((d) => (d.down || 0) + (d.up || 0)));
	const devStartX = narrow ? 96 : 168;

	const strands = s.strands;
	const N = strands.length;
	const strandMaxRate = Math.max(
		QUIET,
		...strands.map((x) => Math.max((x.now || 0) + (x.up_now || 0), (x.rate || 0) + (x.up || 0), (x.peak || 0) * 0.35))
	);

	if (topo.smoothWeights.length !== N) {
		topo.smoothWeights = strands.map(() => 1);
		topo.smoothGlow = strands.map(() => 0.55);
	}

	for (let i = 0; i < N; i++) {
		const st = strands[i];
		const rawRate = Math.max((st.now || 0) + (st.up_now || 0), (st.rate || 0) + (st.up || 0));
		const rateNorm = st.healthy ? Math.min(1, Math.sqrt(rawRate / strandMaxRate)) : 0;
		const tokFrac = Math.max(0, Math.min(1, (st.tokens_pct ?? 100) / 100));

		const targetWeight = !st.healthy
			? 0.45
			: 0.85 + 2.35 * rateNorm + (st.vip ? 0.45 : 0) + 0.25 * tokFrac;

		const targetGlow = !st.healthy
			? 0.12
			: st.bucket === "cooling" || st.bucket === "depleted"
			? 0.22 + 0.25 * rateNorm
			: 0.50 + 0.48 * rateNorm + (st.vip ? 0.12 : 0);

		topo.smoothWeights[i] += (targetWeight - topo.smoothWeights[i]) * 0.18;
		topo.smoothGlow[i] += (targetGlow - topo.smoothGlow[i]) * 0.18;
	}

	const totalWeight = topo.smoothWeights.reduce((a, b) => a + b, 0) || 1;
	const rightTopY = 26;
	const rightBotY = H - 26;
	const rightSpanY = rightBotY - rightTopY;

	const bandBounds = [];
	let accW = 0;
	for (let i = 0; i < N; i++) {
		const u0 = accW / totalWeight;
		accW += topo.smoothWeights[i];
		const u1 = accW / totalWeight;

		const sx0 = exitX1 + (exitX2 - exitX1) * u0;
		const sy0 = exitY1 + (exitY2 - exitY1) * u0;
		const sx1 = exitX1 + (exitX2 - exitX1) * u1;
		const sy1 = exitY1 + (exitY2 - exitY1) * u1;

		const ex0 = W - 2, ey0 = rightTopY + rightSpanY * u0;
		const ex1 = W - 2, ey1 = rightTopY + rightSpanY * u1;

		bandBounds.push({
			u0, u1,
			sx0, sy0, sx1, sy1,
			ex0, ey0, ex1, ey1,
			sMidX: (sx0 + sx1) * 0.5,
			sMidY: (sy0 + sy1) * 0.5,
			eMidX: W - 2,
			eMidY: (ey0 + ey1) * 0.5,
		});
	}

	topo.hover = null;
	if (topo.pointer.active) {
		const px = topo.pointer.x;
		const py = topo.pointer.y;

		if (pointInTriangle(px, py, Ax, Ay, Bx, By, Cx, Cy)) {
			topo.hover = { kind: "prism" };
		} else if (px > entryX + 10) {
			for (let i = 0; i < N; i++) {
				const b = bandBounds[i];
				const spanX = Math.max(1, W - b.sMidX);
				const t = Math.max(0, Math.min(1, (px - b.sMidX) / spanX));
				const c1x = b.sMidX + spanX * 0.34;
				const c2x = b.sMidX + spanX * 0.68;
				const [, topY] = cubicPoint(b.sx0, b.sy0, c1x, b.sy0 + (b.ey0 - b.sy0) * 0.16, c2x, b.ey0 - (b.ey0 - b.sy0) * 0.12, b.ex0, b.ey0, t);
				const [, botY] = cubicPoint(b.sx1, b.sy1, c1x, b.sy1 + (b.ey1 - b.sy1) * 0.16, c2x, b.ey1 - (b.ey1 - b.sy1) * 0.12, b.ex1, b.ey1, t);
				if (py >= topY - 2 && py <= botY + 2) {
					topo.hover = { kind: "strand", index: i };
					break;
				}
			}
		} else {
			const m = devList.length;
			for (let j = 0; j < m; j++) {
				const yStart = m > 1 ? 48 + (H - 96) * (j / (m - 1)) : cy;
				const t = Math.max(0, Math.min(1, (px - devStartX) / Math.max(1, entryX - devStartX)));
				const midX = (devStartX + entryX) * 0.52;
				const [, by] = cubicPoint(devStartX, yStart, midX, yStart, midX, entryY, entryX, entryY, t);
				if (px >= 12 && px <= entryX + 10 && Math.abs(py - by) < 15) {
					topo.hover = { kind: "device", index: j, device: devList[j] };
					break;
				}
			}
		}
	}

	updateTopoTooltip();

	// 2. Left Incident Coherent White Beams
	const m = devList.length;
	const monoFont = getComputedStyle(document.documentElement).getPropertyValue("--mono");
	for (let j = 0; j < m; j++) {
		const d = devList[j];
		const yStart = m > 1 ? 48 + (H - 96) * (j / (m - 1)) : cy;
		const raw = (d.down || 0) + (d.up || 0);
		const k = Math.min(1, Math.sqrt(raw / devMaxRate));
		const isHovered = topo.hover?.kind === "device" && topo.hover.index === j;

		const coreWidth = 1.3 + 4.2 * k + (isHovered ? 1.2 : 0);
		const haloWidth = coreWidth * 3.4;
		const haloAlpha = 0.10 + 0.34 * k + (isHovered ? 0.2 : 0);
		const coreAlpha = 0.45 + 0.55 * k + (isHovered ? 0.2 : 0);
		const midX = (devStartX + entryX) * 0.52;

		g.save();
		g.beginPath();
		g.moveTo(devStartX, yStart);
		g.bezierCurveTo(midX, yStart, midX, entryY, entryX, entryY);
		g.strokeStyle = `rgba(210, 232, 255, ${haloAlpha.toFixed(3)})`;
		g.lineWidth = haloWidth;
		g.lineCap = "round";
		g.stroke();

		g.beginPath();
		g.moveTo(devStartX, yStart);
		g.bezierCurveTo(midX, yStart, midX, entryY, entryX, entryY);
		g.strokeStyle = `rgba(255, 255, 255, ${Math.min(1, coreAlpha).toFixed(3)})`;
		g.lineWidth = coreWidth;
		g.shadowColor = "rgba(220, 240, 255, 0.95)";
		g.shadowBlur = 6 + 18 * k + (isHovered ? 8 : 0);
		g.stroke();
		g.restore();

		g.save();
		g.beginPath();
		g.arc(devStartX, yStart, 3 + 2 * k, 0, Math.PI * 2);
		g.fillStyle = "#ffffff";
		g.shadowColor = "#ffffff";
		g.shadowBlur = 8 + 10 * k;
		g.fill();
		g.restore();

		let label = d.name || d.host || d.ip || "terminal";
		g.font = "600 11.5px " + monoFont;
		g.textAlign = "right";
		g.textBaseline = "middle";
		g.fillStyle = isHovered ? "#ffffff" : k > 0.15 ? "#e8ecf4" : "#8c96ab";
		while (label.length > 4 && g.measureText(label).width > devStartX - 24) {
			label = label.slice(0, -2) + "…";
		}
		g.fillText(label, devStartX - 12, yStart - 6);

		g.font = "10.5px " + monoFont;
		g.fillStyle = k > 0.05 ? "#68a3dc" : "#525b70";
		g.fillText(raw > 128 ? rateText(raw) : (d.ip || "idle"), devStartX - 12, yStart + 8);
	}

	// 3. Right 21-Strand Continuous Rainbow Spectrum Ribbon
	const anyStrandHovered = topo.hover?.kind === "strand";
	for (let i = 0; i < N; i++) {
		const st = strands[i];
		const b = bandBounds[i];
		const isHovered = anyStrandHovered && topo.hover.index === i;
		const glow = topo.smoothGlow[i];
		const rawRate = Math.max((st.now || 0) + (st.up_now || 0), (st.rate || 0) + (st.up || 0));
		const k = st.healthy ? Math.min(1, Math.sqrt(rawRate / strandMaxRate)) : 0;

		const spanX = W - b.sMidX;
		const c1x = b.sMidX + spanX * 0.34;
		const c2x = b.sMidX + spanX * 0.68;

		let alpha = glow;
		if (anyStrandHovered) {
			alpha = isHovered ? 0.98 : Math.max(0.10, glow * 0.32);
		}

		const light = isHovered ? 66 : 52 + Math.round(16 * k);
		const grad = g.createLinearGradient(b.sMidX, b.sMidY, W, b.eMidY);
		grad.addColorStop(0, strandColor(i, N, Math.min(1, alpha * 1.12), light + 6));
		grad.addColorStop(0.55, strandColor(i, N, alpha, light));
		grad.addColorStop(1, strandColor(i, N, alpha * 0.88, light - 2));

		g.save();
		g.beginPath();
		g.moveTo(b.sx0, b.sy0);
		g.bezierCurveTo(c1x, b.sy0 + (b.ey0 - b.sy0) * 0.16, c2x, b.ey0 - (b.ey0 - b.sy0) * 0.12, b.ex0, b.ey0);
		g.lineTo(b.ex1, b.ey1);
		g.bezierCurveTo(c2x, b.ey1 - (b.ey1 - b.sy1) * 0.12, c1x, b.sy1 + (b.ey1 - b.sy1) * 0.16, b.sx1, b.sy1);
		g.closePath();

		if (k > 0.12 || isHovered || st.vip) {
			g.shadowColor = strandColor(i, N, 0.85, 62);
			g.shadowBlur = isHovered ? 22 : 8 + 18 * k;
		}
		g.fillStyle = grad;
		g.fill();

		if ((st.healthy && k > 0.08) || st.vip || isHovered) {
			g.beginPath();
			g.moveTo(b.sMidX, b.sMidY);
			g.bezierCurveTo(c1x, b.sMidY + (b.eMidY - b.sMidY) * 0.16, c2x, b.eMidY - (b.eMidY - b.sMidY) * 0.12, b.eMidX, b.eMidY);
			g.strokeStyle = isHovered || st.vip
				? `rgba(255, 255, 255, ${(0.55 + 0.4 * k).toFixed(2)})`
				: strandColor(i, N, 0.45 + 0.5 * k, 82);
			g.lineWidth = isHovered ? 2.2 : 0.8 + 2.4 * k;
			g.stroke();
		}
		g.restore();
	}

	// 4. Travelling Coherent Light Wavepackets
	if (!topo.reduce) {
		topo.pulses = topo.pulses.filter((p) => p.t < 1);
		for (let i = 0; i < N; i++) {
			const st = strands[i];
			if (!st.healthy) continue;
			const raw = Math.max((st.now || 0) + (st.up_now || 0), (st.rate || 0) + (st.up || 0));
			const k = Math.min(1, raw / strandMaxRate);
			if (k > 0.02 && Math.random() < 0.04 + k * 0.28) {
				topo.pulses.push({ kind: "strand", i, t: 0, v: 0.008 + 0.018 * Math.sqrt(k), k });
			}
		}
		for (let j = 0; j < m; j++) {
			const d = devList[j];
			const raw = (d.down || 0) + (d.up || 0);
			const k = Math.min(1, raw / devMaxRate);
			if (k > 0.02 && Math.random() < 0.05 + k * 0.25) {
				topo.pulses.push({ kind: "dev", j, t: 0, v: 0.012 + 0.020 * Math.sqrt(k), k });
			}
		}

		for (const p of topo.pulses) {
			p.t += p.v;
			const t = Math.min(1, p.t);
			if (p.kind === "strand" && p.i < bandBounds.length) {
				const b = bandBounds[p.i];
				const spanX = W - b.sMidX;
				const c1x = b.sMidX + spanX * 0.34;
				const c2x = b.sMidX + spanX * 0.68;
				const [px, py] = cubicPoint(b.sMidX, b.sMidY, c1x, b.sMidY + (b.eMidY - b.sMidY) * 0.16, c2x, b.eMidY - (b.eMidY - b.sMidY) * 0.12, b.eMidX, b.eMidY, t);
				g.save();
				g.beginPath();
				g.arc(px, py, 1.4 + 1.8 * p.k, 0, Math.PI * 2);
				g.fillStyle = `rgba(255, 255, 255, ${(0.85 * Math.sin(Math.PI * t)).toFixed(2)})`;
				g.shadowColor = strandColor(p.i, N, 1, 70);
				g.shadowBlur = 10;
				g.fill();
				g.restore();
			} else if (p.kind === "dev" && p.j < m) {
				const yStart = m > 1 ? 48 + (H - 96) * (p.j / (m - 1)) : cy;
				const midX = (devStartX + entryX) * 0.52;
				const [px, py] = cubicPoint(devStartX, yStart, midX, yStart, midX, entryY, entryX, entryY, t);
				g.save();
				g.beginPath();
				g.arc(px, py, 1.6 + 1.6 * p.k, 0, Math.PI * 2);
				g.fillStyle = `rgba(255, 255, 255, ${(0.9 * Math.sin(Math.PI * t)).toFixed(2)})`;
				g.shadowColor = "#ffffff";
				g.shadowBlur = 10;
				g.fill();
				g.restore();
			}
		}
	}

	// 5. Central Equilateral Dispersive Crystal Prism
	g.save();
	g.beginPath();
	g.moveTo(Ax, Ay);
	g.lineTo(Bx, By);
	g.lineTo(Cx, Cy);
	g.closePath();
	const prismFill = g.createLinearGradient(Ax, Ay, cx, By);
	prismFill.addColorStop(0, "rgba(18, 24, 38, 0.92)");
	prismFill.addColorStop(1, "rgba(6, 8, 14, 0.96)");
	g.fillStyle = prismFill;
	g.fill();

	g.beginPath();
	g.moveTo(entryX, entryY);
	g.lineTo(exitX1, exitY1);
	g.lineTo(exitX2, exitY2);
	g.closePath();
	const wedgeGrad = g.createLinearGradient(entryX, entryY, (exitX1 + exitX2) * 0.5, (exitY1 + exitY2) * 0.5);
	wedgeGrad.addColorStop(0, "rgba(255, 255, 255, 0.88)");
	wedgeGrad.addColorStop(0.38, "rgba(210, 230, 255, 0.34)");
	wedgeGrad.addColorStop(1, "rgba(180, 205, 255, 0.10)");
	g.fillStyle = wedgeGrad;
	g.fill();

	g.beginPath();
	g.moveTo(Ax, Ay);
	g.lineTo(Bx, By);
	g.lineTo(Cx, Cy);
	g.closePath();
	g.lineWidth = topo.hover?.kind === "prism" ? 3.0 : 2.2;
	g.strokeStyle = "rgba(215, 232, 252, 0.85)";
	g.shadowColor = "rgba(140, 195, 255, 0.55)";
	g.shadowBlur = topo.hover?.kind === "prism" ? 22 : 14;
	g.stroke();

	const inset = 0.90;
	g.beginPath();
	g.moveTo(cx + (Ax - cx) * inset, cy + (Ay - cy) * inset);
	g.lineTo(cx + (Bx - cx) * inset, cy + (By - cy) * inset);
	g.lineTo(cx + (Cx - cx) * inset, cy + (Cy - cy) * inset);
	g.closePath();
	g.lineWidth = 1;
	g.shadowBlur = 0;
	g.strokeStyle = "rgba(140, 175, 220, 0.25)";
	g.stroke();

	g.beginPath();
	g.arc(entryX, entryY, 3.2, 0, Math.PI * 2);
	g.fillStyle = "#ffffff";
	g.shadowColor = "#ffffff";
	g.shadowBlur = 12;
	g.fill();
	g.restore();

	g.save();
	g.font = "11px " + monoFont;
	g.fillStyle = "rgba(155, 164, 184, 0.78)";
	g.textAlign = "center";
	g.fillText(`Δ_prism · ${s.weave?.slots || 126} slots`, cx, By + 18);
	if (s.weave?.vip_dev) {
		g.fillStyle = "rgba(235, 196, 101, 0.9)";
		g.fillText(`★ VIP: ${s.weave.vip_dev} (0x100)`, cx, Ay - 12);
	}
	g.restore();
}

export function startPrismLoop() {
	drawTopo();
	if (!topo.reduce) requestAnimationFrame(startPrismLoop);
}
