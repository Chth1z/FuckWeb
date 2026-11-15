/* ============================================================================
 * PRISM 5.0 — View 02: Kernel Packet Routing Blueprint & Data-Driven Light Flow
 * ============================================================================ */

import { S, LOCKED_SPECS, EDITABLE_SPECS, fmtRate } from '../state.js?v=503';
import { $, $$, el, renderSegMeter, renderSessionLog } from '../dom.js?v=503';
import { write, call } from '../api.js?v=503';

let drawerOpen = false;
let rafId = null;
let lastFrameTs = 0;

// Real delta rule traffic snapshot for packet-flow velocity calculation
let prevRuleSample = null;
const liveFlow = {
  totPkts: 0,
  vipBps: 0,
  tunBps: 0,
  domBps: 0,
  tunPkts: 0,
  domPkts: 0,
  tunShare: 0
};

// Continuous phase state for the 3 data-plane optical paths [0: VIP, 1: TW-HOME, 2: Harvest]
const branchState = [
  { phase: 0.10, vel: 0.12, targetVel: 0.12, opacity: 0.35, targetOpacity: 0.35, railOp: 0.25 },
  { phase: 0.42, vel: 0.16, targetVel: 0.16, opacity: 0.35, targetOpacity: 0.35, railOp: 0.25 },
  { phase: 0.74, vel: 0.18, targetVel: 0.18, opacity: 0.35, targetOpacity: 0.35, railOp: 0.25 }
];

function buildPoly(points) {
  const segs = [];
  let totalLen = 0;
  for (let i = 0; i < points.length - 1; i++) {
    const [x0, y0] = points[i];
    const [x1, y1] = points[i + 1];
    const len = Math.hypot(x1 - x0, y1 - y0);
    const deg = Math.atan2(y1 - y0, x1 - x0) * 180 / Math.PI;
    segs.push({ x0, y0, x1, y1, len, deg, start: totalLen });
    totalLen += len;
  }
  return { segs, totalLen };
}

const POLY_PATHS = {
  f0: buildPoly([[450, 0], [450, 24], [146, 24], [146, 54]]),
  f1: buildPoly([[450, 0], [450, 54]]),
  f2: buildPoly([[450, 0], [450, 24], [754, 24], [754, 54]]),
  m0: buildPoly([[146, 0], [146, 28], [450, 28], [450, 54]]),
  m1: buildPoly([[450, 0], [450, 54]]),
  m2: buildPoly([[754, 0], [754, 28], [450, 28], [450, 54]])
};

function samplePoly(poly, tNorm) {
  const dist = ((tNorm % 1) + 1) % 1 * poly.totalLen;
  for (let i = 0; i < poly.segs.length; i++) {
    const s = poly.segs[i];
    if (dist <= s.start + s.len || i === poly.segs.length - 1) {
      const u = s.len > 0 ? Math.min(1, Math.max(0, (dist - s.start) / s.len)) : 0;
      return {
        x: s.x0 + (s.x1 - s.x0) * u,
        y: s.y0 + (s.y1 - s.y0) * u,
        deg: s.deg
      };
    }
  }
  const last = poly.segs[poly.segs.length - 1];
  return { x: last.x1, y: last.y1, deg: last.deg };
}

function setPhotonPose(elNode, poly, phase, opacity) {
  if (!elNode) return;
  if (opacity <= 0.02) {
    elNode.setAttribute('opacity', '0');
    return;
  }
  // Fade smoothly in at t=[0..0.1] and out at t=[0.9..1.0] so streaks enter/exit boxes cleanly
  const edgeFade = phase < 0.1 ? phase / 0.1 : (phase > 0.9 ? (1 - phase) / 0.1 : 1);
  const { x, y, deg } = samplePoly(poly, phase);
  elNode.setAttribute('transform', `translate(${x.toFixed(1)},${y.toFixed(1)}) rotate(${deg.toFixed(1)})`);
  elNode.setAttribute('opacity', (opacity * edgeFade).toFixed(2));
}

