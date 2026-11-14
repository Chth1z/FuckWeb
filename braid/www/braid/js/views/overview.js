/**
 * Braid 5.0 Optical Weave — View 01: Overview, Blueprint Schematic & Persistent CLI Footer
 */

import { QUIET, S, agoText, rateText, sizeText } from "../state.js";
import { $, el, segBarEl, renderEventList } from "../dom.js";
import { write } from "../api.js";

export function renderOverview() {
	const s = S.status;
	if (!s) return;

	$("#hdr-ip").textContent = s.lan_ip || "192.168.16.1";
	$("#hdr-ver").textContent = `braid v${s.version || "5.0.0"} · reconciled ${agoText(s.reconciled)}`;

	const healthy = s.healthy_count ?? s.strands.filter((x) => x.healthy).length;
	const total = s.strand_count ?? s.strands.length;
	const fails = (s.fail || []).length;
	const warns = (s.warn || []).length;

	const pill = $("#health-pill");
	if (fails > 0) {
		pill.className = "bp-badge crimson";
		pill.textContent = `▲ ${fails} FAIL · ${healthy}/${total}`;
	} else if (warns > 0) {
		pill.className = "bp-badge amber";
		pill.textContent = `◆ ${warns} WARN · ${healthy}/${total}`;
	} else {
		pill.className = "bp-badge mint";
		pill.textContent = `● ${healthy}/${total} SHARP`;
	}

	const onlineDevs = S.devices.filter((d) => d.online).length;
	$("#n-strands").textContent = `${healthy}/${total}`;
	$("#n-devices").textContent = String(onlineDevs);
	$("#n-conn").textContent = S.conns.length ? String(S.conns.length) : "—";

	const t = s.tunnel || {};
	$("#adv-verdict").textContent = t.on
		? `» P(leak) = 0 · TW-HOME caged`
		: `» fail-closed · 0x20000000 active`;
	$("#adv-strands").textContent = `${healthy} / ${total} ok`;
	$("#adv-ct").textContent = s.sys?.conntrack
		? `${s.sys.conntrack.count} / ${s.sys.conntrack.max}`
		: "—";
	$("#adv-canary").textContent = t.canary_ms ? `${t.canary_ms} ms` : "—";
	$("#adv-dns").textContent = s.dns?.smartdns ? `ONLINE :${s.dns.port || 6053}` : "DOWN";

	if (S.doctor?.checks) {
		const okCnt = S.doctor.checks.filter((c) => c.ok).length;
		const totCnt = S.doctor.checks.length;
		const docEl = $("#adv-doctor");
		docEl.textContent = `${okCnt}/${totCnt} sharp`;
		docEl.style.color = okCnt === totCnt ? "var(--mint)" : "var(--amber)";
	}

	$("#ov-down").textContent = rateText(s.rate || 0);
	$("#ov-up").textContent = rateText(s.rate_up || 0);
	const peakDown = S.series.total.length ? Math.max(...S.series.total) : s.rate || 0;
	$("#ov-peak").textContent = rateText(peakDown);

	const w = s.weave || {};
	const loadRatio = Math.min(1, ((s.rate || 0) + (s.rate_up || 0)) / (QUIET * 25));
	const activeBars = Math.max(1, Math.min(5, Math.ceil(loadRatio * 5 + (w.draining_count || 0) * 0.5)));
	const effortBox = $("#ov-effort");
	[...effortBox.children].forEach((b, idx) => b.classList.toggle("on", idx < activeBars));
	$("#ov-effort-txt").textContent = activeBars >= 4 ? "bursting" : activeBars >= 2 ? "active" : "ready";

	const patLen = (w.pattern || []).length;
	$("#cap-slots").textContent = String(patLen || w.slots || 126);

	const denom = Math.max(1, healthy || total || 21);
	const chargedR = (w.charged_count ?? healthy) / denom;
	const drainingR = (w.draining_count ?? 0) / denom;
	const coolingR = ((w.cooling_count ?? 0) + (w.depleted_count ?? 0)) / denom;

	$("#bar-charged").style.width = (chargedR * 100).toFixed(1) + "%";
	$("#val-charged").textContent = `${w.charged_count ?? healthy}/${denom}`;

	$("#bar-draining").style.width = (drainingR * 100).toFixed(1) + "%";
	$("#val-draining").textContent = `${w.draining_count ?? 0}/${denom}`;

	$("#bar-cooling").style.width = (coolingR * 100).toFixed(1) + "%";
	$("#val-cooling").textContent = `${(w.cooling_count ?? 0) + (w.depleted_count ?? 0)}/${denom}`;

	const vipStrand = s.strands.find((x) => x.vip) || s.strands.find((x) => x.id === w.vip_id);
	$("#bar-vip").style.width = vipStrand ? "100%" : "0%";
	$("#val-vip").textContent = vipStrand
		? `${vipStrand.dev} · ${vipStrand.ttfb_ms ?? Math.round((vipStrand.ttfb || 0) * 1000)}ms`
		: (w.vip_dev || "auto");

	const pctHealthy = Math.round((healthy / Math.max(1, total)) * 100);
	$("#sub1-sub").textContent = `${patLen} slots · ISWRR`;
	$("#sub1-bar").style.width = pctHealthy + "%";
	$("#sub1-pct").textContent = pctHealthy + "%";
	$("#sub1-desc").textContent = `Σ ↓ ${sizeText(s.down_bytes)} · ↑ ${sizeText(s.up_bytes)}`;
	$("#sub1-st").textContent = s.site?.aggregate ? "weaving" : "single-wan";

	const twName = S.tunnel?.selected === "TW-HOME" && S.tunnel?.tw_home
		? S.tunnel.tw_home
		: (S.tunnel?.selected || "TW-HOME");
	$("#sub2-sub").textContent = t.on ? "mihomo tproxy :7893" : "bypassed";
	const canaryScore = t.canary_ms ? Math.max(15, Math.min(100, Math.round(100 - t.canary_ms / 8))) : (t.on ? 100 : 0);
	$("#sub2-bar").style.width = canaryScore + "%";
	$("#sub2-pct").textContent = t.canary_ms ? `${t.canary_ms}ms` : (t.on ? "ON" : "OFF");
	$("#sub2-desc").textContent = twName;
	$("#sub2-st").textContent = t.on ? "caged · 0x20000000" : "standby";

	const site = s.site || {};
	$("#sub3-title").textContent = `site · ${site.known ? site.name : site.gateway ? "unknown" : "probing"}`;
	$("#sub3-sub").textContent = site.gateway || "detecting gateway…";
	$("#sub3-desc").textContent = site.aggregate
		? `${healthy}/${total} 路多 MAC 併發聚合中`
		: "普通單線路由模式";
	$("#sub3-st").textContent = site.known ? "recognised" : "unregistered";

	const seg = $("#site-mode-seg");
	seg.replaceChildren(
		...[["auto", "自動"], ["on", "聚合"], ["off", "單線"]].map(([v, label]) => {
			const b = el("button", site.mode === v ? "on" : "", label);
			b.type = "button";
			b.onclick = () => write("configure", { set: { "strands.aggregate": v } });
			return b;
		})
	);

	const memBtn = $("#site-mem-btn");
	if (!site.known && site.gateway) {
		memBtn.style.display = "inline-flex";
		memBtn.textContent = "+ 記住站點";
		memBtn.onclick = () => {
			const name = prompt("給當前上游網路站點命名：", "linkbroad");
			if (name) write("remember", { name, aggregate: true, portal: "" });
		};
	} else if (site.known) {
		memBtn.style.display = "inline-flex";
		memBtn.textContent = "忘記";
		memBtn.onclick = () => {
			if (confirm(`確定忘記站點「${site.name}」嗎？`)) write("forget", {});
		};
	} else {
		memBtn.style.display = "none";
	}

	const topDevs = S.devices
		.filter((d) => d.online)
		.sort((a, b) => (b.down + b.up) - (a.down + a.up))
		.slice(0, 6);
	const topBox = $("#top-dev-list");
	if (!topDevs.length) {
		topBox.replaceChildren(el("div", "sub-meta", "暫無在線局域網終端"));
	} else {
		const maxD = Math.max(QUIET, ...topDevs.map((d) => d.down + d.up));
		topBox.replaceChildren(
			...topDevs.map((d) => {
				const row = el("div", "");
				row.style.cssText = "display:grid;grid-template-columns:1.2fr 90px 1fr auto;gap:10px;align-items:center;padding:6px 8px;background:#0b0d13;border:1px solid var(--hair)";
				const nameCol = el("div", "");
				nameCol.append(
					el("div", "", d.name || d.host || d.ip || d.mac),
					el("div", "sub-meta", `${d.ip || "—"} · ${d.link || "LAN"}`)
				);
				const polBadge = el(
					"span",
					"bp-badge " + (d.policy === "game" ? "gold" : d.policy === "tunnel" ? "violet" : d.policy === "direct" ? "blue" : "mint"),
					(d.policy || "auto").toUpperCase()
				);
				const barCol = segBarEl((d.down + d.up) / maxD);
				const rateCol = el("div", "num", `↓ ${rateText(d.down)} · ↑ ${rateText(d.up)}`);
				rateCol.style.fontSize = "11.5px";
				row.append(nameCol, polBadge, barCol, rateCol);
				return row;
			})
		);
	}

	renderEventList($("#ov-session-log"), S.events.slice(0, 8));

	$("#cli-cage").textContent = (S.tunnel?.selected || "tw-home").toLowerCase();
	$("#cli-vip").textContent = vipStrand ? vipStrand.dev : (w.vip_dev || "auto");
	$("#ft-strands").textContent = `[${healthy}/${total} sharp]`;
	$("#ft-cap").textContent = `[${w.charged_count ?? healthy} charged · ${w.draining_count ?? 0} burst]`;
	$("#ft-vip").textContent = vipStrand
		? `[${vipStrand.dev} · ${vipStrand.ttfb_ms ?? Math.round((vipStrand.ttfb || 0) * 1000)}ms]`
		: `[${w.vip_dev || "auto"}]`;
	$("#ft-tunnel").textContent = t.on
		? `[${twName} · ${t.canary_ms || "—"}ms]`
		: `[standby]`;
	$("#ft-guard").textContent = `[0x20000000 ${s.ok ? "sharp" : "warn"}]`;
}
