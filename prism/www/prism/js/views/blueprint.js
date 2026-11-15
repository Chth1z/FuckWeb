/* ============================================================================
 * PRISM — View 02: Kernel Routing Architecture, Proportional Classify & Ribbons
 * ============================================================================ */

import { S, LOCKED_SPECS, EDITABLE_SPECS, spectralColor, fmtRate } from '../state.js?v=5.3.0';
import { $, $$, el, renderSegMeter, renderSessionLog } from '../dom.js?v=5.3.0';
import { write, call } from '../api.js?v=5.3.0';

let drawerOpen = false;
let rafId = null;
let lastFrameTs = 0;

let prevRuleSample = null;
const liveFlow = {
  totPkts: 0,
  quicPkts: 0,
  vipBps: 0,
  tunBps: 0,
  domBps: 0,
  tunPkts: 0,
  domPkts: 0,
  tunShare: 0
};

const RULE_LABELS = {
  'device-block': '設備禁網',
  'relay': '中繼直連',
  'quic': 'QUIC攔截',
  'device-direct': '設備直連',
  'device-tunnel': '設備隧道',
  'device-game': '遊戲專線',
  'tunnel-range': '強制IP段',
  'tunnel-domain': 'SmartDNS釘選',
  'domestic': '國內直連',
  'domestic-domain': 'SmartDNS國內',
  'tunnel-port': '海外UDP端口',
  'rest-tunnel': '其餘→TW-HOME',
  'rest-direct': '其餘→直連'
};

// Normalized 0..1 wave phase & energy: 0=vip, 1=tw-home, 2=harvest, 3=weave_out, 4=ingress/uplink
const waveState = [
  { phase: 0.08, vel: 0.22, targetVel: 0.22, glow: 0.42, targetGlow: 0.42, width: 2.3 },
  { phase: 0.36, vel: 0.28, targetVel: 0.28, glow: 0.46, targetGlow: 0.46, width: 2.5 },
  { phase: 0.64, vel: 0.34, targetVel: 0.34, glow: 0.52, targetGlow: 0.52, width: 2.6 },
  { phase: 0.18, vel: 0.42, targetVel: 0.42, glow: 0.46, targetGlow: 0.46, width: 2.1 },
  { phase: 0.52, vel: 0.30, targetVel: 0.30, glow: 0.46, targetGlow: 0.46, width: 2.3 }
];

function relBox(elNode, rootRect) {
  if (!elNode) return null;
  const r = elNode.getBoundingClientRect();
  return {
    x: r.left - rootRect.left,
    y: r.top - rootRect.top,
    w: r.width,
    h: r.height,
    cx: r.left - rootRect.left + r.width * 0.5,
    cy: r.top - rootRect.top + r.height * 0.5,
    right: r.right - rootRect.left,
    bottom: r.bottom - rootRect.top
  };
}

function buildPathMetrics(pts) {
  const segs = [];
  let total = 0;
  for (let i = 0; i < pts.length - 1; i++) {
    const a = pts[i];
    const b = pts[i + 1];
    const len = Math.hypot(b.x - a.x, b.y - a.y);
    if (len > 0.5) {
      segs.push({ x1: a.x, y1: a.y, x2: b.x, y2: b.y, len, acc: total });
      total += len;
    }
  }
  return { pts, segs, total: Math.max(1, total) };
}

function samplePointAt(metrics, dist) {
  const d = Math.max(0, Math.min(metrics.total, dist));
  for (const s of metrics.segs) {
    if (d <= s.acc + s.len + 0.01) {
      const t = (d - s.acc) / Math.max(0.001, s.len);
      return {
        x: s.x1 + (s.x2 - s.x1) * t,
        y: s.y1 + (s.y2 - s.y1) * t
      };
    }
  }
  const last = metrics.pts[metrics.pts.length - 1];
  return { x: last.x, y: last.y };
}