function stepAnimation(now) {
  if (S.tab !== 'blueprint' || document.visibilityState === 'hidden') {
    rafId = null;
    lastFrameTs = 0;
    return;
  }

  const dt = lastFrameTs ? Math.min(0.08, (now - lastFrameTs) / 1000) : 0.016;
  lastFrameTs = now;

  for (let k = 0; k < 3; k++) {
    const b = branchState[k];
    b.vel += (b.targetVel - b.vel) * 0.12;
    b.opacity += (b.targetOpacity - b.opacity) * 0.12;
    b.phase = (b.phase + b.vel * dt) % 1;

    const pA = b.phase;
    const pB = (b.phase + 0.5) % 1;

    setPhotonPose($(`#ph-f${k}a`), POLY_PATHS[`f${k}`], pA, b.opacity);
    setPhotonPose($(`#ph-f${k}b`), POLY_PATHS[`f${k}`], pB, b.opacity * 0.72);

    // Merge rail continues after short phase lag behind sub-node processing
    const mA = (b.phase + 0.18) % 1;
    const mB = (b.phase + 0.68) % 1;
    setPhotonPose($(`#ph-m${k}a`), POLY_PATHS[`m${k}`], mA, b.opacity);
    setPhotonPose($(`#ph-m${k}b`), POLY_PATHS[`m${k}`], mB, b.opacity * 0.72);
  }

  rafId = requestAnimationFrame(stepAnimation);
}

export function startBlueprintAnim() {
  if (S.tab !== 'blueprint' || document.visibilityState === 'hidden') return;
  if (!rafId) {
    lastFrameTs = 0;
    rafId = requestAnimationFrame(stepAnimation);
  }
}

export function stopBlueprintAnim() {
  if (rafId) {
    cancelAnimationFrame(rafId);
    rafId = null;
    lastFrameTs = 0;
  }
}

function updateFlowPhysics(st) {
  const totalRate = (st.rate || 0) + (st.rate_up || 0);
  const vipS = (st.strands || []).find(s => s.vip);
  const vipBps = vipS ? ((vipS.now ?? vipS.rate ?? 0) + (vipS.up_now ?? vipS.up ?? 0)) : 0;

  const rules = S.rules?.rules || [];
  let totPkts = 0, tunPkts = 0, domPkts = 0, tunBytes = 0, domBytes = 0;
  for (const r of rules) {
    const p = r.packets || 0;
    const b = r.bytes || 0;
    totPkts += p;
    if (r.tag.includes('tunnel') || r.tag === 'rest-tunnel') {
      tunPkts += p;
      tunBytes += b;
    } else if (r.tag === 'domestic' || r.tag === 'device-direct' || r.tag === 'rest-direct') {
      domPkts += p;
      domBytes += b;
    }
  }

  const nowMs = performance.now();
  if (rules.length > 0) {
    if (prevRuleSample && (nowMs - prevRuleSample.ts) >= 400 && tunBytes >= prevRuleSample.tunBytes) {
      const dtSec = (nowMs - prevRuleSample.ts) / 1000;
      liveFlow.tunBps = (tunBytes - prevRuleSample.tunBytes) / dtSec;
      liveFlow.domBps = Math.max(0, (domBytes - prevRuleSample.domBytes) / dtSec);
    } else if (!prevRuleSample && totPkts > 0) {
      const share = tunPkts / totPkts;
      liveFlow.tunBps = Math.max(0, totalRate - vipBps) * share;
      liveFlow.domBps = Math.max(0, totalRate - vipBps) * (1 - share);
    }
    if (!prevRuleSample || (nowMs - prevRuleSample.ts) >= 400 || tunBytes < prevRuleSample.tunBytes) {
      prevRuleSample = { ts: nowMs, tunBytes, domBytes };
    }
  }

  liveFlow.vipBps = vipBps;
  liveFlow.totPkts = totPkts;
  liveFlow.tunPkts = tunPkts;
  liveFlow.domPkts = domPkts;
  liveFlow.tunShare = totPkts > 0 ? tunPkts / totPkts : 0;

  const weaveBps = Math.max(liveFlow.domBps, Math.max(0, totalRate - vipBps));
  const rates = [
    vipS && vipS.healthy ? vipBps : -1,
    st.tunnel?.on && st.tunnel?.running ? liveFlow.tunBps : -1,
    st.healthy_count > 0 ? weaveBps : -1
  ];

  for (let k = 0; k < 3; k++) {
    const bps = rates[k];
    const b = branchState[k];
    if (bps < 0) {
      b.targetVel = 0;
      b.targetOpacity = 0;
      b.railOp = 0.12;
    } else {
      const mbps = (bps * 8) / 1e6;
      if (mbps < 0.01) {
        // Alive idle standby trickle (~12s slow optical heartbeat)
        b.targetVel = 0.08;
        b.targetOpacity = 0.24;
        b.railOp = 0.22;
      } else {
        b.targetVel = Math.min(2.4, 0.28 + Math.log10(1 + mbps * 12) * 0.65);
        b.targetOpacity = Math.min(1.0, 0.56 + Math.log10(1 + mbps * 4) * 0.30);
        b.railOp = Math.min(0.82, 0.30 + Math.log10(1 + mbps * 4) * 0.28);
      }
    }
    const rf = $(`#rail-f${k}`);
    const rm = $(`#rail-m${k}`);
    if (rf) rf.style.opacity = b.railOp.toFixed(2);
    if (rm) rm.style.opacity = b.railOp.toFixed(2);
  }
}

