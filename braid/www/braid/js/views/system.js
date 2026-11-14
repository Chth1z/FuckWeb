/**
 * Braid 5.0 Optical Weave — View 06: Doctor Invariant Verifier & Architecture Parameters
 */

import { CHECK_DESC, S, clockText } from "../state.js";
import { $, el, renderEventList } from "../dom.js";
import { write } from "../api.js";

export function renderSystem() {
	if (S.page !== "system") return;
	const d = S.doctor;
	if (d && d.checks) {
		const okCnt = d.checks.filter((c) => c.ok).length;
		$("#doctor-cap").textContent = `最近自檢時間 ${clockText(d.ts)} · 通過率 p = ${(okCnt / Math.max(1, d.checks.length)).toFixed(2)} (${okCnt}/${d.checks.length} sharp)`;
		$("#doctor-list").replaceChildren(
			...d.checks.map((c) => {
				const baseId = c.id.split(":")[0];
				const info = CHECK_DESC[baseId] || [c.id, ""];
				const row = el("div", "");
				row.style.cssText = "display:flex;justify-content:space-between;align-items:center;gap:12px;padding:7px 10px;background:#0a0c12;border:1px solid " + (c.ok ? "var(--hair)" : "var(--crimson)");
				const left = el("div", "");
				left.append(
					el("div", "", `${info[0]} (${c.id})`),
					el("div", "sub-meta", c.detail ? `${info[1]} · 當前: ${c.detail}` : info[1])
				);
				const badge = el("span", "bp-badge " + (c.ok ? "mint" : c.level === "warn" ? "amber" : "crimson"), c.ok ? "✓ PASS" : "✗ FAIL");
				row.append(left, badge);
				return row;
			})
		);
	}

	if (!S.editing) {
		const cur = S.status?.settings || {};
		const paramRows = [
			["weave.policy", "脈衝收割調度器 (Burst-Harvest 2.0)", cur["weave.policy"] || "harvest", true, null],
			["weave.affinity", "單流固定多流攤開 (Per-Flow Spread)", cur["weave.affinity"] || "flow", true, null],
			["classify.remainder", "海外與未知流量默認出口", cur["classify.remainder"] || "tunnel", true, null],
			["classify.quic", "UDP/443 QUIC 處置策略", cur["classify.quic"] || "reject", true, null],
			["tunnel.enabled", "mihomo 台灣家寬隧道引擎", cur["tunnel.enabled"] ?? 1, true, null],
			["tunnel.fail_open", "隧道故障防漏死鎖 (0 = 嚴格阻斷防漏)", cur["tunnel.fail_open"] ?? 0, true, null],
			["strands.aggregate", "多 MAC 21 路 WAN 併發聚合模式", cur["strands.aggregate"] || "auto", false, [["auto", "auto (識別站點自動開啟)"], ["on", "on (強制開啟)"], ["off", "off (關閉)"]]],
			["dns.ads", "SmartDNS 廣告與追蹤域名攔截", String(cur["dns.ads"] ?? "1"), false, [["1", "1 (開啟攔截)"], ["0", "0 (關閉)"]]],
			["strands.probe_interval", "WAN 探針與純網路 RTT 測量週期 (30..3600 秒)", cur["strands.probe_interval"] ?? 180, false, "number"],
			["weave.slots", "ISWRR 編織槽位總數 (0 = 自動按每路 6 槽計算)", cur["weave.slots"] ?? 0, false, "number"],
			["weave.strand_kbit", "單線基準帶寬 kbit/s (0 = 自動學習峰值)", cur["weave.strand_kbit"] ?? 0, false, "number"],
			["main.mss", "TCP MSS 鉗制大小 (0..1460 Bytes)", cur["main.mss"] ?? 1440, false, "number"],
		];

		$("#config-panel").replaceChildren(
			...paramRows.map(([key, label, val, locked, control]) => {
				const row = el("div", "");
				row.style.cssText = "display:flex;justify-content:space-between;align-items:center;gap:12px;padding:7px 10px;background:#0a0c12;border:1px solid var(--hair)";
				const left = el("div", "");
				left.append(el("div", "", label), el("div", "sub-meta", key));
				const right = el("div", "");
				if (locked) {
					right.append(el("span", "bp-badge locked", `${val} [LOCKED]`));
				} else if (Array.isArray(control)) {
					const sel = el("select", "bp-select");
					for (const [v, txt] of control) {
						const o = el("option", "", txt);
						o.value = v;
						o.selected = String(val) === v;
						sel.append(o);
					}
					sel.onchange = () => write("configure", { set: { [key]: sel.value } });
					right.append(sel);
				} else if (control === "number") {
					const inp = el("input", "bp-input");
					inp.type = "number";
					inp.value = String(val);
					inp.style.width = "110px";
					inp.style.textAlign = "right";
					inp.onfocus = () => { S.editing = true; };
					inp.onblur = () => {
						S.editing = false;
						if (inp.value !== "" && String(inp.value) !== String(val)) {
							write("configure", { set: { [key]: Number(inp.value) } });
						}
					};
					inp.onkeydown = (e) => {
						if (e.key === "Enter") inp.blur();
						if (e.key === "Escape") {
							inp.value = String(val);
							inp.blur();
						}
					};
					right.append(inp);
				}
				row.append(left, right);
				return row;
			})
		);
	}

	renderEventList($("#full-events-log"), S.events);
}