// Trace rounded polyline with clamped arcTo so tight corners never fold or clip
function traceRoundedPolyline(ctx, pts, radius = 9) {
  if (pts.length < 2) return;
  ctx.beginPath();
  ctx.moveTo(pts[0].x, pts[0].y);
  for (let i = 1; i < pts.length - 1; i++) {
    const prev = pts[i - 1];
    const cur = pts[i];
    const next = pts[i + 1];
    const d1 = Math.hypot(cur.x - prev.x, cur.y - prev.y);
    const d2 = Math.hypot(next.x - cur.x, next.y - cur.y);
    const r = Math.min(radius, d1 * 0.42, d2 * 0.42);
    if (r >= 1.5) ctx.arcTo(cur.x, cur.y, next.x, next.y, r);
    else ctx.lineTo(cur.x, cur.y);
  }
  const last = pts[pts.length - 1];
  ctx.lineTo(last.x, last.y);
}

// Extract one unbroken contiguous polyline for [dStart, dEnd] so ONE stroke renders ZERO beads
function extractSubpathPoints(metrics, dStart, dEnd) {
  const a = Math.max(0, dStart);
  const b = Math.min(metrics.total, dEnd);
  if (b - a < 2) return null;

  const out = [samplePointAt(metrics, a)];
  for (let i = 0; i < metrics.segs.length - 1; i++) {
    const vDist = metrics.segs[i].acc + metrics.segs[i].len;
    if (vDist > a + 0.8 && vDist < b - 0.8) {
      out.push({ x: metrics.segs[i].x2, y: metrics.segs[i].y2 });
    }
  }
  out.push(samplePointAt(metrics, b));
  return out;
}