export function bindBlueprintEvents() {
  $$('#site-mode-seg .seg-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      write('configure', { set: { 'strands.aggregate': btn.dataset.mode } }, `聚匯模式已設為 ${btn.dataset.mode}`);
    });
  });

  $('#site-mem-btn')?.addEventListener('click', () => {
    const st = S.status;
    if (!st) return;
    if (st.site?.known) {
      write('forget', {}, '已從配置忘記此站點');
    } else {
      const name = prompt('請輸入站點名稱 (如: IHG 酒店)', st.site?.name || 'site');
      if (name != null) {
        write('remember', { name: name.trim() || 'site', aggregate: true, portal: st.site?.portal || '' }, `已記住站點「${name.trim() || 'site'}」並開啟聚匯`);
      }
    }
  });

  $('#btn-toggle-sys')?.addEventListener('click', async () => {
    drawerOpen = !drawerOpen;
    const drw = $('#bp-sys-drawer');
    const btn = $('#btn-toggle-sys');
    if (drw) drw.style.display = drawerOpen ? 'flex' : 'none';
    if (btn) btn.textContent = drawerOpen ? '收起體檢與 UCI ▴' : '體檢與 UCI 參數 ▾';
    if (drawerOpen) {
      if (S.session && !S.config) {
        try { S.config = await call('config'); } catch (_) {}
      }
      renderBlueprintDrawer();
    }
  });
}

