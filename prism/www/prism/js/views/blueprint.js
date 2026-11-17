/* ============================================================================
 * PRISM — View 02: Kernel Routing Architecture, Proportional Classify & Ribbons
 * ============================================================================ */

import { S, UI_VERSION, LOCKED_SPECS, EDITABLE_SPECS, SPECTRUM_STOPS, spectralColor, mixWhiteRgb, desatObsidianRgb, fmtRate, fmtRateCompact, fmtBytes, fmtClock } from '../state.js?v=5.6.6-b10';
import { $, $$, el, renderSegMeter, renderSessionLog, setTxt, setCls, setTitle, setVar, setStyleProp } from '../dom.js?v=5.6.6-b3';
import { write, call } from '../api.js?v=5.6.6-b3';

let drawerOpen = false;
let rafId = null;
let lastFrameTs = 0;

let prevRuleSample = null;
let lastHeatPaintTs = 0;
const liveFlow = {
  totPkts: 0,
  totBytes: 0,
  quicPkts: 0,
  quicBytes: 0,
  vipBps: 0,
  tunBps: 0,
  domBps: 0,
  tunPkts: 0,
  domPkts: 0,
  tunBytes: 0,
  domBytes: 0,
  tunShare: 0
};

// Dynamic optical saturation & glow state per pipeline card (0 = obsidian standby -> 1 = active hotspot)
const moduleHeat = {
  guard:   { id: '#bp-card-guard',   kind: 'mono', rgb: '170, 142, 240', cur: 0.14, target: 0.14 },
  pregate: { id: '#bp-card-pregate', kind: 'spectrum', cur: 0.16, target: 0.16 },
  ingress: { id: '#bp-card-ingress', kind: 'spectrum', cur: 0.18, target: 0.18 },
  vip:     { id: '#bp-card-vip',     kind: 'mono', rgb: '242, 90, 90',  cur: 0.04, target: 0.04 },
  tun:     { id: '#bp-card-tun',     kind: 'mono', rgb: '87, 209, 146',  cur: 0.08, target: 0.08 },
  dom:     { id: '#bp-card-dom',     kind: 'mono', rgb: '100, 174, 245', cur: 0.16, target: 0.16 },
  qos:     { id: '#bp-card-qos',     kind: 'spectrum', cur: 0.14, target: 0.14 },
  uplink:  { id: '#bp-card-uplink',  kind: 'spectrum', cur: 0.18, target: 0.18 }
};

const RULE_LABELS = {
  'device-block': '設備禁網',
  'unverified-drop': 'Mode A 攔截',
  'relay': '中繼直連',
  'quic': 'QUIC 阻斷',
  'device-direct': '設備直連',
  'device-tunnel': '設備入籠',
  'device-game': '極速光道',
  'tunnel-range': '強制IP入籠',
  'tunnel-domain': 'SmartDNS 暗面釘選',
  'domestic': '國內直連',
  'domestic-domain': 'SmartDNS 國內',
  'tunnel-port': '海外 UDP 入籠',
  'rest-tunnel': '餘流歸籠→分流隧道',
  'rest-direct': '餘流→直連'
};