// True Seamless Gradient Light-Ribbon (Single Continuous Stroke per Pass = Zero Dots!)
function drawContinuousLightRibbon(ctx, pts, rgb, st, phaseOffset = 0, withArrow = false) {
  if (!pts || pts.length < 2) return;
  const metrics = buildPathMetrics(pts);

  ctx.save();
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';

  // 1. Subtle structural conduit guide + soft resting luminance
  traceRoundedPolyline(ctx, pts, 9);
  ctx.strokeStyle = 'rgba(18, 25, 42, 0.90)';
  ctx.lineWidth = 2.4;
  ctx.stroke();

  ctx.globalCompositeOperation = 'lighter';
  traceRoundedPolyline(ctx, pts, 9);
  ctx.strokeStyle = `rgba(${rgb}, ${(0.12 + st.glow * 0.14).toFixed(3)})`;
  ctx.lineWidth = st.width * 2.4;
  ctx.stroke();

  traceRoundedPolyline(ctx, pts, 9);
  ctx.strokeStyle = `rgba(${rgb}, ${(0.28 + st.glow * 0.24).toFixed(3)})`;
  ctx.lineWidth = 1.4;
  ctx.stroke();

  // 2. Continuous Traveling Gradient Light-Bands (Bright Luminous Center -> Smooth Taper)
  if (st.vel > 0.01 && st.glow > 0.05) {
    const ribbonSpan = metrics.total * 0.44;
    for (let k = 0; k < 2; k++) {
      const norm = (st.phase + phaseOffset + k * 0.50) % 1.0;
      const centerDist = norm * (metrics.total + ribbonSpan) - ribbonSpan * 0.5;
      const subPts = extractSubpathPoints(metrics, centerDist - ribbonSpan * 0.5, centerDist + ribbonSpan * 0.5);
      if (!subPts || subPts.length < 2) continue;

      const pA = subPts[0];
      const pB = subPts[subPts.length - 1];
      if (Math.hypot(pB.x - pA.x, pB.y - pA.y) < 2) continue;

      // Single continuous Halo pass (broad feathered aura)
      const haloGrad = ctx.createLinearGradient(pA.x, pA.y, pB.x, pB.y);
      haloGrad.addColorStop(0.00, `rgba(${rgb}, 0)`);
      haloGrad.addColorStop(0.28, `rgba(${rgb}, ${(st.glow * 0.28).toFixed(3)})`);
      haloGrad.addColorStop(0.50, `rgba(${rgb}, ${(st.glow * 0.42).toFixed(3)})`);
      haloGrad.addColorStop(0.72, `rgba(${rgb}, ${(st.glow * 0.28).toFixed(3)})`);
      haloGrad.addColorStop(1.00, `rgba(${rgb}, 0)`);

      traceRoundedPolyline(ctx, subPts, 9);
      ctx.strokeStyle = haloGrad;
      ctx.lineWidth = st.width * 4.4;
      ctx.stroke();

      // Single continuous Core + White Optical Crest pass (seamless bright center)
      const coreGrad = ctx.createLinearGradient(pA.x, pA.y, pB.x, pB.y);
      coreGrad.addColorStop(0.00, `rgba(${rgb}, 0)`);
      coreGrad.addColorStop(0.24, `rgba(${rgb}, ${(st.glow * 0.72).toFixed(3)})`);
      coreGrad.addColorStop(0.50, `rgba(255, 255, 255, ${Math.min(0.96, 0.45 + st.glow * 0.55).toFixed(3)})`);
      coreGrad.addColorStop(0.76, `rgba(${rgb}, ${(st.glow * 0.72).toFixed(3)})`);
      coreGrad.addColorStop(1.00, `rgba(${rgb}, 0)`);

      traceRoundedPolyline(ctx, subPts, 9);
      ctx.shadowColor = `rgba(${rgb}, 0.75)`;
      ctx.shadowBlur = 9;
      ctx.strokeStyle = coreGrad;
      ctx.lineWidth = st.width * 1.4;
      ctx.stroke();
      ctx.shadowBlur = 0;
    }
  }

  // Optional directional arrowhead chevron at endpoint
  if (withArrow && pts.length >= 2) {
    const pPrev = pts[pts.length - 2];
    const pEnd = pts[pts.length - 1];
    const dx = pEnd.x - pPrev.x;
    const dy = pEnd.y - pPrev.y;
    const len = Math.hypot(dx, dy) || 1;
    const ux = dx / len, uy = dy / len;
    const px = -uy, py = ux;
    ctx.fillStyle = `rgba(${rgb}, ${Math.min(0.95, 0.48 + st.glow * 0.48).toFixed(2)})`;
    ctx.beginPath();
    ctx.moveTo(pEnd.x, pEnd.y);
    ctx.lineTo(pEnd.x - ux * 6 + px * 3.5, pEnd.y - uy * 6 + py * 3.5);
    ctx.lineTo(pEnd.x - ux * 6 - px * 3.5, pEnd.y - uy * 6 - py * 3.5);
    ctx.closePath();
    ctx.fill();
  }

  ctx.restore();
}