export function renderBlueprint() {
  const st = S.status;
  if (!st) return;

  updateFlowPhysics(st);
  startBlueprintAnim();

  const w = st.weave || {};
  const tun = S.tunnel;
  const nH = Math.max(1, st.healthy_count || st.strand_count || 21);
  const totalRate = (st.rate || 0) + (st.rate_up || 0);

  // Left Guard Advisor Column
  const canaryMs = st.tunnel?.canary_ms || 0;
  $('#adv-verdict').textContent = st.ok ? 'zero-leak verified' : (st.fail?.join(', ') || 'check failed');
  $('#adv-verdict').className = st.ok ? 'c-mint' : 'c-crimson';
  $('#adv-canary').textContent = canaryMs > 0 ? `${canaryMs} ms` : (st.tunnel?.on ? 'active' : 'off');
  $('#adv-ct').textContent = `${st.sys?.conntrack?.count ?? 0}`;
  $('#adv-strands').textContent = `${st.healthy_count ?? 0}/${st.strand_count ?? 21}`;

  const dnsEl = $('#adv-dns');
  if (dnsEl) {
    dnsEl.textContent = st.dns?.smartdns ? `53 → ${st.dns.port || 6053}` : 'offline';
    dnsEl.className = st.dns?.smartdns ? 'c-mint' : 'c-crimson';
  }
  $('#adv-doctor').textContent = st.ok
    ? `all ${S.doctor?.checks?.length || 24} invariants ok`
    : `${st.fail?.length || 1} fail · ${st.warn?.length || 0} warn`;

  // Top Ingress & Classify Gate
  $('#bp-ingress-rate').textContent = fmtRate(totalRate).full;
  const chargedRatio = (w.charged_count || 0) / nH;
  renderSegMeter($('#bp-harvest-meter'), chargedRatio, 10, 'amber');
  $('#bp-harvest-txt').textContent = `${w.policy || 'harvest'} (${Math.round(chargedRatio * 100)}% ready)`;

  const curMode = st.settings?.['strands.aggregate'] || st.site?.mode || 'auto';
  $$('#site-mode-seg .seg-btn').forEach(b => b.classList.toggle('on', b.dataset.mode === curMode));

  const memBtn = $('#site-mem-btn');
  if (memBtn) {
    if (!st.site?.gateway) {
      memBtn.disabled = true;
      memBtn.textContent = '無上聯網關 MAC';
    } else if (st.site?.known) {
      memBtn.disabled = false;
      memBtn.textContent = `忘記: ${st.site.name}`;
    } else {
      memBtn.disabled = false;
      memBtn.textContent = '記住並聚匯';
    }
  }

  $('#bp-dns-st').textContent = `SmartDNS :${st.dns?.port || 6053} · tunnel4_dns: ${S.rules?.sizes?.tunnel4_dns ?? 0} ips · domestic4: ${S.rules?.sizes?.domestic4 ?? 0} nets`;
  $('#bp-ingress-pkts').textContent = `classify pkts: ${(liveFlow.totPkts / 1000).toFixed(1)}k`;

  // Branch 0: @vip_lane
  const vipS = (st.strands || []).find(s => s.vip);
  $('#bp-vip-rate').textContent = vipS ? fmtRate(liveFlow.vipBps).full : '0 bps';
  const vipTok = vipS ? (vipS.tokens_pct ?? 100) / 100 : 0;
  renderSegMeter($('#bp-vip-meter'), vipTok, 10, 'blue');
  $('#bp-vip-pct').textContent = vipS ? `${Math.round(vipTok * 100)}%` : 'none';
  $('#bp-vip-desc').textContent = vipS
    ? `${vipS.dev} · τ=${vipS.ttfb_ms || '—'}ms · ↓${fmtRate(vipS.now ?? vipS.rate).full}`
    : 'auto selecting lowest RTT strand...';
  $('#bp-vip-st').textContent = vipS && vipS.healthy ? 'dedicated lane pinned' : 'standby';

  // Branch 1: TW-HOME Mihomo TProxy
  const mihomoOk = !!st.tunnel?.running;
  $('#bp-tun-rate').textContent = mihomoOk ? fmtRate(liveFlow.tunBps).full : '0 bps';
  renderSegMeter($('#bp-tun-meter'), mihomoOk ? Math.max(0.08, liveFlow.tunShare) : 0, 10, mihomoOk ? 'violet' : 'amber');
  $('#bp-tun-pct').textContent = mihomoOk ? `${Math.round(liveFlow.tunShare * 100)}%` : '0%';
  $('#bp-tun-desc').textContent = `${(tun?.tw_home || tun?.selected || 'TW-HOME').slice(0, 26)} · ${(liveFlow.tunPkts / 1000).toFixed(1)}k pkts`;
  $('#bp-tun-st').textContent = mihomoOk ? (canaryMs > 0 ? `canary ${canaryMs} ms ok` : 'cage encrypted') : 'offline / direct';

  // Branch 2: Domestic Direct & 21-Strand Burst-Harvest Weave
  const directShare = Math.max(0, 1 - liveFlow.tunShare);
  const weaveRate = Math.max(liveFlow.domBps, Math.max(0, totalRate - liveFlow.vipBps));
  $('#bp-dom-rate').textContent = fmtRate(weaveRate).full;
  renderSegMeter($('#bp-dom-meter'), chargedRatio, 10, 'mint');
  $('#bp-dom-pct').textContent = `${w.charged_count ?? 0}/${nH}`;
  $('#bp-dom-desc').textContent = `slots ${w.slots ?? 126} (${w.affinity || 'flow'}) · direct ${(liveFlow.domPkts / 1000).toFixed(1)}k (${Math.round(directShare * 100)}%)`;
  $('#bp-dom-st').textContent = `${w.draining_count ?? 0} draining · ${(w.cooling_count || 0) + (w.depleted_count || 0)} cooling`;

  // Bottom QoS & Verify Box + Session Log
  $('#bp-verify-summary').textContent = st.ok
    ? `上次調諧正常 · 可用內存 ${Math.round((st.sys?.mem_available_kb || 0) / 1024)} MB · load ${st.sys?.load1 ?? 0}`
    : `異常項目: ${(st.fail || []).join(', ')}`;

  renderSessionLog($('#ov-session-log'), S.events?.events || [], 6);

  if (drawerOpen) renderBlueprintDrawer();
}

