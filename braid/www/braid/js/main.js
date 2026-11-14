/**
 * Braid 5.0 Optical Weave — Application Bootstrap, Router & Polling Loop
 */

import { ANON, PAGES, S } from "./state.js";
import { $, $$ } from "./dom.js";
import { ubus, write, signOut, bindAuthModal, registerApiHooks } from "./api.js";
import { topo, setupTopoEvents, drawTopo, startPrismLoop } from "./canvas/prism.js";
import { renderChart } from "./canvas/oscilloscope.js";
import { renderOverview } from "./views/overview.js";
import { renderStrands } from "./views/strands.js";
import { renderDevices } from "./views/devices.js";
import { ingestConnections, renderConnections } from "./views/flows.js";
import { renderTunnelAndRules } from "./views/tunnel.js";
import { renderSystem } from "./views/system.js";

export function render() {
	renderOverview();
	renderChart();
	renderStrands();
	renderDevices();
	renderConnections(poll);
	renderTunnelAndRules();
	renderSystem();
	if (topo.reduce) drawTopo();
}

export async function poll() {
	try {
		const s = await ubus("braid", "status");
		const fresh = !S.status || s.ts !== S.status.ts;
		S.status = s;

		if (fresh && S.seeded) {
			const d = S.series;
			d.ts.push(s.ts);
			d.total.push(s.rate || 0);
			d.up.push(s.rate_up || 0);
			for (const x of s.strands || []) {
				(d.strands[x.dev] ||= []).push(x.now || 0);
			}
			if (d.ts.length > 720) {
				d.ts.shift();
				d.total.shift();
				d.up.shift();
				for (const k in d.strands) d.strands[k].shift();
			}
		}

		const jobs = [
			ubus("braid", "devices").then((d) => { S.devices = d.devices || []; }),
		];
		if (S.page === "tunnel") {
			jobs.push(ubus("braid", "rules").then((d) => { S.rules = d; }));
		}
		if (S.page === "connections" && S.sid !== ANON) {
			jobs.push(
				ubus("braid", "connections")
					.then((d) => ingestConnections(d.connections || []))
					.catch((e) => { if (e.denied) signOut(); })
			);
		}
		await Promise.allSettled(jobs);
		render();
	} catch (e) {
		const pill = $("#health-pill");
		if (pill) {
			pill.className = "bp-badge crimson";
			pill.textContent = "✕ BRAIDD OFFLINE";
		}
	}
}

export async function loadSlow() {
	await Promise.allSettled([
		ubus("braid", "doctor").then((d) => { S.doctor = d; }),
		ubus("braid", "events", { limit: 80 }).then((d) => { S.events = d.events || []; }),
		ubus("braid", "tunnel").then((d) => { S.tunnel = d; }),
		ubus("braid", "rules").then((d) => { S.rules = d; }),
	]);
	render();
}

export async function refreshAll() {
	await poll();
	await loadSlow();
}

function route() {
	const raw = location.hash.replace("#/", "");
	const alias = raw === "rules" ? "tunnel" : raw === "log" ? "system" : raw;
	S.page = PAGES[alias] ? alias : "overview";
	$$(".page").forEach((x) => x.classList.toggle("on", x.dataset.p === S.page));
	$$(".nav-tab").forEach((x) => x.classList.toggle("on", x.dataset.p === S.page));
	render();
	if (S.page === "tunnel" || S.page === "connections") poll();
}

async function bootstrap() {
	registerApiHooks({ render, refreshAll });
	setupTopoEvents();
	bindAuthModal(poll);

	$("#btn-reconcile").onclick = () => write("reconcile", {});
	$("#btn-relogin-strands").onclick = () => write("relogin", {});
	$("#btn-sys-relogin").onclick = () => write("relogin", {});
	$("#btn-sys-reconcile").onclick = () => write("reconcile", {});
	$("#conn-q").oninput = () => renderConnections(poll);

	addEventListener("hashchange", route);
	addEventListener("resize", () => {
		renderChart();
		if (topo.reduce) drawTopo();
	});
	addEventListener("keydown", (e) => {
		if (e.key === "Escape") $("#scrim")?.classList.remove("open");
	});

	try {
		const h = await ubus("braid", "series", { limit: 720 });
		S.series = {
			ts: h.ts || [],
			total: h.total || [],
			up: h.up || [],
			strands: h.strands || {},
			strands_up: h.strands_up || {},
		};
		S.interval = h.interval || 2;
	} catch (e) {
		S.interval = 2;
	}

	S.seeded = true;
	route();
	await refreshAll();
	startPrismLoop();

	setInterval(poll, Math.max(2, S.interval) * 1000);
	setInterval(loadSlow, 12000);
}

bootstrap();