// Normalized 0..1 wave phase & energy: 0=vip, 1=tw-home, 2=harvest, 3=weave_out, 4=ingress/uplink
const waveState = [
  { phase: 0.08, vel: 0.04, targetVel: 0.04, glow: 0.04, targetGlow: 0.04, width: 1.65, targetWidth: 1.65 },
  { phase: 0.36, vel: 0.04, targetVel: 0.04, glow: 0.04, targetGlow: 0.04, width: 1.65, targetWidth: 1.65 },
  { phase: 0.64, vel: 0.04, targetVel: 0.04, glow: 0.04, targetGlow: 0.04, width: 1.65, targetWidth: 1.65 },
  { phase: 0.18, vel: 0.04, targetVel: 0.04, glow: 0.04, targetGlow: 0.04, width: 1.65, targetWidth: 1.65 },
  { phase: 0.52, vel: 0.04, targetVel: 0.04, glow: 0.04, targetGlow: 0.04, width: 1.65, targetWidth: 1.65 }
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

// Drive per-module border saturation and bloom luminance from hotspot intensity (0..1)
function paintModuleHeat(m, h) {
  const node = $(m.id);
  if (!node) return;
  const k = Math.max(0.03, Math.min(1, h));
  const paintKey = `${m.kind}:${m.rgb || ''}:${Math.round(k * 200)}`;
  if (m._lastPaintKey === paintKey) return;
  m._lastPaintKey = paintKey;
  const sat = 0.16 + 0.84 * Math.pow(k, 0.78);
  const bdrA = (0.30 + 0.62 * Math.pow(k, 0.70)).toFixed(3);
  const glowA = (0.02 + 0.28 * Math.pow(k, 1.15)).toFixed(3);
  const bloomA = (0.006 + 0.12 * Math.pow(k, 1.25)).toFixed(3);
  const insetA = (0.01 + 0.08 * Math.pow(k, 1.10)).toFixed(3);
  const blur1 = Math.round(6 + 6 * k);
  const blur2 = Math.round(10 + 4 * k);

  if (m.kind === 'spectrum') {
    const stops = SPECTRUM_STOPS.map((rgb, idx) => {
      const lit = desatObsidianRgb(rgb, sat);
      const pct = Math.round((idx / (SPECTRUM_STOPS.length - 1)) * 100);
      return `rgba(${lit}, ${bdrA}) ${pct}%`;
    });
    const rLit = desatObsidianRgb(SPECTRUM_STOPS[0], sat);
    const gLit = desatObsidianRgb(SPECTRUM_STOPS[3], sat);
    const bLit = desatObsidianRgb(SPECTRUM_STOPS[5], sat);
    const vLit = desatObsidianRgb(SPECTRUM_STOPS[6], sat);
    const sA = (0.025 + 0.21 * Math.pow(k, 1.12)).toFixed(3);
    const vA = (0.018 + 0.16 * Math.pow(k, 1.18)).toFixed(3);
    const rA = (0.04 + 0.075 * Math.pow(k, 0.85)).toFixed(3);
    node.style.setProperty('--bp-spec-grad', `linear-gradient(135deg, ${stops.join(', ')})`);
    node.style.setProperty(
      '--bp-spec-wash',
      `linear-gradient(115deg, rgba(${rLit}, ${rA}) 0%, rgba(${gLit}, ${rA}) 40%, rgba(${bLit}, ${rA}) 72%, rgba(${vLit}, ${rA}) 100%)`
    );
    node.style.setProperty(
      '--bp-card-shadow',
      `-3px 0 ${blur1}px rgba(${rLit}, ${sA}), ` +
      `0 0 ${blur1}px rgba(${gLit}, ${sA}), ` +
      `3px 0 ${blur1}px rgba(${bLit}, ${sA}), ` +
      `5px 0 ${blur2}px rgba(${vLit}, ${vA}), ` +
      `inset 0 0 ${Math.round(8 + 6 * k)}px rgba(255, 255, 255, ${insetA}), ` +
      `0 8px 20px rgba(0, 0, 0, 0.78)`
    );
  } else {
    const lit = desatObsidianRgb(m.rgb, sat);
    const core = k > 0.72 ? mixWhiteRgb(lit, (k - 0.72) * 0.42) : lit;
    const fillA = (0.06 + 0.14 * Math.pow(k, 0.85)).toFixed(3);
    node.style.setProperty('--bp-lit-rgb', lit);
    node.style.setProperty('--bp-fill', fillA);
    node.style.setProperty('--bp-card-border', `rgba(${core}, ${bdrA})`);
    node.style.setProperty(
      '--bp-card-shadow',
      `0 0 ${blur1}px rgba(${lit}, ${glowA}), ` +
      `0 0 ${blur2}px rgba(${lit}, ${bloomA}), ` +
      `inset 0 0 ${Math.round(8 + 8 * k)}px rgba(${lit}, ${insetA}), ` +
      `0 8px 20px rgba(0, 0, 0, 0.78)`
    );
  }
}

function paintAllModuleHeats(snap = false, dt = 0.033) {
  let dirty = false;
  const ease = Math.min(1, 1 - Math.exp(-Math.max(0.004, dt) * 5.8));
  for (const key of Object.keys(moduleHeat)) {
    const m = moduleHeat[key];
    if (snap) {
      m.cur = m.target;
      paintModuleHeat(m, m.cur);
      dirty = true;
    } else if (Math.abs(m.target - m.cur) > 0.003) {
      m.cur += (m.target - m.cur) * ease;
      paintModuleHeat(m, m.cur);
      dirty = true;
    }
  }
  return dirty;
}

function clipHalfPlane(ctx, ax, ay, bx, by, sideSign, W, H) {
  const dx = bx - ax;
  const dy = (by - ay) || 1;
  const yTop = -80;
  const yBot = H + 80;
  const xTop = ax + dx * ((yTop - ay) / dy);
  const xBot = ax + dx * ((yBot - ay) / dy);
  ctx.beginPath();
  if (sideSign < 0) {
    const xFar = Math.min(-80, xTop - 160, xBot - 160);
    ctx.moveTo(xFar, yTop);
    ctx.lineTo(xTop, yTop);
    ctx.lineTo(xBot, yBot);
    ctx.lineTo(xFar, yBot);
  } else {
    const xFar = Math.max(W + 80, xTop + 160, xBot + 160);
    ctx.moveTo(xTop, yTop);
    ctx.lineTo(xFar, yTop);
    ctx.lineTo(xFar, yBot);
    ctx.lineTo(xBot, yBot);
  }
  ctx.closePath();
  ctx.clip();
}

function drawLinkTag(ctx, x, y, text, rgb) {
  ctx.save();
  ctx.font = '600 9.5px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace';
  const tw = ctx.measureText(text).width;
  const bx = x - tw * 0.5 - 5;
  const bw = tw + 10;
  ctx.fillStyle = 'rgba(4, 6, 12, 0.78)';
  ctx.fillRect(bx, y - 7, bw, 14);
  if (rgb === 'spectrum') {
    const g = ctx.createLinearGradient(bx, y, bx + bw, y);
    for (let i = 0; i < 6; i++) g.addColorStop(i / 5, `rgba(${spectralColor(i, 6).rgb}, 0.74)`);
    ctx.strokeStyle = g;
  } else {
    ctx.strokeStyle = `rgba(${rgb}, 0.48)`;
  }
  ctx.lineWidth = 1;
  ctx.strokeRect(bx, y - 7, bw, 14);
  ctx.fillStyle = rgb === 'spectrum'
    ? 'rgba(244, 247, 252, 0.96)'
    : `rgba(${mixWhiteRgb(rgb, 0.40)}, 0.94)`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(text, x, y);
  ctx.restore();
}

// Parallel 21-wavelength spectral ribbon bridge for same-column vertical module links
function drawRefractedVerticalBridge(ctx, topCard, botCard, waveSt, phaseOffset, tagText) {
  const y0 = topCard.bottom - 1;
  const y1 = botCard.y + 1;
  const gap = y1 - y0;
  if (gap <= 10) return;

  const cx = (topCard.cx + botCard.cx) * 0.5;
  const N = 21;
  const halfW = 27;
  const ribbonW = halfW * 2;
  const pitch = ribbonW / N;
  const g = Math.max(0.08, Math.min(1, waveSt?.glow ?? 0.10));
  const sat = 0.25 + 0.75 * g;
  const strands = S.status?.strands;

  ctx.save();

  // Soft Gaussian outer atmospheric halo across the parallel spectrum band
  const auraGrad = ctx.createLinearGradient(cx - halfW - 10, 0, cx + halfW + 10, 0);
  auraGrad.addColorStop(0, `rgba(${spectralColor(0, 7).rgb}, 0)`);
  for (let k = 0; k < 7; k++) {
    const u = 0.14 + (k / 6) * 0.72;
    const tc = desatObsidianRgb(spectralColor(k, 7).rgb, sat);
    auraGrad.addColorStop(u, `rgba(${tc}, ${(0.045 + g * 0.095).toFixed(3)})`);
  }
  auraGrad.addColorStop(1, `rgba(${spectralColor(6, 7).rgb}, 0)`);

  ctx.fillStyle = auraGrad;
  ctx.fillRect(cx - halfW - 10, y0, ribbonW + 20, gap);

  // 21 strictly parallel wavelength filaments (700nm Red left -> 380nm Violet right)
  for (let i = 0; i < N; i++) {
    const sObj = Array.isArray(strands) && strands.length ? strands[i % strands.length] : null;
    const healthy = sObj ? sObj.healthy !== false : true;
    const sRate = sObj ? (Number(sObj.now || sObj.rate || 0) + Number(sObj.up_now || sObj.up || 0)) : 0;
    const sAct = sRate > 0 ? Math.min(1, Math.log10(1 + sRate / 1024) / 3.4) : 0;
    const e = healthy ? Math.min(1, Math.max(0.10, g * 0.40 + sAct * 0.80)) : 0.04;

    const col = spectralColor(i, N);
    const toneRgb = desatObsidianRgb(col.rgb, 0.28 + e * 0.72);
    const xL = cx - halfW + i * pitch;
    const xMid = xL + pitch * 0.5;

    const ribGrad = ctx.createLinearGradient(0, y0, 0, y1);
    ribGrad.addColorStop(0.00, `rgba(${toneRgb}, ${(0.20 + e * 0.56).toFixed(3)})`);
    ribGrad.addColorStop(0.50, `rgba(${toneRgb}, ${(0.14 + e * 0.44).toFixed(3)})`);
    ribGrad.addColorStop(1.00, `rgba(${toneRgb}, ${(0.22 + e * 0.58).toFixed(3)})`);

    ctx.fillStyle = ribGrad;
    ctx.fillRect(xL, y0, pitch + 0.15, gap);

    if (healthy && e > 0.28) {
      ctx.strokeStyle = `rgba(${col.rgb}, ${(e * 0.20).toFixed(3)})`;
      ctx.lineWidth = 2.8 + e * 2.4;
      ctx.beginPath();
      ctx.moveTo(xMid, y0);
      ctx.lineTo(xMid, y1);
      ctx.stroke();
    }

    ctx.strokeStyle = `rgba(${mixWhiteRgb(toneRgb, e * 0.52)}, ${(0.20 + e * 0.68).toFixed(3)})`;
    ctx.lineWidth = healthy ? (0.85 + e * 1.15) : 0.5;
    ctx.beginPath();
    ctx.moveTo(xMid, y0);
    ctx.lineTo(xMid, y1);
    ctx.stroke();

    if (healthy && (e > 0.22 || g > 0.14)) {
      ctx.strokeStyle = makeFlowShimmerGradient(
        ctx, xMid, y0, xMid, y1, waveSt, phaseOffset + i * 0.015,
        mixWhiteRgb(col.rgb, 0.55), 0.22 + e * 0.46
      );
      ctx.lineWidth = 1.0 + e * 1.1;
      ctx.beginPath();
      ctx.moveTo(xMid, y0);
      ctx.lineTo(xMid, y1);
      ctx.stroke();
    }
  }

  ctx.restore();
  if (tagText) drawLinkTag(ctx, cx, (y0 + y1) * 0.5, tagText, 'spectrum');
}

function makeFlowShimmerGradient(ctx, x0, y0, x1, y1, st, phaseOffset, rgb, maxAlpha) {
  const p = (st.phase + phaseOffset) % 1.0;
  const grad = ctx.createLinearGradient(x0, y0, x1, y1);
  for (let i = 0; i <= 6; i++) {
    const u = i / 6;
    const d1 = Math.abs((((u - p) % 1 + 1.5) % 1) - 0.5);
    const wave = Math.exp(-Math.pow(d1 / 0.16, 2));
    grad.addColorStop(u, `rgba(${rgb}, ${Math.min(maxAlpha, wave * st.glow * maxAlpha).toFixed(3)})`);
  }
  return grad;
}

function fillBeamQuad(ctx, x0, y0, x1, y1, nx, ny, halfW, fillStyle) {
  ctx.fillStyle = fillStyle;
  ctx.beginPath();
  ctx.moveTo(x0 - nx * halfW, y0 - ny * halfW);
  ctx.lineTo(x1 - nx * halfW, y1 - ny * halfW);
  ctx.lineTo(x1 + nx * halfW, y1 + ny * halfW);
  ctx.lineTo(x0 + nx * halfW, y0 + ny * halfW);
  ctx.closePath();
  ctx.fill();
}

// Traffic-reactive Fig-5 smooth Gaussian glow + obsidian-weighted saturation (mirrors 03 光譜)
function drawSmoothStraightBeam(ctx, x0, y0, x1, y1, rgb, st, phaseOffset = 0, auraScale = 1) {
  const dx = x1 - x0;
  const dy = y1 - y0;
  const len = Math.hypot(dx, dy);
  if (len < 1.5) return;

  const ux = dx / len;
  const uy = dy / len;
  const nx = -uy;
  const ny = ux;
  const mx = (x0 + x1) * 0.5;
  const my = (y0 + y1) * 0.5;
  const g = Math.max(0, Math.min(1, st.glow));
  const sat = 0.20 + 0.80 * Math.min(1, g * 1.25);
  const active = st.vel > 0.05 && g > 0.12;
  const makePerpGrad = (halfW) => ctx.createLinearGradient(
    mx - nx * halfW, my - ny * halfW,
    mx + nx * halfW, my + ny * halfW
  );

  ctx.save();
  if (rgb === 'spectrum') {
    const totalHalf = Math.max(2.6, st.width * 1.40);
    const auraHalf = totalHalf + (9.5 + g * 6.5) * auraScale;
    const redRgb = desatObsidianRgb(spectralColor(0, 7).rgb, sat);
    const midRgb = desatObsidianRgb(spectralColor(3, 7).rgb, sat);
    const vioRgb = desatObsidianRgb(spectralColor(6, 7).rgb, sat);
    const auraA = g > 0.04 ? g * 0.20 * auraScale : 0;

    if (auraA > 0.004) {
      const uTopIn = 0.5 - (totalHalf * 0.72) / auraHalf;
      const uTopOut = 0.5 - (totalHalf * 1.32) / auraHalf;
      const uBotIn = 0.5 + (totalHalf * 0.72) / auraHalf;
      const uBotOut = 0.5 + (totalHalf * 1.32) / auraHalf;
      const haloGrad = makePerpGrad(auraHalf);
      haloGrad.addColorStop(0.00, `rgba(${redRgb}, 0)`);
      haloGrad.addColorStop(uTopOut, `rgba(${redRgb}, ${(auraA * 0.34).toFixed(3)})`);
      haloGrad.addColorStop(uTopIn, `rgba(${redRgb}, ${auraA.toFixed(3)})`);
      haloGrad.addColorStop(0.50, `rgba(${midRgb}, ${(auraA * 0.52).toFixed(3)})`);
      haloGrad.addColorStop(uBotIn, `rgba(${vioRgb}, ${auraA.toFixed(3)})`);
      haloGrad.addColorStop(uBotOut, `rgba(${vioRgb}, ${(auraA * 0.34).toFixed(3)})`);
      haloGrad.addColorStop(1.00, `rgba(${vioRgb}, 0)`);

      ctx.save();
      ctx.globalCompositeOperation = 'lighter';
      fillBeamQuad(ctx, x0, y0, x1, y1, nx, ny, auraHalf, haloGrad);
      ctx.restore();
    }

    const bodyHalf = totalHalf + 0.8;
    const bandA = (0.26 + g * 0.68).toFixed(3);
    const specGrad = makePerpGrad(bodyHalf);
    specGrad.addColorStop(0.00, `rgba(${redRgb}, 0)`);
    for (let i = 0; i < 7; i++) {
      specGrad.addColorStop(0.10 + (i / 6) * 0.80, `rgba(${desatObsidianRgb(spectralColor(i, 7).rgb, sat)}, ${bandA})`);
    }
    specGrad.addColorStop(1.00, `rgba(${vioRgb}, 0)`);
    fillBeamQuad(ctx, x0, y0, x1, y1, nx, ny, bodyHalf, specGrad);

    if (active) {
      ctx.save();
      ctx.globalCompositeOperation = 'lighter';
      const shim = makeFlowShimmerGradient(ctx, x0, y0, x1, y1, st, phaseOffset, '255, 255, 255', 0.15);
      fillBeamQuad(ctx, x0, y0, x1, y1, nx, ny, totalHalf * 0.84, shim);
      ctx.restore();
    }
  } else {
    const bodyRgb = desatObsidianRgb(rgb, sat);
    const crestRgb = mixWhiteRgb(bodyRgb, 0.42 * g);
    const coreHalf = 1.35 + g * 1.20;
    const glowHalf = (10.5 + g * 7.5) * auraScale;
    const peakA = g > 0.04 ? (g * 0.22 * (0.72 + 0.28 * auraScale)) : 0;

    if (peakA > 0.004) {
      const haloGrad = makePerpGrad(glowHalf);
      for (let k = 0; k <= 8; k++) {
        const u = k / 8;
        const t = (u - 0.5) * 2;
        const a = (k === 0 || k === 8) ? 0 : peakA * Math.exp(-(t * t) / 0.18);
        haloGrad.addColorStop(u, `rgba(${bodyRgb}, ${a.toFixed(4)})`);
      }
      ctx.save();
      ctx.globalCompositeOperation = 'lighter';
      fillBeamQuad(ctx, x0, y0, x1, y1, nx, ny, glowHalf, haloGrad);
      ctx.restore();
    }

    const bodyHalf = coreHalf + 0.85;
    const edgeA = (0.22 + g * 0.68).toFixed(3);
    const centerA = (0.28 + g * 0.70).toFixed(3);
    const bodyGrad = makePerpGrad(bodyHalf);
    bodyGrad.addColorStop(0.00, `rgba(${bodyRgb}, 0)`);
    bodyGrad.addColorStop(0.24, `rgba(${bodyRgb}, ${edgeA})`);
    bodyGrad.addColorStop(0.50, `rgba(${crestRgb}, ${centerA})`);
    bodyGrad.addColorStop(0.76, `rgba(${bodyRgb}, ${edgeA})`);
    bodyGrad.addColorStop(1.00, `rgba(${bodyRgb}, 0)`);
    fillBeamQuad(ctx, x0, y0, x1, y1, nx, ny, bodyHalf, bodyGrad);

    if (active) {
      ctx.save();
      ctx.globalCompositeOperation = 'lighter';
      const shim = makeFlowShimmerGradient(
        ctx, x0, y0, x1, y1, st, phaseOffset, mixWhiteRgb(bodyRgb, 0.45), 0.20
      );
      fillBeamQuad(ctx, x0, y0, x1, y1, nx, ny, coreHalf * 0.88, shim);
      ctx.restore();
    }
  }
  ctx.restore();
}

// 45-45-90 Total Internal Reflection Crystal Prism placed at each 90-degree beam bend
function drawRightAngleTurningPrism(ctx, prism) {
  const { x, y, inDir, outDir, rgb, glow, r } = prism;
  const g = Math.max(0, Math.min(1, glow));
  const sat = 0.22 + 0.78 * Math.min(1, g * 1.25);
  const tintRgb = desatObsidianRgb(rgb, sat);

  const cX = x + r * (-inDir.x + outDir.x);
  const cY = y + r * (-inDir.y + outDir.y);
  const aX = x + r * (inDir.x + outDir.x);
  const aY = y + r * (inDir.y + outDir.y);
  const bX = x + r * (-inDir.x - outDir.x);
  const bY = y + r * (-inDir.y - outDir.y);

  ctx.save();
  ctx.fillStyle = '#04060a';
  ctx.beginPath();
  ctx.moveTo(cX, cY);
  ctx.lineTo(aX, aY);
  ctx.lineTo(bX, bY);
  ctx.closePath();
  ctx.fill();

  ctx.save();
  ctx.clip();
  const sheeR = r * 1.18;
  const sheen = ctx.createRadialGradient(x, y, 0, x, y, sheeR);
  sheen.addColorStop(0.00, `rgba(${mixWhiteRgb(tintRgb, 0.50 * g)}, ${(0.06 + g * 0.42).toFixed(3)})`);
  sheen.addColorStop(0.65, `rgba(${tintRgb}, ${(0.02 + g * 0.14).toFixed(3)})`);
  sheen.addColorStop(1.00, `rgba(${tintRgb}, 0)`);
  ctx.fillStyle = sheen;
  ctx.fillRect(x - r - 2, y - r - 2, r * 2 + 4, r * 2 + 4);
  ctx.restore();

  ctx.strokeStyle = `rgba(180, 198, 224, ${(0.34 + g * 0.30).toFixed(3)})`;
  ctx.lineWidth = 1.0;
  ctx.beginPath();
  ctx.moveTo(cX, cY);
  ctx.lineTo(aX, aY);
  ctx.lineTo(bX, bY);
  ctx.closePath();
  ctx.stroke();

  if (g > 0.08) {
    ctx.shadowColor = `rgba(${tintRgb}, ${(g * 0.48).toFixed(3)})`;
    ctx.shadowBlur = g * 4;
  }
  ctx.strokeStyle = `rgba(${mixWhiteRgb(tintRgb, 0.55 * g)}, ${(0.32 + g * 0.62).toFixed(3)})`;
  ctx.lineWidth = 1.2;
  ctx.beginPath();
  ctx.moveTo(aX, aY);
  ctx.lineTo(bX, bY);
  ctx.stroke();
  ctx.restore();
}

function clipHalfRectY(ctx, yEdge, sideSign, W, H) {
  ctx.beginPath();
  if (sideSign < 0) ctx.rect(-40, -40, W + 80, yEdge + 40);
  else ctx.rect(-40, yEdge, W + 80, H - yEdge + 40);
  ctx.clip();
}

function drawOrthoStepWithPrisms(ctx, rawPts, rgb, st, phaseOffset, prismsQueue, opts = {}) {
  const pts = [];
  for (const p of rawPts) {
    const prev = pts[pts.length - 1];
    if (!prev || Math.hypot(p.x - prev.x, p.y - prev.y) > 0.5) {
      pts.push({ x: p.x, y: p.y });
    }
  }
  if (pts.length < 2) return;

  const segs = [];
  let totalLen = 0;
  for (let i = 0; i < pts.length - 1; i++) {
    const dx = pts[i + 1].x - pts[i].x;
    const dy = pts[i + 1].y - pts[i].y;
    const l = Math.hypot(dx, dy);
    segs.push({ ux: dx / (l || 1), uy: dy / (l || 1), len: l, cumStart: totalLen });
    totalLen += l;
  }
  if (totalLen < 2) return;

  const baseR = opts.prismRadius ?? 6.5;
  const cornerRadii = new Array(pts.length).fill(0);
  for (let i = 1; i < pts.length - 1; i++) {
    const inS = segs[i - 1];
    const outS = segs[i];
    if (Math.abs(inS.ux * outS.ux + inS.uy * outS.uy) < 0.05) {
      const rFit = Math.min(baseR, inS.len * 0.42, outS.len * 0.42);
      if (rFit >= 3.8) {
        cornerRadii[i] = rFit;
        prismsQueue.push({
          x: pts[i].x,
          y: pts[i].y,
          inDir: { x: inS.ux, y: inS.uy },
          outDir: { x: outS.ux, y: outS.uy },
          rgb: rgb === 'spectrum' ? '195, 222, 255' : rgb,
          glow: st.glow,
          r: rFit
        });
      }
    }
  }

  for (let i = 0; i < segs.length; i++) {
    const s = segs[i];
    if (s.len < 1.5) continue;
    const trimA = cornerRadii[i] > 0 ? cornerRadii[i] - 0.8 : 0;
    const trimB = cornerRadii[i + 1] > 0 ? cornerRadii[i + 1] - 0.8 : 0;
    if (s.len - trimA - trimB < 1.0) continue;

    const sx = pts[i].x + s.ux * trimA;
    const sy = pts[i].y + s.uy * trimA;
    const ex = pts[i + 1].x - s.ux * trimB;
    const ey = pts[i + 1].y - s.uy * trimB;
    const segPhase = phaseOffset + (s.cumStart + trimA) / Math.max(80, totalLen);

    const clipFn = (i === 0 && opts.clipFirst) ? opts.clipFirst
      : ((i === segs.length - 1 && opts.clipLast) ? opts.clipLast : null);

    if (clipFn) {
      ctx.save();
      clipFn(ctx);
      drawSmoothStraightBeam(ctx, sx, sy, ex, ey, rgb, st, segPhase, opts.auraScale ?? 1);
      ctx.restore();
    } else {
      drawSmoothStraightBeam(ctx, sx, sy, ex, ey, rgb, st, segPhase, opts.auraScale ?? 1);
    }
  }

  if (opts.tag && totalLen >= 18) {
    const tp = opts.tagAt || { x: (pts[0].x + pts[pts.length - 1].x) * 0.5, y: (pts[0].y + pts[pts.length - 1].y) * 0.5 };
    drawLinkTag(ctx, tp.x, tp.y, opts.tag, rgb);
  }
}

function drawCrystalPrism(ctx, g, mode) {
  const { cx, cy, topX, topY, leftX, leftY, rightX, rightY, entryX, exitX } = g;
  const gSpec = waveState[4].glow;
  const avgG = Math.max(waveState[0].glow, waveState[1].glow, waveState[2].glow, gSpec);
  const raySts = [
    { x: topX,   y: topY,   rgb: '242, 90, 90',   g: waveState[0].glow },
    { x: exitX,  y: cy,     rgb: '87, 209, 146',  g: waveState[1].glow },
    { x: cx,     y: leftY,  rgb: '100, 174, 245', g: waveState[2].glow },
  ];

  ctx.fillStyle = '#04060a';
  ctx.beginPath();
  ctx.moveTo(topX, topY);
  ctx.lineTo(rightX, rightY);
  ctx.lineTo(leftX, leftY);
  ctx.closePath();
  ctx.fill();

  ctx.save();
  ctx.beginPath();
  ctx.moveTo(topX, topY);
  ctx.lineTo(rightX, rightY);
  ctx.lineTo(leftX, leftY);
  ctx.closePath();
  ctx.clip();

  // Internal optical refraction rays & soft focus flare scaled strictly by live traffic
  const focusX = mode === 'split' ? entryX : exitX;
  const rad = Math.max(10, Math.hypot(exitX - entryX, 0) * 1.15);
  const focusGrad = ctx.createRadialGradient(focusX, cy, 0, cx, cy, rad);
  focusGrad.addColorStop(0.00, `rgba(232, 242, 255, ${(0.08 + gSpec * 0.56).toFixed(3)})`);
  focusGrad.addColorStop(0.42, `rgba(186, 214, 248, ${(0.03 + gSpec * 0.22).toFixed(3)})`);
  focusGrad.addColorStop(1.00, 'rgba(140, 175, 220, 0)');
  ctx.fillStyle = focusGrad;
  ctx.fillRect(leftX - 2, topY - 2, (rightX - leftX) + 4, (leftY - topY) + 4);

  const midTargetX = mode === 'split' ? entryX : exitX;
  for (let i = 0; i < raySts.length; i++) {
    const tgt = raySts[i];
    const rx = (mode === 'merge' && i === 1) ? entryX : tgt.x;
    const lg = ctx.createLinearGradient(midTargetX, cy, rx, tgt.y);
    const a = 0.04 + tgt.g * 0.34;
    lg.addColorStop(0.0, `rgba(225, 238, 255, ${(a * 0.7).toFixed(3)})`);
    lg.addColorStop(1.0, `rgba(${desatObsidianRgb(tgt.rgb, 0.22 + 0.78 * tgt.g)}, ${a.toFixed(3)})`);
    ctx.strokeStyle = lg;
    ctx.lineWidth = 1.6 + tgt.g * 1.6;
    ctx.beginPath();
    ctx.moveTo(midTargetX, cy);
    ctx.lineTo(rx, tgt.y);
    ctx.stroke();
  }
  ctx.restore();

  ctx.save();
  if (avgG > 0.08) {
    ctx.shadowColor = `rgba(186, 216, 250, ${(avgG * 0.30).toFixed(3)})`;
    ctx.shadowBlur = avgG * 6;
  }
  ctx.strokeStyle = `rgba(220, 234, 252, ${(0.44 + avgG * 0.44).toFixed(3)})`;
  ctx.lineWidth = 1.45;
  ctx.beginPath();
  ctx.moveTo(topX, topY);
  ctx.lineTo(rightX, rightY);
  ctx.lineTo(leftX, leftY);
  ctx.closePath();
  ctx.stroke();
  ctx.restore();
}

function makePrismGeom(cx, cy, side) {
  const triH = (side * Math.sqrt(3)) / 2;
  const topX = cx;
  const topY = cy - triH * 0.52;
  const leftX = cx - side * 0.5;
  const leftY = topY + triH;
  const rightX = cx + side * 0.5;
  const rightY = topY + triH;
  const tMid = (cy - topY) / triH;
  const entryX = topX + (leftX - topX) * tMid;
  const exitX = topX + (rightX - topX) * tMid;
  return { cx, cy, side, triH, topX, topY, leftX, leftY, rightX, rightY, entryX, exitX };
}

function drawDualPrismPipeline(ctx, W, H, ing, vip, tun, dom, qos, prismsQueue) {
  const s2Left = Math.min(vip.x, tun.x, dom.x);
  const s2Right = Math.max(vip.right, tun.right, dom.right);
  const gap1W = s2Left - ing.right;
  const gap2W = qos.x - s2Right;
  if (gap1W < 30 || gap2W < 30) return;

  // Left Main Prism sits LOWER (aligned toward NFTABLES CLASSIFY), Right Merge Prism sits HIGHER (toward 3-BAND HTB)
  const safeTop1 = Math.max(ing.y + 22, tun.y + 22, vip.cy + 28);
  const safeBot1 = Math.min(ing.bottom - 22, tun.bottom - 22, dom.cy - 40);
  const y1 = safeTop1 <= safeBot1
    ? Math.max(safeTop1, Math.min(safeBot1, safeTop1 + (safeBot1 - safeTop1) * 0.90, ing.cy - 8))
    : Math.max(ing.y + 18, Math.min(tun.bottom - 18, tun.cy + 28));

  const safeTop2 = Math.max(tun.y + 22, qos.y + 22, vip.cy + 40);
  const safeBot2 = Math.min(tun.bottom - 22, qos.bottom - 22, dom.cy - 40);
  const y2 = safeTop2 <= safeBot2
    ? Math.max(safeTop2, Math.min(safeBot2, Math.max(qos.cy + 18, safeTop2 + (safeBot2 - safeTop2) * 0.16)))
    : Math.max(tun.y + 18, Math.min(qos.bottom - 18, qos.cy + 18));

  // === GAP 1: Symmetric 1 -> 3 Main Dispersion Prism on Gap 1 Lower Axis ===
  const g1 = makePrismGeom(ing.right + gap1W * 0.50, y1, Math.max(26, Math.min(38, gap1W * 0.34)));

  drawOrthoStepWithPrisms(
    ctx,
    [{ x: ing.right - 1, y: y1 }, { x: g1.entryX + 12, y: y1 }],
    'spectrum', waveState[4], 0.04, prismsQueue,
    { clipFirst: (c) => clipHalfPlane(c, g1.topX, g1.topY, g1.leftX, g1.leftY, -1, W, H) }
  );

  // Branch 0 (Red @vip_lane): exits apex UP -> SINGLE 45-deg prism -> RIGHT (1 bend)
  drawOrthoStepWithPrisms(
    ctx,
    [{ x: g1.cx, y: g1.topY + 2 }, { x: g1.cx, y: vip.cy }, { x: vip.x + 1, y: vip.cy }],
    '242, 90, 90', waveState[0], 0.00, prismsQueue,
    { clipFirst: (c) => clipHalfRectY(c, g1.topY + 1, -1, W, H), prismRadius: 6.5 }
  );

  // Branch 1 (Green TW-HOME): exits right bevel STRAIGHT RIGHT (0 bends)
  drawOrthoStepWithPrisms(
    ctx,
    [{ x: g1.exitX - 12, y: y1 }, { x: tun.x + 1, y: y1 }],
    '87, 209, 146', waveState[1], 0.16, prismsQueue,
    { clipFirst: (c) => clipHalfPlane(c, g1.topX, g1.topY, g1.rightX, g1.rightY, 1, W, H) }
  );

  // Branch 2 (Blue Burst-Harvest): exits flat base DOWN -> SINGLE 45-deg prism -> RIGHT (1 bend)
  drawOrthoStepWithPrisms(
    ctx,
    [{ x: g1.cx, y: g1.leftY - 2 }, { x: g1.cx, y: dom.cy }, { x: dom.x + 1, y: dom.cy }],
    '100, 174, 245', waveState[2], 0.32, prismsQueue,
    { clipFirst: (c) => clipHalfRectY(c, g1.leftY - 1, 1, W, H), prismRadius: 6.5 }
  );

  drawCrystalPrism(ctx, g1, 'split');

  // === GAP 2: Symmetric 3 -> 1 Recombination Merge Prism on Gap 2 Upper Axis ===
  const g2 = makePrismGeom(s2Right + gap2W * 0.50, y2, Math.max(26, Math.min(38, gap2W * 0.36)));

  // Branch 0 (Red @vip_lane): RIGHT -> SINGLE 45-deg prism -> straight DOWN into apex (1 bend)
  drawOrthoStepWithPrisms(
    ctx,
    [{ x: vip.right - 1, y: vip.cy }, { x: g2.cx, y: vip.cy }, { x: g2.cx, y: g2.topY + 2 }],
    '242, 90, 90', waveState[0], 0.24, prismsQueue,
    { clipLast: (c) => clipHalfRectY(c, g2.topY + 1, -1, W, H), prismRadius: 6.5 }
  );

  // Branch 1 (Green TW-HOME): STRAIGHT RIGHT into left bevel (0 bends)
  drawOrthoStepWithPrisms(
    ctx,
    [{ x: tun.right - 1, y: y2 }, { x: g2.entryX + 12, y: y2 }],
    '87, 209, 146', waveState[1], 0.38, prismsQueue,
    { clipFirst: (c) => clipHalfPlane(c, g2.topX, g2.topY, g2.leftX, g2.leftY, -1, W, H) }
  );

  // Branch 2 (Blue Burst-Harvest): RIGHT -> SINGLE 45-deg prism -> straight UP into flat base (1 bend)
  drawOrthoStepWithPrisms(
    ctx,
    [{ x: dom.right - 1, y: dom.cy }, { x: g2.cx, y: dom.cy }, { x: g2.cx, y: g2.leftY - 2 }],
    '100, 174, 245', waveState[2], 0.52, prismsQueue,
    { clipLast: (c) => clipHalfRectY(c, g2.leftY - 1, 1, W, H), prismRadius: 6.5 }
  );

  // Unified Merged Spectrum Egress -> 3-BAND HTB + FQ_CODEL (0 bends)
  drawOrthoStepWithPrisms(
    ctx,
    [{ x: g2.exitX - 12, y: y2 }, { x: qos.x + 1, y: y2 }],
    'spectrum', waveState[4], 0.44, prismsQueue,
    { clipFirst: (c) => clipHalfPlane(c, g2.topX, g2.topY, g2.rightX, g2.rightY, 1, W, H) }
  );

  drawCrystalPrism(ctx, g2, 'merge');
}

let cachedBpLayout = null;
let bpLayoutDirty = true;
let lastCanvasPaintTs = 0;

function markBpLayoutDirty() {
  bpLayoutDirty = true;
}

function measureBpLayout(pipe) {
  const rect = pipe.getBoundingClientRect();
  if (rect.width < 40 || rect.height < 40) return null;
  const pre = relBox($('#bp-card-pregate'), rect);
  const ing = relBox($('#bp-card-ingress'), rect);
  const vip = relBox($('#bp-card-vip'), rect);
  const tun = relBox($('#bp-card-tun'), rect);
  const dom = relBox($('#bp-card-dom'), rect);
  const qos = relBox($('#bp-card-qos'), rect);
  const up  = relBox($('#bp-card-uplink'), rect);
  if (!pre || !ing || !vip || !tun || !dom || !qos || !up) return null;
  cachedBpLayout = { width: rect.width, height: rect.height, pre, ing, vip, tun, dom, qos, up };
  bpLayoutDirty = false;
  return cachedBpLayout;
}

function renderWaveguidesCanvas() {
  const pipe = $('#bp-pipeline');
  const canvas = $('#bp-flow-canvas');
  if (!pipe || !canvas) return;

  const lay = (!bpLayoutDirty && cachedBpLayout) ? cachedBpLayout : measureBpLayout(pipe);
  if (!lay) return;

  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const cw = Math.round(lay.width * dpr);
  const ch = Math.round(lay.height * dpr);
  if (canvas.width !== cw || canvas.height !== ch) {
    canvas.width = cw;
    canvas.height = ch;
  }

  const { pre, ing, vip, tun, dom, qos, up } = lay;

  const ctx = canvas.getContext('2d');
  ctx.save();
  ctx.scale(dpr, dpr);
  ctx.clearRect(0, 0, lay.width, lay.height);

  const prismsQueue = [];

  // Stage 1 Vertical Conduit: Guard & SmartDNS -> Nftables Classify Engine (uninterrupted parallel spectrum)
  if (ing.y - pre.bottom > 6) {
    drawRefractedVerticalBridge(ctx, pre, ing, waveState[4], 0.00);
  }

  // Inter-Engine Vertical Cross-Feed: TW-HOME (TProxy weave_out) -> Burst-Harvest Pool
  if (dom.y - tun.bottom > 6) {
    drawRefractedVerticalBridge(ctx, tun, dom, waveState[3], 0.12);
  }

  // Stage 3 Vertical Convergence: 3-Band HTB QoS -> 21-Uplink NAT & Egress
  if (up.y - qos.bottom > 6) {
    drawRefractedVerticalBridge(ctx, qos, up, waveState[4], 0.30);
  }

  // Symmetric Center-Axis Dual Prisms + Single-Bend 45-deg TIR Mirrors
  drawDualPrismPipeline(ctx, lay.width, lay.height, ing, vip, tun, dom, qos, prismsQueue);

  // Render all 45-degree crystal turning prisms crisply above straight beam spans
  for (const p of prismsQueue) drawRightAngleTurningPrism(ctx, p);

  ctx.restore();
}

function stepAnimation(now) {
  if (S.tab !== 'blueprint' || document.visibilityState === 'hidden') {
    rafId = null;
    lastFrameTs = 0;
    return;
  }

  const dt = lastFrameTs ? Math.min(0.08, Math.max(0.004, (now - lastFrameTs) / 1000)) : 0.016;
  lastFrameTs = now;
  const kWave = Math.min(1, 1 - Math.exp(-dt * 5.2));

  for (let k = 0; k < waveState.length; k++) {
    const b = waveState[k];
    b.vel += (b.targetVel - b.vel) * kWave;
    b.glow += (b.targetGlow - b.glow) * kWave;
    b.width += (b.targetWidth - b.width) * kWave;
    b.phase = (b.phase + b.vel * dt) % 1.0;
  }

  let heatDirty = false;
  const heatElapsed = now - lastHeatPaintTs;
  if (heatElapsed >= 33) {
    lastHeatPaintTs = now;
    heatDirty = paintAllModuleHeats(false, Math.min(0.1, heatElapsed / 1000));
  }

  if (bpLayoutDirty || !lastCanvasPaintTs || (now - lastCanvasPaintTs) >= 28 || heatDirty) {
    lastCanvasPaintTs = now;
    renderWaveguidesCanvas();
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
    lastCanvasPaintTs = 0;
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
  let totPkts = 0, totBytes = 0, quicPkts = 0, quicBytes = 0, dropPkts = 0;
  let tunPkts = 0, domPkts = 0, tunBytes = 0, domBytes = 0;
  for (const r of rules) {
    const p = r.packets || 0;
    const b = r.bytes || 0;
    totPkts += p;
    totBytes += b;
    if (r.tag === 'quic') {
      quicPkts += p;
      quicBytes += b;
      dropPkts += p;
    } else if (r.tag === 'device-block' || r.tag === 'unverified-drop') {
      dropPkts += p;
    }
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
  liveFlow.totBytes = totBytes;
  liveFlow.quicPkts = quicPkts;
  liveFlow.dropPkts = dropPkts;
  liveFlow.quicBytes = quicBytes;
  liveFlow.tunPkts = tunPkts;
  liveFlow.domPkts = domPkts;
  liveFlow.tunBytes = tunBytes;
  liveFlow.domBytes = domBytes;
  liveFlow.tunShare = totPkts > 0 ? tunPkts / totPkts : 0;

  const directResidual = Math.max(0, totalRate - vipBps - liveFlow.tunBps);
  const weaveBps = prevRuleSample ? liveFlow.domBps : Math.max(liveFlow.domBps, directResidual);
  const rates = [
    vipS && vipS.healthy ? vipBps : -1,
    st.tunnel?.on && st.tunnel?.running ? liveFlow.tunBps : -1,
    st.healthy_count > 0 ? weaveBps : -1,
    st.tunnel?.on && st.tunnel?.running ? liveFlow.tunBps : -1,
    totalRate
  ];

  const maxBps = Math.max(2048, vipBps, liveFlow.tunBps, weaveBps, totalRate);
  for (let k = 0; k < waveState.length; k++) {
    const bps = rates[k];
    const b = waveState[k];
    if (bps < 0 || bps <= 32) {
      b.targetVel = bps < 0 ? 0 : 0.04;
      b.targetGlow = 0;
      b.targetWidth = 1.65;
    } else {
      const mbps = (bps * 8) / 1e6;
      const absPulse = Math.min(1, Math.log10(1 + mbps * 7) / 1.55);
      const relPulse = bps / maxBps;
      const level = Math.min(1, Math.max(absPulse, relPulse * 0.42));
      b.targetVel = 0.14 + level * 1.10;
      b.targetGlow = level;
      b.targetWidth = 1.75 + level * 1.65;
    }
  }

  // Per-module hotspot calculation driving optical saturation & glow bloom
  const heatOf = (bps, floor = 0.03) => {
    if (bps < 0) return 0.02;
    if (bps <= 32) return floor;
    const mbps = (bps * 8) / 1e6;
    const absH = Math.min(1, Math.log10(1 + mbps * 7.5) / 1.45);
    const relH = bps / maxBps;
    return Math.min(1, Math.max(floor, 0.10 + absH * 0.55 + relH * 0.40));
  };

  moduleHeat.guard.rgb      = !st.ok ? '230, 108, 120' : (st.tunnel?.fail_open ? '235, 154, 94' : '170, 142, 240');
  moduleHeat.guard.target   = !st.ok ? 0.92 : (st.tunnel?.fail_open ? 0.72 : heatOf(liveFlow.tunBps + totalRate * 0.35, 0.10));
  moduleHeat.pregate.target = st.dns?.smartdns ? heatOf(totalRate * 0.65, 0.10) : 0.04;
  moduleHeat.ingress.target = heatOf(totalRate, 0.12);
  moduleHeat.vip.target     = vipS && vipS.healthy ? heatOf(vipBps, 0.03) : 0.02;
  moduleHeat.tun.target     = st.tunnel?.running ? heatOf(liveFlow.tunBps, 0.06) : 0.03;
  moduleHeat.dom.target     = st.healthy_count > 0 ? heatOf(weaveBps, 0.08) : 0.03;
  moduleHeat.qos.target     = heatOf(totalRate, 0.10);
  moduleHeat.uplink.target  = Math.min(1, heatOf(totalRate, 0.10) * 0.92 + Math.min(0.12, (st.sys?.load1 || 0) * 0.06));
}

function renderClassifyStrip() {
  const grid = $('#bp-classify-grid');
  if (!grid) return;
  const rules = S.rules?.rules || [];
  // Keep rules in exact nftables `chain classify` evaluation order (no packet-count re-sorting).
  const coreTags = [
    'unverified-drop',
    'relay',
    'quic',
    'device-direct',
    'device-tunnel',
    'tunnel-range',
    'tunnel-domain',
    'domestic',
    'domestic-domain',
    'rest-tunnel'
  ];
  if (!rules.length) {
    if (grid._orderSig === '__empty__') return;
    grid._orderSig = '__empty__';
    grid._rowsByTag = new Map();
    const frag = document.createDocumentFragment();
    for (const tag of coreTags) {
      const label = RULE_LABELS[tag] || tag;
      const segEl = el('span', { class: 'seg-meter' });
      renderSegMeter(segEl, 0, 16, 'blue', false);
      frag.appendChild(el('div', {
        class: 'classify-bar-card',
        style: { '--cb-rgb': '52, 58, 72', '--cb-fill': '0', '--cb-bdr-a': '0.16', '--cb-glow-blur': '0px', '--cb-glow-a': '0' }
      },
        el('div', { class: 'classify-bar-head' },
          el('span', { class: 'c-muted', style: { whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', minWidth: '0' } }, label),
          el('span', { class: 'c-muted', style: { fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap', fontSize: '9.5px' } }, '—')
        ),
        segEl
      ));
    }
    grid.innerHTML = '';
    grid.appendChild(frag);
    return;
  }

  const sig = `${S.rules?.tunnel_on ? 1 : 0}|` + rules.map(r => `${r.tag}:${r.packets || 0}:${r.bytes || 0}`).join(';');
  if (grid._lastSig === sig) return;
  grid._lastSig = sig;

  const tot = Math.max(1, rules.reduce((acc, r) => acc + (r.packets || 0), 0));
  const coreSet = new Set([...coreTags, 'rest-direct']);
  const visible = rules.filter(r => (r.packets || 0) > 0 || coreSet.has(r.tag));

  const orderSig = visible.map(r => r.tag).join(',');
  const needsRebuild = (grid._orderSig !== orderSig) || !grid._rowsByTag;
  const rowsByTag = needsRebuild ? new Map() : grid._rowsByTag;
  const frag = needsRebuild ? document.createDocumentFragment() : null;

  for (const r of visible) {
    const label = RULE_LABELS[r.tag] || r.tag;
    const pkts = r.packets || 0;
    const bytes = r.bytes || 0;
    const share = (pkts / tot) * 100;
    const fillPct = pkts > 0 ? Math.min(100, Math.max(6, Math.pow(share / 100, 0.58) * 100)) : 0;

    let colorName = 'blue';
    let colorRgb = '100, 174, 245';
    let textCls = 'c-blue';
    if (r.tag.includes('tunnel') || r.tag === 'rest-tunnel') {
      colorName = 'mint';
      colorRgb = '87, 209, 146';
      textCls = 'c-mint';
    } else if (r.tag === 'device-game') {
      colorName = 'red';
      colorRgb = '242, 90, 90';
      textCls = 'c-red';
    } else if (r.tag === 'quic') {
      colorName = 'amber';
      colorRgb = '235, 154, 94';
      textCls = 'c-amber';
    } else if (r.tag === 'device-block' || r.tag === 'unverified-drop') {
      colorName = 'crimson';
      colorRgb = '230, 108, 120';
      textCls = 'c-crimson';
    }

    const rHeat = pkts > 0 ? Math.min(1, Math.max(0.08, Math.pow(share / 100, 0.52))) : 0;
    const heatRgb = pkts > 0 ? desatObsidianRgb(colorRgb, 0.24 + 0.76 * rHeat) : '52, 58, 72';
    const fillA = pkts > 0 ? (0.04 + 0.08 * rHeat).toFixed(3) : '0';
    const bdrA = pkts > 0 ? (0.28 + 0.58 * rHeat).toFixed(2) : '0.16';
    const glowBlur = pkts > 0 ? `${Math.round(4 + 14 * rHeat)}px` : '0px';
    const glowA = pkts > 0 ? (0.04 + 0.22 * rHeat).toFixed(2) : '0';

    const byteTxt = fmtBytes(bytes).replace(/\s+/g, '');
    const pktTxt = pkts >= 1e6 ? `${(pkts / 1e6).toFixed(1)}M` : (pkts >= 1000 ? `${Math.round(pkts / 1000)}k` : `${pkts}`);
    const pctTxt = pkts > 0 ? (share >= 1 ? `${Math.round(share)}%` : `${share.toFixed(1)}%`) : '0%';
    const statTxt = `${byteTxt}·${pktTxt}·${pctTxt}`;

    let rec = rowsByTag.get(r.tag);
    if (!rec) {
      const labelEl = el('span', { class: pkts > 0 ? 'c-bright' : 'c-muted', style: { fontWeight: pkts > 0 ? '600' : '400', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', minWidth: '0' } }, label);
      const statEl = el('span', { class: pkts > 0 ? textCls : 'c-muted', style: { fontVariantNumeric: 'tabular-nums', fontWeight: '600', whiteSpace: 'nowrap', fontSize: '9.5px' } }, statTxt);
      const segEl = el('span', { class: `seg-meter${pkts > 0 ? ' active' : ''}` });
      const card = el('div', {
        class: `classify-bar-card ${pkts > 0 ? 'active' : ''}`,
        title: `${label} · ${fmtBytes(bytes)} · ${pkts.toLocaleString()} pkts (${pctTxt})`,
        style: {
          '--cb-rgb': heatRgb,
          '--cb-fill': fillA,
          '--cb-bdr-a': bdrA,
          '--cb-glow-blur': glowBlur,
          '--cb-glow-a': glowA
        }
      }, el('div', { class: 'classify-bar-head' }, labelEl, statEl), segEl);
      rec = { card, labelEl, statEl, segEl };
      rowsByTag.set(r.tag, rec);
    } else {
      setCls(rec.card, `classify-bar-card ${pkts > 0 ? 'active' : ''}`);
      setTitle(rec.card, `${label} · ${fmtBytes(bytes)} · ${pkts.toLocaleString()} pkts (${pctTxt})`);
      setVar(rec.card, '--cb-rgb', heatRgb);
      setVar(rec.card, '--cb-fill', fillA);
      setVar(rec.card, '--cb-bdr-a', bdrA);
      setVar(rec.card, '--cb-glow-blur', glowBlur);
      setVar(rec.card, '--cb-glow-a', glowA);
      setCls(rec.labelEl, pkts > 0 ? 'c-bright' : 'c-muted');
      setStyleProp(rec.labelEl, 'fontWeight', pkts > 0 ? '600' : '400');
      setCls(rec.statEl, pkts > 0 ? textCls : 'c-muted');
      setTxt(rec.statEl, statTxt);
      setCls(rec.segEl, `seg-meter${pkts > 0 ? ' active' : ''}`);
    }
    renderSegMeter(rec.segEl, fillPct / 100, 16, colorName, false);
    if (frag) frag.appendChild(rec.card);
  }

  if (needsRebuild) {
    grid._orderSig = orderSig;
    grid._rowsByTag = rowsByTag;
    grid.innerHTML = '';
    grid.appendChild(frag);
  }
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
    const pct = (s.tokens_pct ?? 100) / 100;
    const active = (s.now ?? s.rate ?? 0) > 2000;
    const rateTxt = fmtRateCompact((s.now ?? s.rate ?? 0) + (s.up_now ?? s.up ?? 0));
    const sig = `${s.healthy ? 1 : 0}:${Math.round(pct * 50)}:${active ? 1 : 0}:${rateTxt}:${s.ttfb_ms ?? ''}`;
    if (cell._spSig === sig) continue;
    cell._spSig = sig;
    setTitle(cell, `${s.dev} (#${s.id}) · ${s.healthy ? `${rateTxt} · τ=${s.ttfb_ms ?? '—'}ms · ${s.tokens_pct ?? 100}%` : 'fault'}`);
    if (!s.healthy) {
      cell.style.backgroundColor = 'rgba(230, 108, 120, 0.35)';
      cell.style.boxShadow = 'none';
      cell.style.opacity = '0.45';
    } else {
      cell.style.backgroundColor = col.css;
      cell.style.opacity = String(0.36 + pct * 0.64);
      cell.style.boxShadow = active ? `0 0 8px ${col.css}` : 'none';
    }
  }
}

let bpResizeObserver = null;
function ensureBlueprintResizeObserver() {
  if (bpResizeObserver || typeof ResizeObserver === 'undefined') return;
  const pipe = $('#bp-pipeline');
  if (!pipe) return;
  bpResizeObserver = new ResizeObserver(() => {
    markBpLayoutDirty();
    if (S.tab === 'blueprint') renderWaveguidesCanvas();
  });
  bpResizeObserver.observe(pipe);
  for (const id of ['#bp-card-pregate', '#bp-card-ingress', '#bp-card-vip', '#bp-card-tun', '#bp-card-dom', '#bp-card-qos', '#bp-card-uplink']) {
    const node = $(id);
    if (node) bpResizeObserver.observe(node);
  }
}

export function bindBlueprintEvents() {
  ensureBlueprintResizeObserver();
  $$('#site-mode-seg .seg-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      write('configure', { set: { 'strands.aggregate': btn.dataset.mode } }, `聚匯模式已設為 ${btn.dataset.mode}`);
    });
  });

  $('#site-mem-btn')?.addEventListener('click', () => {
    const st = S.status;
    if (!st) return;
    if (st.site?.known) {
      write('forget', {}, '已清除此站點記憶');
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

  markBpLayoutDirty();
  updateFlowPhysics(st);
  if (!lastHeatPaintTs) {
    lastHeatPaintTs = performance.now();
    paintAllModuleHeats(true);
  }
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
      setCls(mptcpBadge, 'st-badge charged');
      setTxt(mptcpBadge, `MPTCP · ${mp.subflows} subflows · ${mp.endpoints?.length || 0} ep`);
    } else {
      setCls(mptcpBadge, 'st-badge draining');
      setTxt(mptcpBadge, 'MPTCP · standby');
    }
  }

  // Left Guard Rail (Unified Adaptive Security & Invariant Panel)
  const canaryMs = st.tunnel?.canary_ms || 0;
  const canaryFails = st.tunnel?.canary_fails ?? 0;
  const verdictEl = $('#adv-verdict');
  if (verdictEl) {
    setTxt(verdictEl, st.ok ? 'zero-leak' : (st.fail?.[0] || 'check failed'));
    setCls(verdictEl, `bp-meter-val ${st.ok ? 'c-violet' : 'c-crimson'}`);
  }

  const failClosedEl = $('#adv-failclosed');
  if (failClosedEl) {
    const fc = !st.tunnel?.fail_open;
    setTxt(failClosedEl, fc ? 'v6✕ · DoT:853✕' : 'fail-open (!)');
    setCls(failClosedEl, `v ${fc ? 'c-violet' : 'c-amber'}`);
  }

  const dnsEl = $('#adv-dns');
  if (dnsEl) {
    setTxt(dnsEl, st.dns?.smartdns
      ? `53→${st.dns.port || 6053} · ${st.settings?.['dns.ads'] ? 'ads' : 'raw'}`
      : 'offline');
    setCls(dnsEl, `v ${st.dns?.smartdns ? 'c-violet' : 'c-crimson'}`);
  }

  setTxt('#adv-canary', canaryMs > 0 ? `${canaryMs} ms (${canaryFails}f)` : (st.tunnel?.on ? 'active' : 'off'));
  const checks = S.doctor?.checks || [];
  const offCheck = checks.find(c => c.id === 'privacy_no_offload');
  const offEl = $('#adv-offload');
  if (offEl) {
    const offOk = offCheck ? !!offCheck.ok : true;
    setTxt(offEl, offOk ? 'per-pkt ok' : 'offload leak!');
    setCls(offEl, `v ${offOk ? 'c-violet' : 'c-crimson'}`);
  }

  const siteEl = $('#adv-site');
  if (siteEl) {
    const sName = st.site?.name || (st.site?.gateway ? 'unnamed gw' : 'direct');
    setTxt(siteEl, `${sName} · ${st.settings?.['strands.aggregate'] || st.site?.mode || 'auto'}`);
  }

  const ctCount = st.sys?.conntrack?.count ?? 0;
  const ctMax = Math.max(1, st.sys?.conntrack?.max ?? 131072);
  setTxt('#adv-ct', `${ctCount.toLocaleString()}/${(ctMax / 1024).toFixed(0)}k`);
  setTxt('#adv-strands', `${st.healthy_count ?? 0}/${st.strand_count ?? 21} (${st.role === 'primary' ? '主' : (st.role || '主')})`);

  // Subsystem Invariants Grid inside PRISM_GUARD (exact disjoint partition of doctor checks)
  const totChecks = checks.length || 41;
  const okChecks = checks.length ? checks.filter(c => c.ok).length : (st.ok ? totChecks : 0);
  if ($('#adv-inv-score')) {
    setTxt('#adv-inv-score', `${okChecks}/${totChecks} ok`);
    setCls('#adv-inv-score', `bp-live-rate ${okChecks === totChecks ? 'c-violet' : 'c-crimson'}`);
  }
  renderSegMeter($('#adv-invariants-meter'), totChecks > 0 ? okChecks / totChecks : 0, 14, okChecks === totChecks ? 'violet' : 'crimson', false);

  const invGrid = $('#adv-invariants-grid');
  if (invGrid) {
    const groups = [
      { label: 'fw4/guard',  test: c => c.id.startsWith('privacy_') || c.id === 'nft_table' || c.id === 'ip_forward' || c.id === 'ssh_public' || c.id === 'http_public' || c.id === 'secret_perms' || c.id === 'overlay_space' },
      { label: 'dns/6053',   test: c => c.id.includes('dns') || c.id.includes('dhcp') },
      { label: 'tproxy/cage',test: c => c.id.startsWith('tunnel_') },
      { label: 'weave/21ch', test: c => c.id === 'weave' || c.id === 'pattern' || c.id.startsWith('strands_') || c.id === 'domestic4_loaded' },
      { label: 'mptcp/htb',  test: c => c.id.startsWith('mptcp_') || c.id === 'uplink_carrier' || c.id === 'shaper' },
      { label: 'wifi/ap',    test: c => c.id === 'hostapd' || c.id.startsWith('wifi_') || c.id.startsWith('ap:') || c.id.startsWith('ap_ssid:') || c.id === 'sta_with_copper' },
    ];
    const invSig = checks.length ? checks.map(c => `${c.id}:${c.ok ? 1 : 0}`).join(';') : '__empty__';
    if (invGrid._lastSig !== invSig) {
      invGrid._lastSig = invSig;
      const gFrag = document.createDocumentFragment();
      for (const grp of groups) {
        const matched = checks.length ? checks.filter(grp.test) : [];
        const passed = matched.filter(c => c.ok).length;
        const allOk = !checks.length || matched.length === 0 || passed === matched.length;
        const valTxt = checks.length ? (matched.length ? `${passed}/${matched.length}` : 'n/a') : '—';
        gFrag.appendChild(el('div', { class: `guard-inv-cell ${checks.length ? (allOk ? 'ok' : 'bad') : ''}` },
          el('span', { style: { display: 'inline-flex', alignItems: 'center', gap: '5px', minWidth: '0' } },
            el('span', { class: `run-dot ${checks.length ? (allOk ? 'violet' : 'crimson') : 'off'}` }),
            el('span', { class: 'c-sec', style: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, grp.label)
          ),
          el('span', { class: checks.length ? (allOk ? 'c-bright' : 'c-crimson') : 'c-muted', style: { fontWeight: '600', fontVariantNumeric: 'tabular-nums', flexShrink: '0' } }, valTxt)
        ));
      }
      invGrid.innerHTML = '';
      invGrid.appendChild(gFrag);
    }
  }

  setTxt('#adv-relays', `:${st.tunnel?.mixed_port || 61235}·${st.tunnel?.relays ?? 0}r·${st.mptcp?.endpoints?.length ?? 0}ep`);
  const rem = st.settings?.['classify.remainder'] || 'tunnel';
  const q = st.settings?.['classify.quic'] === 'reject' ? 'quic✕' : 'quic✓';
  setTxt('#adv-classify-mode', `${rem} · ${q}`);
  setCls('#adv-guard-dot', `run-dot ${st.ok ? 'violet' : 'crimson'}`);
  const recTs = st.reconciled || st.ts;
  setTxt('#adv-reconcile', recTs ? `sync ${fmtClock(recTs)}` : 'live');
  const docEl = $('#adv-doctor');
  if (docEl) {
    setTxt(docEl, st.ok
      ? `all ${totChecks} invariants ok`
      : `${st.fail?.length || 1} fail · ${st.warn?.length || 0} warn`);
    setCls(docEl, st.ok ? 'c-violet' : 'c-crimson');
  }

  const evList = S.events?.events || [];
  setTxt('#log-count', `${evList.length} 條`);
  setTxt('#log-latest-ts', evList[0]?.ts ? fmtClock(evList[0].ts) : 'live');
  renderSessionLog($('#ov-session-log'), evList, 60);

  // Tier 1A: Pre-Gate & SmartDNS
  setTxt('#bp-quic-pkts', liveFlow.quicPkts >= 1000
    ? `${(liveFlow.quicPkts / 1000).toFixed(1)}k pkts`
    : `${liveFlow.quicPkts} pkts`);
  const quicMode = st.settings?.['classify.quic'] || 'reject';
  const dnsTagEl = $('#bp-dns-mode-tag');
  if (dnsTagEl) {
    setTxt(dnsTagEl, quicMode === 'reject' ? 'QUIC reject' : 'QUIC pass');
    setCls(dnsTagEl, `bp-head-sub ${quicMode === 'reject' ? 'c-sec' : 'c-amber'}`);
  }

  const sz = S.rules?.sizes || {};
  setTxt('#bp-dns-port', st.dns?.smartdns ? `53→:${st.dns.port || 6053} · ${st.settings?.['dns.ads'] ? 'ads' : 'raw'}` : 'offline');
  setTxt('#bp-dns-st', `${sz.domestic4 ?? 0}+${sz.domestic4_dns ?? 0}`);
  setTxt('#bp-dns-tun', `${sz.tunnel4 ?? 0}IP · ${sz.tunnel_domains ?? 0}域`);
  setTxt('#bp-dns-dyn', `${sz.relay4 ?? 0}r · ${sz.tunnel4_dns ?? 0}條`);
  setTxt('#bp-quic-bytes', fmtBytes(liveFlow.quicBytes));
  const curMode = st.settings?.['strands.aggregate'] || st.site?.mode || 'auto';
  const siteNameEl = $('#bp-site-name');
  if (siteNameEl) {
    const siteName = st.site?.name || 'direct';
    setTxt(siteNameEl, siteName);
    setTitle(siteNameEl, `${siteName} (${curMode})`);
  }
  const preEl = $('#bp-pregate-rules');
  if (preEl) {
    if (!preEl._init) {
      preEl._init = true;
      preEl.innerHTML = '';
      preEl._leftSpan = el('span', {}, 'IPv6 drop · DoT:853 drop');
      preEl._rightSpan = el('span', { class: 'c-spectrum' }, 'fail-closed');
      preEl.appendChild(preEl._leftSpan);
      preEl.appendChild(preEl._rightSpan);
    }
    const isOpen = !!st.tunnel?.fail_open;
    setCls(preEl._rightSpan, isOpen ? 'c-amber' : 'c-spectrum');
    setTxt(preEl._rightSpan, isOpen ? 'fail-open' : 'fail-closed');
  }

  const chargedRatio = (w.charged_count || 0) / nH;
  renderSegMeter($('#bp-harvest-meter'), chargedRatio, 10, 'spectrum');
  setTxt('#bp-harvest-txt', `${w.policy || 'harvest'} ${Math.round(chargedRatio * 100)}%`);

  $$('#site-mode-seg .seg-btn').forEach(b => {
    const want = b.dataset.mode === curMode;
    if (b.classList.contains('on') !== want) b.classList.toggle('on', want);
  });

  const memBtn = $('#site-mem-btn');
  if (memBtn) {
    const wantDisabled = !st.site?.gateway;
    const wantTxt = wantDisabled ? '無網關' : (st.site?.known ? `忘記: ${st.site.name}` : '記住座標');
    if (memBtn.disabled !== wantDisabled) memBtn.disabled = wantDisabled;
    setTxt(memBtn, wantTxt);
  }

  // Tier 1B: Nftables Classify Engine
  const remMode = st.settings?.['classify.remainder'] === 'direct' ? '直連' : '歸籠';
  setTxt('#bp-classify-sub', `mangle · @dev_policy · 餘量${remMode}`);
  setTxt('#bp-ingress-rate', fmtRate(totalRate).full);
  setTxt('#bp-ingress-pkts', liveFlow.totPkts >= 1e6
    ? `${(liveFlow.totPkts / 1e6).toFixed(2)}M pkts`
    : `${(liveFlow.totPkts / 1000).toFixed(1)}k pkts`);
  renderClassifyStrip();
  setTxt('#bp-classify-foot', `prerouting · ${(S.rules?.rules || []).length} rules`);
  setTxt('#bp-classify-bytes', `累計 ${fmtBytes(liveFlow.totBytes)}`);

  // Tier 2 · Branch 0: @vip_lane
  const vipS = strands.find(s => s.vip);
  const vipRateTxt = vipS ? fmtRate(liveFlow.vipBps).full : '0 bps';
  const vShareReal = (vipS && totalRate > 0) ? Math.min(1, liveFlow.vipBps / totalRate) : 0;
  const vShareRatio = (vipS && liveFlow.vipBps > 400) ? Math.max(0.08, vShareReal) : vShareReal;
  const vSharePct = Math.round(vShareReal * 100);
  const vipTokPct = vipS ? Math.round(vipS.tokens_pct ?? 100) : 0;
  setTxt('#bp-vip-rate', vipRateTxt);
  setTxt('#bp-vip-share', vipS ? `蓄能 ${vipTokPct}%` : '蓄能 —');
  renderSegMeter($('#bp-vip-meter'), vShareRatio, 10, 'red');
  setTxt('#bp-vip-pct', `${vSharePct}% 流佔比`);
  if ($('#bp-vip-iface')) setTxt('#bp-vip-iface', vipS ? `${vipS.dev} (#${vipS.id})` : 'auto');
  if ($('#bp-vip-rtt')) setTxt('#bp-vip-rtt', vipS ? `${vipS.ttfb_ms ?? '—'} ms · ${vipS.loss_pct ?? 0}%` : '— ms · 0%');
  if ($('#bp-vip-down')) setTxt('#bp-vip-down', vipS ? fmtBytes(vipS.down_bytes || 0) : '0 B');
  if ($('#bp-vip-up')) setTxt('#bp-vip-up', vipS ? fmtBytes(vipS.up_bytes || 0) : '0 B');
  if ($('#bp-vip-ports')) {
    const ports = S.rules?.ports || [];
    const portsFull = ports.length ? ports.join(',') : '123,3478,5349';
    setTxt('#bp-vip-ports', ports.length > 3 ? `${ports.slice(0, 2).join(',')}+${ports.length - 2}埠` : portsFull);
    setTitle('#bp-vip-ports', portsFull);
  }
  if ($('#bp-vip-quota')) {
    setTxt('#bp-vip-quota', vipS ? `${fmtRateCompact(vipS.peak || 0)}峰·${vipS.slots ?? 0}槽` : '<50MB 優先');
  }
  if ($('#bp-vip-dot')) {
    setCls('#bp-vip-dot', `run-dot ${vipS && vipS.healthy ? (liveFlow.vipBps > 400 ? 'red' : 'off') : 'off'}`);
  }
  setTxt('#bp-vip-st', vipS && vipS.healthy
    ? (liveFlow.vipBps > 32 ? 'vip active' : 'vip pinned (idle)')
    : 'standby');
  setTxt('#bp-vip-desc', vipS
    ? `token ${vipTokPct}% · ${vipS.slots ?? 0} slots`
    : 'auto selecting lowest RTT strand...');

  // Tier 2 · Branch 1: TW-HOME Mihomo + MPTCP + Zashboard
  const mihomoOk = !!st.tunnel?.running;
  const tunShareReal = mihomoOk ? liveFlow.tunShare : 0;
  const tunShareBar = (mihomoOk && liveFlow.tunPkts > 0) ? Math.max(0.08, tunShareReal) : 0;
  const tunSharePct = Math.round(tunShareReal * 100);
  setTxt('#bp-tun-rate', mihomoOk ? fmtRate(liveFlow.tunBps).full : '0 bps');
  renderSegMeter($('#bp-tun-meter'), tunShareBar, 10, mihomoOk ? 'mint' : 'amber');
  setTxt('#bp-tun-pct', `${tunSharePct}% 流佔比`);
  setTxt('#bp-tun-desc', tun?.tw_home || tun?.selected || 'TW-HOME');
  setTxt('#bp-tun-bytes', fmtBytes(liveFlow.tunBytes));
  setTxt('#bp-tun-pkts', liveFlow.tunPkts >= 1e6
    ? `${(liveFlow.tunPkts / 1e6).toFixed(2)}M pkts`
    : (liveFlow.tunPkts >= 1000 ? `${(liveFlow.tunPkts / 1000).toFixed(1)}k pkts` : `${liveFlow.tunPkts} pkts`));
  const eps = st.mptcp?.endpoints || [];
  setTxt('#bp-tun-mptcp', st.mptcp?.enabled ? `${st.mptcp.subflows} sub · ${eps.length} ep` : 'single-path');
  const epEl = $('#bp-tun-eps');
  if (epEl) {
    const epFull = eps.length ? eps.map(e => e.dev).join(',') : '0 ep';
    setTxt(epEl, eps.length > 4
      ? `${eps.slice(0, 4).map(e => e.dev).join(',')}+${eps.length - 4}`
      : epFull);
    setTitle(epEl, epFull);
  }
  setTxt('#bp-tun-relays', `${st.tunnel?.relays ?? 0} nodes`);
  const devGroups = Array.isArray(tun?.groups) ? tun.groups : [];
  let routeSummary = '—';
  if (devGroups.length) {
    const counts = new Map();
    for (const g of devGroups) {
      const sel = g.now || 'TW-HOME';
      counts.set(sel, (counts.get(sel) || 0) + 1);
    }
    routeSummary = Array.from(counts.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 2)
      .map(([k, n]) => `${n}台→${k}`)
      .join(' · ');
    if (counts.size > 2) routeSummary += ` (+${counts.size - 2})`;
  } else if (tun?.tw_home) {
    routeSummary = `TW-HOME→${tun.tw_home}`;
  }
  setTxt('#bp-tun-auto', routeSummary);
  setTitle('#bp-tun-auto', devGroups.map(g => `${g.group_name}: ${g.now}`).join('\n') || routeSummary);
  setTxt('#bp-tun-canary', canaryMs > 0 ? `${canaryMs} ms · ${canaryFails}f` : '— ms');
  setTxt('#bp-tun-meta', st.tunnel?.fail_open ? 'fail-open' : 'fail-closed');
  const relayListEl = $('#bp-tun-relay-list');
  if (relayListEl) {
    const relays = Array.isArray(tun?.relays) ? tun.relays : [];
    const activeName = tun?.tw_home || tun?.selected || '';
    const valid = relays.filter(r => r && r.name && (r.delay || 0) > 0).sort((a, b) => a.delay - b.delay);
    const picked = [];
    const activeItem = relays.find(r => r && r.name === activeName);
    if (activeItem) picked.push(activeItem);
    for (const r of valid) {
      if (picked.length >= 3) break;
      if (!picked.some(x => x.name === r.name)) picked.push(r);
    }
    if (!picked.length) {
      for (const r of relays.slice(0, 3)) if (r && r.name) picked.push(r);
    }
    const relaySig = picked.length
      ? `${activeName}|` + picked.map(r => `${r.name}:${r.delay || 0}:${r.type || ''}`).join(';')
      : `empty:${mihomoOk ? 1 : 0}`;
    if (relayListEl.dataset.sig !== relaySig) {
      relayListEl.dataset.sig = relaySig;
      const rFrag = document.createDocumentFragment();
      if (picked.length) {
        for (const r of picked) {
          const isAct = activeName && r.name === activeName;
          const d = r.delay || 0;
          const latCls = d > 0 ? (d <= 220 ? 'c-mint' : (d <= 500 ? 'c-amber' : 'c-crimson')) : 'c-muted';
          rFrag.appendChild(el('div', { class: 'relay-mini-row' },
            el('span', { class: isAct ? 'c-mint' : 'c-sec', style: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', minWidth: '0' } },
              isAct ? `▸ ${r.name}` : r.name
            ),
            el('span', { class: latCls, style: { flexShrink: '0', fontWeight: '600', fontVariantNumeric: 'tabular-nums' } },
              d > 0 ? `${d}ms` : (r.type || '—')
            )
          ));
        }
      } else {
        rFrag.appendChild(el('div', { class: 'relay-mini-row' },
          el('span', { class: 'c-muted' }, mihomoOk ? '等待節點延遲探測...' : 'Mihomo 隧道未啟動'),
          el('span', { class: 'c-dim' }, '—')
        ));
        for (let pad = 0; pad < 2; pad++) {
          rFrag.appendChild(el('div', { class: 'relay-mini-row' },
            el('span', { class: 'c-dim' }, '—'),
            el('span', { class: 'c-dim' }, '—')
          ));
        }
      }
      relayListEl.innerHTML = '';
      relayListEl.appendChild(rFrag);
    }
  }
  setCls('#bp-tun-dot', `run-dot ${mihomoOk ? 'mint' : 'amber'}`);
  const tunSt = $('#bp-tun-st');
  if (tunSt) {
    setTxt(tunSt, mihomoOk ? (canaryMs > 0 ? `canary ${canaryMs} ms ok` : 'cage encrypted') : 'offline / direct');
    setCls(tunSt, mihomoOk ? 'c-mint' : 'c-amber');
  }
  const zBtn = $('#zashboard-link');
  if (zBtn) {
    const nextHref = tun?.dashboard || `http://${st.lan_ip || location.hostname || '192.168.16.1'}:9090/ui/`;
    if (zBtn.getAttribute('href') !== nextHref) zBtn.href = nextHref;
  }

  // Tier 2 · Branch 2: Domestic Direct + Burst-Harvest
  const nTotal = Math.max(1, st.strand_count || 21);
  const faultCnt = strands.length ? strands.filter(s => !s.healthy).length : Math.max(0, nTotal - (st.healthy_count ?? 0));
  const directShare = Math.max(0, 1 - tunShareReal - vShareReal);
  const directPct = Math.max(0, 100 - tunSharePct - vSharePct);
  const weaveRate = Math.max(liveFlow.domBps, Math.max(0, totalRate - liveFlow.vipBps));
  setTxt('#bp-dom-rate', fmtRate(weaveRate).full);
  renderSegMeter($('#bp-dom-meter'), directShare, 10, 'blue');
  setTxt('#bp-dom-pct', `${w.charged_count ?? 0}/${nH} 滿桶`);
  setTxt('#bp-dom-share', `${directPct}% 流佔比`);
  renderMiniSpectrum(strands);
  setTxt('#bp-dom-slots', `${w.slots ?? 126} (${w.affinity || 'flow'})`);
  const domByteCompact = fmtBytes(liveFlow.domBytes).replace(/\s+/g, '');
  const domPktCompact = liveFlow.domPkts >= 1e6 ? `${(liveFlow.domPkts / 1e6).toFixed(1)}M` : `${Math.round(liveFlow.domPkts / 1000)}k`;
  setTxt('#bp-dom-direct', `${domByteCompact}·${domPktCompact}`);
  setTxt('#bp-dom-probe', `${w.interval ?? 2}s / ${st.settings?.['strands.probe_interval'] ?? 45}s`);
  setTxt('#bp-dom-buckets', `${w.charged_count ?? 0}滿/${w.depleted_count ?? 0}耗/${w.cooling_count ?? 0}冷`);
  setTxt('#bp-dom-vip', w.vip_dev ? `${w.vip_dev} (#${w.vip_id ?? '—'})` : 'auto');
  const healthyStrands = strands.filter(s => s.healthy && (s.ttfb_ms || 0) > 0);
  const meanRtt = healthyStrands.length
    ? Math.round(healthyStrands.reduce((a, s) => a + s.ttfb_ms, 0) / healthyStrands.length)
    : null;
  const peakStrandBps = strands.length ? Math.max(...strands.map(s => s.peak || (s.now ?? s.rate ?? 0))) : 0;
  setTxt('#bp-dom-rtt', `${meanRtt != null ? `${meanRtt}ms` : '—ms'}·${fmtRateCompact(peakStrandBps)}`);
  const bestS = healthyStrands.length
    ? healthyStrands.reduce((best, s) => (s.ttfb_ms < best.ttfb_ms ? s : best), healthyStrands[0])
    : null;
  setTxt('#bp-dom-best', bestS
    ? `${bestS.dev} ${bestS.ttfb_ms}ms · ${faultCnt}故障`
    : `${faultCnt}/${nTotal}故障`);
  const avgTok = strands.length
    ? Math.round(strands.reduce((a, s) => a + (s.tokens_pct ?? 100), 0) / strands.length)
    : 100;
  setTxt('#bp-dom-toks', `均令牌 ${avgTok}%`);
  const coolCnt = (w.cooling_count || 0) + (w.depleted_count || 0);
  setTxt('#bp-dom-st', coolCnt > 0 ? `${w.charged_count ?? 0}/${nH} 滿·${coolCnt}冷` : `${w.charged_count ?? 0}/${nH} 滿桶`);
  setTxt('#bp-dom-desc', `直連 ${domByteCompact} · 均${meanRtt != null ? `${meanRtt}ms` : '—'}`);

  // Tier 3: Stage 3 Full-Height HTB QoS + 21-Uplink Egress Unified Segmented Meters
  const setSegMeter = (sel, ratio, count, colorName, compact = false, active = false) => {
    const node = $(sel);
    if (!node) return;
    renderSegMeter(node, ratio, count, colorName, compact);
    const want = !!active;
    if (node.classList.contains('active') !== want) node.classList.toggle('active', want);
  };

  setTxt('#bp-qos-meta', `MSS ${st.settings?.['main.mss'] ?? 1440}`);
  const qosDomBps = Math.max(liveFlow.domBps, Math.max(0, totalRate - liveFlow.vipBps - liveFlow.tunBps));
  const qosSumBps = liveFlow.vipBps + liveFlow.tunBps + qosDomBps;
  const qosTotBps = Math.max(1, qosSumBps);
  const shareRatio = (bps) => (bps > 0 ? Math.max(1 / 14, bps / qosTotBps) : 0);

  setTxt('#bp-qos-rate', fmtRate(qosSumBps).full);
  setTxt('#bp-qos-10-rate', fmtRate(liveFlow.vipBps).full);
  setTxt('#bp-qos-20-rate', fmtRate(liveFlow.tunBps).full);
  setTxt('#bp-qos-30-rate', fmtRate(qosDomBps).full);
  setSegMeter('#bp-qos-10-bar', shareRatio(liveFlow.vipBps), 14, 'red',  false, liveFlow.vipBps > 400);
  setSegMeter('#bp-qos-20-bar', shareRatio(liveFlow.tunBps), 14, 'mint', false, liveFlow.tunBps > 400);
  setSegMeter('#bp-qos-30-bar', shareRatio(qosDomBps),       14, 'blue', false, qosDomBps > 400);

  const paintQosBandHeat = (sel, baseRgb, bps) => {
    const chip = $(sel);
    if (!chip) return;
    const ratio = bps > 32
      ? Math.min(1, Math.max(0.18, 0.16 + (bps / qosTotBps) * 0.55 + Math.min(0.45, Math.log10(1 + ((bps * 8) / 1e6) * 7) * 0.45)))
      : 0.04;
    const q = `${baseRgb}:${Math.round(ratio * 180)}`;
    if (chip._lastQ === q) return;
    chip._lastQ = q;
    const sat = 0.22 + 0.78 * Math.pow(ratio, 0.8);
    setVar(chip, '--qb-rgb', desatObsidianRgb(baseRgb, sat));
    setVar(chip, '--qb-fill', (0.06 + 0.18 * ratio).toFixed(3));
    setVar(chip, '--qb-inset-a', (0.06 + 0.18 * ratio).toFixed(3));
    setVar(chip, '--qb-bdr-a', (0.20 + 0.58 * ratio).toFixed(2));
    setVar(chip, '--qb-glow-blur', `${Math.round(4 + 14 * ratio)}px`);
    setVar(chip, '--qb-glow-a', (0.03 + 0.24 * ratio).toFixed(2));
  };
  paintQosBandHeat('#bp-qos-10', '242, 90, 90',   liveFlow.vipBps);
  paintQosBandHeat('#bp-qos-20', '87, 209, 146',  liveFlow.tunBps);
  paintQosBandHeat('#bp-qos-30', '100, 174, 245', qosDomBps);

  const ewmaDown = st.rate_ewma ?? st.rate ?? 0;
  const ewmaUp = st.rate_up_ewma ?? st.rate_up ?? 0;
  const ewmaMbps = ((ewmaDown + ewmaUp) * 8) / 1e6;
  setTxt('#bp-qos-tx-txt', `↑ ${fmtRateCompact(ewmaUp)} · ↓ ${fmtRateCompact(ewmaDown)}`);
  const ewmaRatio = ewmaMbps > 0 ? Math.min(1, Math.max(1 / 18, Math.log10(1 + ewmaMbps * 3.5) * 0.44)) : 0;
  setSegMeter('#bp-qos-tx-bar', ewmaRatio, 18, 'spectrum', false, ewmaMbps > 0.02);
  setTxt('#bp-qos-mss-kv', `SYN MSS ${st.settings?.['main.mss'] ?? 1440}`);
  setTxt('#bp-qos-st', `${liveFlow.vipBps > 400 ? '1:10+20+30' : '1:20+30'} shaping`);
  setTxt('#bp-qos-foot', `MSS ${st.settings?.['main.mss'] ?? 1440} · 8MB 相變界`);

  setTxt('#bp-up-rate', fmtRate(totalRate).full);
  const upSec = st.sys?.uptime || 0;
  const upDays = Math.floor(upSec / 86400);
  const upHours = Math.floor((upSec % 86400) / 3600);
  setTxt('#bp-up-uptime', upSec > 0 ? `up ${upDays}d ${upHours}h` : 'up —');

  setTxt('#bp-up-pool-txt', `${w.charged_count ?? 0}/${nTotal} charged · ${st.healthy_count ?? 0} up`);
  setSegMeter('#bp-up-pool-bar', (w.charged_count ?? 0) / nTotal, 16, 'spectrum', false, (w.charged_count ?? 0) > 0 && totalRate > 2000);

  setTxt('#bp-up-ct-txt', `${ctCount.toLocaleString()} / ${ctMax.toLocaleString()}`);
  const ctRatio = ctCount > 0 ? Math.max(1 / 16, ctCount / ctMax) : 0;
  setSegMeter('#bp-up-ct-bar', ctRatio, 16, ctRatio > 0.8 ? 'amber' : 'spectrum', false, ctCount > 0);

  const memMb = Math.round((st.sys?.mem_available_kb || 0) / 1024);
  const load1 = st.sys?.load1 ?? 0;
  setTxt('#bp-up-mem-txt', `${memMb} MB free · load ${load1}`);
  setSegMeter('#bp-up-mem-bar', Math.max(1 / 16, Math.min(1, memMb / 256)), 16, (load1 > 2.0 || memMb < 48) ? 'amber' : 'spectrum', false, load1 > 0.5);

  setTxt('#bp-up-down', fmtBytes(st.down_bytes || 0));
  setTxt('#bp-up-up', fmtBytes(st.up_bytes || 0));
  const upHealthEl = $('#bp-up-health');
  if (upHealthEl) {
    setTxt(upHealthEl, `${st.healthy_count ?? 0}/${nTotal} · ${faultCnt}故障`);
    setCls(upHealthEl, faultCnt > 0 ? 'v c-crimson' : 'v');
  }
  setTxt('#bp-up-mptcp', st.mptcp?.enabled
    ? `${st.mptcp.subflows}sub · ${eps.length}ep`
    : 'single-path');
  const vEl = $('#bp-verify-summary');
  if (vEl) {
    const vText = st.ok ? `${nTotal}/${nTotal} ok` : `異常:${(st.fail || []).join(',')}`;
    setTxt(vEl, vText);
    setTitle(vEl, st.ok ? `${nTotal}/${nTotal} kernel ok` : vText);
    setCls(vEl, st.ok ? 'v c-bright' : 'v c-crimson');
  }
  setTxt('#bp-up-ver', `PRISM ${st.version || UI_VERSION}`);
  setTxt('#bp-up-sync', recTs ? fmtClock(recTs) : 'live');

  ensureBlueprintResizeObserver();
  renderWaveguidesCanvas();
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
    cp.appendChild(el('div', { class: 'c-muted', style: { padding: '12px 0' } }, '需點擊右上角「管理登入」以調整 UCI 核心參數'));
    return;
  }
  const vals = S.config?.values || S.status?.settings || {};
  const ls = S.status?.led_state || {};
  const sig = EDITABLE_SPECS.map(s => `${s.key}=${vals[s.key]}`).join('|');
  if (cp.dataset.sig !== sig) {
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
      } else if (spec.type === 'select') {
        const sel = el('select', {
          class: 'bp-input',
          style: { maxWidth: '215px', textAlign: 'left' },
          onChange: () => write('configure', { set: { [spec.key]: sel.value } }, `${spec.label} -> ${sel.value}`)
        }, ...(spec.options || []).map(opt => el('option', {
          value: opt.value,
          selected: String(v ?? '') === String(opt.value)
        }, opt.label)));
        control = sel;
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
    const dot = (id) => el('span', {
      id,
      style: {
        display: 'inline-block', width: '10px', height: '10px', borderRadius: '50%',
        background: '#111827', border: '1px solid rgba(255,255,255,0.22)',
        transition: 'background .25s ease, box-shadow .25s ease'
      }
    });
    cp.appendChild(el('div', { class: 'cfg-row' },
      el('div', {},
        el('div', { class: 'c-bright', style: { display: 'flex', alignItems: 'center', gap: '7px' } },
          dot('led-preview-dot-s'),
          dot('led-preview-dot-n'),
          el('span', { id: 'led-preview-lbl' }, 'WS2812B 實時燈效')
        ),
        el('div', { class: 'c-muted', style: { fontSize: '10.5px' } }, '執行 6 秒 7 波長暗面稜鏡掃描測試秀')
      ),
      el('button', {
        type: 'button',
        class: 'btn-cmd primary',
        onClick: () => write('led_demo', {}, '已啟動 6 秒光譜試燈秀')
      }, '光譜試燈 Demo')
    ));
  }
  const paintDot = (id, hex, title) => {
    const d = $(id);
    if (!d) return;
    d.title = title;
    d.style.background = hex || '#111827';
    d.style.boxShadow = hex && hex !== '#000000' ? `0 0 8px ${hex}` : 'none';
  };
  paintDot('#led-preview-dot-s', ls.status_hex, `Status ${ls.status_hex || ''}`);
  paintDot('#led-preview-dot-n', ls.network_hex, `Network ${ls.network_hex || ''}`);
  setTxt('#led-preview-lbl', `WS2812B 實時燈效 (${ls.alert || 'ok'})`);
}