export function renderBlueprintDrawer() {
  const doc = S.doctor;
  const dl = $('#doctor-list');
  if (doc && dl) {
    $('#doctor-cap').textContent = doc.ok ? `OK (${doc.checks.length} checks)` : `${doc.fail.length} FAIL / ${doc.warn.length} WARN`;
    const sig = doc.checks.map(c => `${c.id}:${c.ok}:${c.detail}`).join('|');
    if (dl.dataset.sig !== sig) {
      dl.dataset.sig = sig;
      dl.innerHTML = '';
      for (const c of doc.checks) {
        const cls = c.ok ? '' : (c.level === 'fail' ? 'bad' : 'warn');
        dl.appendChild(el('div', { class: `doc-item ${cls}` },
          el('span', { class: c.ok ? 'c-primary' : (c.level === 'fail' ? 'c-crimson' : 'c-amber') }, c.id),
          el('span', { class: c.ok ? 'c-mint' : 'c-crimson' }, c.ok ? (c.detail || 'OK') : (c.detail || c.level.toUpperCase()))
        ));
      }
    }
  }

  const lp = $('#locked-panel');
  if (lp && !lp.dataset.built) {
    lp.dataset.built = '1';
    lp.innerHTML = '';
    for (const [k, val, desc] of LOCKED_SPECS) {
      lp.appendChild(el('div', { class: 'cfg-row' },
        el('div', {},
          el('div', { class: 'c-bright' }, k),
          el('div', { class: 'c-muted', style: { fontSize: '11px' } }, desc)
        ),
        el('span', { class: 'st-badge draining' }, `LOCKED · ${val}`)
      ));
    }
  }

  const cp = $('#config-panel');
  if (!cp) return;
  if (!S.session) {
    cp.innerHTML = '';
    cp.appendChild(el('div', { class: 'c-muted', style: { padding: '12px 0' } }, '需點擊右上角「管理登入」以修改 UCI 可調參數'));
    return;
  }
  const vals = S.config?.values || S.status?.settings || {};
  const sig = EDITABLE_SPECS.map(s => `${s.key}=${vals[s.key]}`).join('|');
  if (cp.dataset.sig === sig) return;
  cp.dataset.sig = sig;
  cp.innerHTML = '';
  for (const spec of EDITABLE_SPECS) {
    const v = vals[spec.key];
    let control;
    if (spec.type === 'bool') {
      control = el('button', {
        class: `btn-cmd ${v ? 'primary' : ''}`,
        onClick: () => write('configure', { set: { [spec.key]: v ? 0 : 1 } }, `${spec.label}已切換`)
      }, v ? '已開啟 (1)' : '已關閉 (0)');
    } else {
      const inp = el('input', {
        class: 'bp-input',
        type: 'number',
        min: spec.min,
        max: spec.max,
        value: v ?? '',
        style: { width: '90px', textAlign: 'right' }
      });
      const save = el('button', {
        class: 'btn-cmd',
        onClick: () => write('configure', { set: { [spec.key]: Number(inp.value) } }, `${spec.key} = ${inp.value}`)
      }, '套用');
      control = el('div', { style: { display: 'flex', gap: '6px' } }, inp, save);
    }
    cp.appendChild(el('div', { class: 'cfg-row' },
      el('div', {},
        el('div', { class: 'c-bright' }, spec.key),
        el('div', { class: 'c-muted', style: { fontSize: '11px' } }, spec.label)
      ),
      control
    ));
  }
}