function renderWaveguidesCanvas() {
  const pipe = $('#bp-pipeline');
  const canvas = $('#bp-flow-canvas');
  if (!pipe || !canvas) return;

  const rect = pipe.getBoundingClientRect();
  if (rect.width < 40 || rect.height < 40) return;

  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const cw = Math.round(rect.width * dpr);
  const ch = Math.round(rect.height * dpr);
  if (canvas.width !== cw || canvas.height !== ch) {
    canvas.width = cw;
    canvas.height = ch;
  }

  const pre = relBox($('#bp-card-pregate'), rect);
  const ing = relBox($('#bp-card-ingress'), rect);
  const vip = relBox($('#bp-card-vip'), rect);
  const tun = relBox($('#bp-card-tun'), rect);
  const dom = relBox($('#bp-card-dom'), rect);
  const qos = relBox($('#bp-card-qos'), rect);
  const up  = relBox($('#bp-card-uplink'), rect);
  if (!pre || !ing || !vip || !tun || !dom || !qos || !up) return;

  const ctx = canvas.getContext('2d');
  ctx.save();
  ctx.scale(dpr, dpr);
  ctx.clearRect(0, 0, rect.width, rect.height);

  // Tier 1 Horizontal Bridge: Pre-Gate -> Nftables Classify Engine
  if (ing.x - pre.right > 4) {
    const y1 = Math.round(pre.cy);
    drawContinuousLightRibbon(ctx, [{ x: pre.right, y: y1 }, { x: ing.x - 1, y: y1 }], '235, 154, 94', waveState[4], 0.00, true);
  }

  // Fork Tier 1 (Ingress Classify Engine) -> Tier 2 (3 Engines)
  const yFork = Math.round((ing.bottom + vip.y) * 0.5);
  const forkX = Math.round(ing.cx - ing.w * 0.08);
  const pVipTop = [{ x: forkX - 32, y: ing.bottom }, { x: forkX - 32, y: yFork }, { x: vip.cx, y: yFork }, { x: vip.cx, y: vip.y }];
  const pTunTop = [{ x: forkX,      y: ing.bottom }, { x: forkX,      y: yFork }, { x: tun.cx, y: yFork }, { x: tun.cx, y: tun.y }];
  const pDomTop = [{ x: forkX + 32, y: ing.bottom }, { x: forkX + 32, y: yFork }, { x: dom.cx, y: yFork }, { x: dom.cx, y: dom.y }];

  drawContinuousLightRibbon(ctx, pVipTop, '100, 174, 245', waveState[0], 0.00);
  drawContinuousLightRibbon(ctx, pTunTop, '170, 142, 240', waveState[1], 0.14);
  drawContinuousLightRibbon(ctx, pDomTop, '87, 209, 146',  waveState[2], 0.28);

  // Tier 2 Cross-Bridge: TW-HOME -> weave_out -> Burst-Harvest 2.0
  if (dom.x - tun.right > 4) {
    const yBridge = Math.round(tun.cy);
    drawContinuousLightRibbon(ctx, [{ x: tun.right, y: yBridge }, { x: dom.x - 1, y: yBridge }], '170, 142, 240', waveState[3], 0.08, true);
  }

  // Merge Tier 2 -> Tier 3 (3-Band HTB + fq_codel QoS Engine)
  const yMerge = Math.round((vip.bottom + qos.y) * 0.5);
  const qosAnchorX = Math.round(qos.cx + qos.w * 0.08);
  const pVipBot = [{ x: vip.cx, y: vip.bottom }, { x: vip.cx, y: yMerge }, { x: qosAnchorX - 34, y: yMerge }, { x: qosAnchorX - 34, y: qos.y }];
  const pTunBot = [{ x: tun.cx, y: tun.bottom }, { x: tun.cx, y: yMerge }, { x: qosAnchorX,      y: yMerge }, { x: qosAnchorX,      y: qos.y }];
  const pDomBot = [{ x: dom.cx, y: dom.bottom }, { x: dom.cx, y: yMerge }, { x: qosAnchorX + 34, y: yMerge }, { x: qosAnchorX + 34, y: qos.y }];

  drawContinuousLightRibbon(ctx, pVipBot, '100, 174, 245', waveState[0], 0.22);
  drawContinuousLightRibbon(ctx, pTunBot, '170, 142, 240', waveState[1], 0.36);
  drawContinuousLightRibbon(ctx, pDomBot, '87, 209, 146',  waveState[2], 0.50);

  // Tier 3 Horizontal Bridge: 3-Band HTB QoS -> Physical 21-Uplink NAT Dispatch
  if (up.x - qos.right > 4) {
    const y3 = Math.round(qos.cy);
    drawContinuousLightRibbon(ctx, [{ x: qos.right, y: y3 }, { x: up.x - 1, y: y3 }], '240, 202, 104', waveState[4], 0.30, true);
  }

  ctx.restore();
}

