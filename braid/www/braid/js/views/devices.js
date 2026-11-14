/**
 * Braid 5.0 Optical Weave — View 03: LAN Terminal Policy Matrix
 */

import { QUIET, POLICY_OPTS, S, rateText, sizeText } from "../state.js";
import { $, el, segBarEl } from "../dom.js";
import { write } from "../api.js";

export function renderDevices() {
	if (S.page !== "devices" || S.editing) return;
	const list = [...S.devices].sort(
		(a, b) => (b.online - a.online) || ((b.down + b.up) - (a.down + a.up)) || (a.name || a.mac).localeCompare(b.name || b.mac)
	);
	const topDown = Math.max(QUIET, ...list.map((d) => d.down || 0));
	const topUp = Math.max(QUIET, ...list.map((d) => d.up || 0));

	const tbody = $("#devices-tbody");
	tbody.replaceChildren(
		...list.map((d) => {
			const tr = el("tr", d.online ? "" : "off");

			const c1 = el("td");
			const inp = el("input", "bp-input");
			inp.value = d.name || "";
			inp.placeholder = d.host || "未命名終端 (點擊命名)";
			inp.style.width = "210px";
			inp.onfocus = () => { S.editing = true; };
			inp.onblur = () => {
				S.editing = false;
				if (inp.value !== (d.name || "")) {
					write("device", { mac: d.mac, name: inp.value.trim(), policy: d.policy || "auto" });
				}
			};
			inp.onkeydown = (e) => {
				if (e.key === "Enter") inp.blur();
				if (e.key === "Escape") {
					inp.value = d.name || "";
					inp.blur();
				}
			};
			c1.append(inp, el("div", "sub-meta", `${d.ip || "無 IP"}  ·  ${d.mac}`));

			const c2 = el("td");
			const linkTxt = !d.online
				? "○ 離線 (OFFLINE)"
				: d.link === "wired"
				? "● 有線千兆 (ETH)"
				: `● Wi-Fi ${d.link}${d.signal ? ` (${d.signal} dBm)` : ""}`;
			c2.append(el("span", "bp-badge " + (d.online ? "mint" : ""), linkTxt));

			const c3 = el("td");
			const mDown = el("div", "seg-meter");
			mDown.append(segBarEl((d.down || 0) / topDown), el("span", "", rateText(d.down || 0)));
			c3.append(mDown);

			const c4 = el("td");
			const mUp = el("div", "seg-meter");
			mUp.append(segBarEl((d.up || 0) / topUp, "up"), el("span", "", rateText(d.up || 0)));
			c4.append(mUp);

			const c5 = el("td", "num sub-meta", `${sizeText(d.down_bytes)} / ${sizeText(d.up_bytes)}`);

			const c6 = el("td");
			const sel = el("select", "bp-select");
			for (const [val, label] of POLICY_OPTS) {
				const opt = el("option", "", label);
				opt.value = val;
				opt.selected = (d.policy || "auto") === val;
				sel.append(opt);
			}
			sel.onchange = () => write("device", { mac: d.mac, name: d.named ? d.name : "", policy: sel.value });
			c6.append(sel);

			tr.append(c1, c2, c3, c4, c5, c6);
			return tr;
		})
	);
}