function stepAnimation(now) {
  if (S.tab !== 'blueprint' || document.visibilityState === 'hidden') {
    rafId = null;
    lastFrameTs = 0;
    return;
  }

  const dt = lastFrameTs ? Math.min(0.08, (now - lastFrameTs) / 1000) : 0.016;
  lastFrameTs = now;

  for (let k = 0; k < waveState.length; k++) {
    const b = waveState[k];
    b.vel += (b.targetVel - b.vel) * 0.1;
    b.glow += (b.targetGlow - b.glow) * 0.1;
    b.phase = (b.phase + b.vel * dt) % 1.0;
  }

  renderWaveguidesCanvas();
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

export function closeSysModal() {
  drawerOpen = false;
  $('#sys-modal-scrim')?.classList.remove('open');
}

function updateFlowPhysics(st) {
  const totalRate = (st.rate || 0) + (st.rate_up || 0);
  const vipS = (st.strands || []).find(s => s.vip);
  const vipBps = vipS ? ((vipS.now ?? vipS.rate ?? 0) + (vipS.up_now ?? vipS.up ?? 0)) : 0;

  const rules = S.rules?.rules || [];
  let totPkts = 0, quicPkts = 0, tunPkts = 0, domPkts = 0, tunBytes = 0, domBytes = 0;
  for (const r of rules) {
    const p = r.packets || 0;
    const b = r.bytes || 0;
    totPkts += p;
    if (r.tag === 'quic') quicPkts += p;
    if (r.tag.includes('tunnel') || r.tag === 'rest-tunnel') {
      tunPkts += p;
      tunBytes += b;
    } else if (r.tag === 'domestic' || r.tag === 'domestic-domain' || r.tag === 'device-direct' || r.tag === 'rest-direct' || r.tag === 'relay') {
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
  liveFlow.quicPkts = quicPkts;
  liveFlow.tunPkts = tunPkts;
  liveFlow.domPkts = domPkts;
  liveFlow.tunShare = totPkts > 0 ? tunPkts / totPkts : 0;

  const weaveBps = Math.max(liveFlow.domBps, Math.max(0, totalRate - vipBps));
  const rates = [
    vipS && vipS.healthy ? vipBps : -1,
    st.tunnel?.on && st.tunnel?.running ? liveFlow.tunBps : -1,
    st.healthy_count > 0 ? weaveBps : -1,
    st.tunnel?.on && st.tunnel?.running ? liveFlow.tunBps : -1,
    totalRate
  ];

  for (let k = 0; k < waveState.length; k++) {
    const bps = rates[k];
    const b = waveState[k];
    if (bps < 0) {
      b.targetVel = 0;
      b.targetGlow = 0.08;
      b.width = 1.6;
    } else {
      const mbps = (bps * 8) / 1e6;
      if (mbps < 0.01) {
        b.targetVel = 0.24;
        b.targetGlow = 0.42;
        b.width = 2.1;
      } else {
        const logF = Math.log10(1 + mbps * 6);
        b.targetVel = Math.min(1.25, 0.30 + logF * 0.42);
        b.targetGlow = Math.min(1.0, 0.56 + logF * 0.28);
        b.width = Math.min(3.5, 2.2 + logF * 0.65);
      }
    }
  }
}

function renderClassifyStrip() {
  const grid = $('#bp-classify-grid');
  if (!grid) return;
  const rules = S.rules?.rules || [];
  if (!rules.length) {
    grid.innerHTML = '<span class="c-muted" style="font-size:11px">等待 nftables classify 計數...</span>';
    return;
  }

  const tot = Math.max(1, rules.reduce((acc, r) => acc + (r.packets || 0), 0));
  const coreSet = new Set(['quic', 'device-direct', 'tunnel-range', 'domestic', 'rest-tunnel']);
  const visible = rules
    .filter(r => (r.packets || 0) > 0 || coreSet.has(r.tag))
    .sort((a, b) => (b.packets || 0) - (a.packets || 0));

  const frag = document.createDocumentFragment();
  for (const r of visible) {
    const label = RULE_LABELS[r.tag] || r.tag;
    const pkts = r.packets || 0;
    const share = (pkts / tot) * 100;
    const fillPct = pkts > 0 ? Math.min(100, Math.max(6, Math.pow(share / 100, 0.58) * 100)) : 0;

    let colorHex = 'var(--c-mint)';
    let colorRgb = '87, 209, 146';
    let textCls = 'c-mint';
    if (r.tag.includes('tunnel') || r.tag === 'rest-tunnel') {
      colorHex = 'var(--c-violet)';
      colorRgb = '170, 142, 240';
      textCls = 'c-violet';
    } else if (r.tag === 'device-game') {
      colorHex = 'var(--c-blue)';
      colorRgb = '100, 174, 245';
      textCls = 'c-blue';
    } else if (r.tag === 'quic') {
      colorHex = 'var(--c-amber)';
      colorRgb = '235, 154, 94';
      textCls = 'c-amber';
    } else if (r.tag === 'device-block') {
      colorHex = 'var(--c-crimson)';
      colorRgb = '230, 108, 120';
      textCls = 'c-crimson';
    }

    const pktTxt = pkts >= 1000 ? `${(pkts / 1000).toFixed(1)}k` : `${pkts}`;
    const pctTxt = pkts > 0 ? (share >= 1 ? `${Math.round(share)}%` : `${share.toFixed(1)}%`) : '0%';

    const fillEl = el('div', {
      class: 'classify-bar-fill',
      style: {
        width: `${fillPct.toFixed(1)}%`,
        background: colorHex,
        boxShadow: pkts > 0 ? `0 0 10px rgba(${colorRgb}, 0.72), 0 0 22px rgba(${colorRgb}, 0.34)` : 'none'
      }
    });

    frag.appendChild(el('div', {
      class: `classify-bar-card ${pkts > 0 ? 'active' : ''}`,
      style: { '--cb-rgb': colorRgb }
    },
      el('div', { class: 'classify-bar-head' },
        el('span', { class: pkts > 0 ? 'c-bright' : 'c-muted', style: { fontWeight: pkts > 0 ? '600' : '400' } }, label),
        el('span', { class: pkts > 0 ? textCls : 'c-muted', style: { fontVariantNumeric: 'tabular-nums', fontWeight: '600' } }, `${pktTxt} · ${pctTxt}`)
      ),
      el('div', { class: 'classify-bar-track' }, fillEl)
    ));
  }
  grid.innerHTML = '';
  grid.appendChild(frag);
}

function renderMiniSpectrum(strands) {
  const bar = $('#bp-mini-spectrum');
  if (!bar || !strands.length) return;
  if (bar.children.length !== strands.length) {
    bar.innerHTML = '';
    strands.forEach((s, idx) => {
      const col = spectralColor(idx, strands.length);
      bar.appendChild(el('span', {
        class: 'mini-sp-cell',
        style: { backgroundColor: col.css }
      }));
    });
  }
  for (let i = 0; i < strands.length; i++) {
    const s = strands[i];
    const cell = bar.children[i];
    if (!cell) continue;
    const col = spectralColor(i, strands.length);
    if (!s.healthy) {
      cell.style.backgroundColor = 'rgba(230, 108, 120, 0.35)';
      cell.style.boxShadow = 'none';
      cell.style.opacity = '0.45';
    } else {
      cell.style.backgroundColor = col.css;
      const pct = (s.tokens_pct ?? 100) / 100;
      const active = (s.now ?? s.rate ?? 0) > 2000;
      cell.style.opacity = String(0.36 + pct * 0.64);
      cell.style.boxShadow = active ? `0 0 8px ${col.css}` : 'none';
    }
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

  const openSysModal = async () => {
    drawerOpen = true;
    $('#sys-modal-scrim')?.classList.add('open');
    if (S.session && !S.config) {
      try { S.config = await call('config'); } catch (_) {}
    }
    renderBlueprintDrawer();
  };

  $('#btn-toggle-sys')?.addEventListener('click', openSysModal);
  $('#btn-close-sys')?.addEventListener('click', closeSysModal);
  $('#sys-modal-scrim')?.addEventListener('click', (e) => {
    if (e.target.id === 'sys-modal-scrim') closeSysModal();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && drawerOpen) closeSysModal();
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
  const strands = st.strands || [];

  const mptcpBadge = $('#bp-mptcp-badge');
  if (mptcpBadge) {
    const mp = st.mptcp;
    if (mp?.enabled) {
      mptcpBadge.className = 'st-badge charged';
      mptcpBadge.textContent = `MPTCP · ${mp.subflows} subflows · ${mp.endpoints?.length || 0} ep`;
    } else {
      mptcpBadge.className = 'st-badge draining';
      mptcpBadge.textContent = 'MPTCP · standby';
    }
  }

  // Left Guard Rail
  const canaryMs = st.tunnel?.canary_ms || 0;
  $('#adv-verdict').textContent = st.ok ? 'zero-leak verified' : (st.fail?.join(', ') || 'check failed');
  $('#adv-verdict').className = `v ${st.ok ? 'c-mint' : 'c-crimson'}`;
  $('#adv-canary').textContent = canaryMs > 0 ? `${canaryMs} ms` : (st.tunnel?.on ? 'active' : 'off');
  $('#adv-ct').textContent = `${st.sys?.conntrack?.count ?? 0}`;
  $('#adv-strands').textContent = `${st.healthy_count ?? 0}/${st.strand_count ?? 21}`;

  const dnsEl = $('#adv-dns');
  if (dnsEl) {
    dnsEl.textContent = st.dns?.smartdns ? `53 → ${st.dns.port || 6053}` : 'offline';
    dnsEl.className = `v ${st.dns?.smartdns ? 'c-mint' : 'c-crimson'}`;
  }
  $('#adv-doctor').textContent = st.ok
    ? `all ${S.doctor?.checks?.length || 41} invariants ok`
    : `${st.fail?.length || 1} fail · ${st.warn?.length || 0} warn`;

  const evList = S.events?.events || [];
  if ($('#log-count')) $('#log-count').textContent = `${evList.length} 條`;
  renderSessionLog($('#ov-session-log'), evList, 35);

  // Tier 1A: Pre-Gate & SmartDNS
  $('#bp-quic-pkts').textContent = liveFlow.quicPkts >= 1000
    ? `${(liveFlow.quicPkts / 1000).toFixed(1)}k pkts`
    : `${liveFlow.quicPkts} pkts`;
  const sz = S.rules?.sizes || {};
  $('#bp-dns-st').textContent = `SmartDNS :${st.dns?.port || 6053} · dom ${sz.domestic4 ?? 0} · cn ${sz.domestic4_dns ?? 0} · tun ${sz.tunnel4_dns ?? 0}`;

  const chargedRatio = (w.charged_count || 0) / nH;
  renderSegMeter($('#bp-harvest-meter'), chargedRatio, 10, 'amber');
  $('#bp-harvest-txt').textContent = `${w.policy || 'harvest'} ${Math.round(chargedRatio * 100)}%`;

  const curMode = st.settings?.['strands.aggregate'] || st.site?.mode || 'auto';
  $$('#site-mode-seg .seg-btn').forEach(b => b.classList.toggle('on', b.dataset.mode === curMode));

  const memBtn = $('#site-mem-btn');
  if (memBtn) {
    if (!st.site?.gateway) {
      memBtn.disabled = true;
      memBtn.textContent = '無網關';
    } else if (st.site?.known) {
      memBtn.disabled = false;
      memBtn.textContent = `忘記: ${st.site.name}`;
    } else {
      memBtn.disabled = false;
      memBtn.textContent = '記住站點';
    }
  }

  // Tier 1B: Nftables Classify Engine
  $('#bp-ingress-rate').textContent = fmtRate(totalRate).full;
  $('#bp-ingress-pkts').textContent = `${(liveFlow.totPkts / 1000).toFixed(1)}k pkts`;
  renderClassifyStrip();

  // Tier 2 · Branch 0: @vip_lane
  const vipS = strands.find(s => s.vip);
  $('#bp-vip-rate').textContent = vipS ? fmtRate(liveFlow.vipBps).full : '0 bps';
  const vipTok = vipS ? (vipS.tokens_pct ?? 100) / 100 : 0;
  renderSegMeter($('#bp-vip-meter'), vipTok, 10, 'blue');
  $('#bp-vip-pct').textContent = vipS ? `${Math.round(vipTok * 100)}%` : 'none';
  $('#bp-vip-desc').textContent = vipS
    ? `${vipS.dev} · τ=${vipS.ttfb_ms || '—'}ms · loss ${vipS.loss_pct ?? 0}%`
    : 'auto selecting lowest RTT strand...';
  $('#bp-vip-st').textContent = vipS && vipS.healthy ? 'dedicated lane pinned' : 'standby';

  // Tier 2 · Branch 1: TW-HOME Mihomo + MPTCP + Zashboard
  const mihomoOk = !!st.tunnel?.running;
  $('#bp-tun-rate').textContent = mihomoOk ? fmtRate(liveFlow.tunBps).full : '0 bps';
  renderSegMeter($('#bp-tun-meter'), mihomoOk ? Math.max(0.08, liveFlow.tunShare) : 0, 10, mihomoOk ? 'violet' : 'amber');
  $('#bp-tun-pct').textContent = mihomoOk ? `${Math.round(liveFlow.tunShare * 100)}%` : '0%';
  $('#bp-tun-desc').textContent = `主力: ${(tun?.tw_home || tun?.selected || 'TW-HOME').slice(0, 24)} · ${(liveFlow.tunPkts / 1000).toFixed(1)}k`;
  const mptcpEl = $('#bp-tun-mptcp');
  if (mptcpEl) {
    mptcpEl.textContent = st.mptcp?.enabled
      ? `MPTCP ${st.mptcp.subflows} subflows → weave_out`
      : 'MPTCP single-path → weave_out';
  }
  $('#bp-tun-st').textContent = mihomoOk ? (canaryMs > 0 ? `canary ${canaryMs} ms ok` : 'cage encrypted') : 'offline / direct';
  const zBtn = $('#zashboard-link');
  if (zBtn) {
    zBtn.href = tun?.dashboard || `http://${st.lan_ip || location.hostname || '192.168.16.1'}:9090/ui/`;
  }

  // Tier 2 · Branch 2: Domestic Direct + Burst-Harvest
  const directShare = Math.max(0, 1 - liveFlow.tunShare);
  const weaveRate = Math.max(liveFlow.domBps, Math.max(0, totalRate - liveFlow.vipBps));
  $('#bp-dom-rate').textContent = fmtRate(weaveRate).full;
  renderSegMeter($('#bp-dom-meter'), chargedRatio, 10, 'mint');
  $('#bp-dom-pct').textContent = `${w.charged_count ?? 0}/${nH}`;
  renderMiniSpectrum(strands);
  $('#bp-dom-desc').textContent = `slots ${w.slots ?? 126} (${w.affinity || 'flow'}) · direct ${(liveFlow.domPkts / 1000).toFixed(1)}k (${Math.round(directShare * 100)}%)`;
  $('#bp-dom-st').textContent = `${w.charged_count ?? 0} charged · ${w.draining_count ?? 0} drain · ${(w.cooling_count || 0) + (w.depleted_count || 0)} cool`;

  // Tier 3: Physical 21-Uplink Summary
  $('#bp-verify-summary').textContent = st.ok
    ? `21/21 鏈路在線 · 內存 ${Math.round((st.sys?.mem_available_kb || 0) / 1024)} MB · load ${st.sys?.load1 ?? 0}`
    : `異常: ${(st.fail || []).join(', ')}`;

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
          el('div', { class: 'c-muted', style: { fontSize: '10.5px' } }, desc)
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
        type: 'button',
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
        type: 'button',
        class: 'btn-cmd',
        onClick: () => write('configure', { set: { [spec.key]: Number(inp.value) } }, `${spec.key} = ${inp.value}`)
      }, '套用');
      control = el('div', { style: { display: 'flex', gap: '6px' } }, inp, save);
    }
    cp.appendChild(el('div', { class: 'cfg-row' },
      el('div', {},
        el('div', { class: 'c-bright' }, spec.key),
        el('div', { class: 'c-muted', style: { fontSize: '10.5px' } }, spec.label)
      ),
      control
    ));
  }
}
