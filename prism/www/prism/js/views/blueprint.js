/* ============================================================================
 * PRISM — View 02: Kernel Routing Architecture, Proportional Classify & Ribbons
 * ============================================================================ */

import { S, LOCKED_SPECS, EDITABLE_SPECS, spectralColor, fmtRate, fmtBytes } from '../state.js?v=5.5.0';
import { $, $$, el, renderSegMeter, renderSessionLog } from '../dom.js?v=5.5.0';
import { write, call } from '../api.js?v=5.5.0';

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

function mixWhiteRgb(rgb, whiteMix = 0.60) {
  const parts = String(rgb).split(',').map(v => Number(v.trim()) || 0);
  const mix = (c) => Math.round(c + (255 - c) * whiteMix);
  return `${mix(parts[0])}, ${mix(parts[1])}, ${mix(parts[2])}`;
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

function drawFeatheredRect(ctx, x0, y0, x1, y1, nx, ny, dist, rgb, alpha) {
  if (alpha <= 0.004 || dist <= 0.5) return;
  const mx = (x0 + x1) * 0.5;
  const my = (y0 + y1) * 0.5;
  const grad = ctx.createLinearGradient(mx, my, mx + nx * dist, my + ny * dist);
  grad.addColorStop(0, `rgba(${rgb}, ${alpha.toFixed(3)})`);
  grad.addColorStop(0.32, `rgba(${rgb}, ${(alpha * 0.42).toFixed(3)})`);
  grad.addColorStop(0.68, `rgba(${rgb}, ${(alpha * 0.12).toFixed(3)})`);
  grad.addColorStop(1, `rgba(${rgb}, 0)`);
  ctx.fillStyle = grad;
  ctx.beginPath();
  ctx.moveTo(x0, y0);
  ctx.lineTo(x1, y1);
  ctx.lineTo(x1 + nx * dist, y1 + ny * dist);
  ctx.lineTo(x0 + nx * dist, y0 + ny * dist);
  ctx.closePath();
  ctx.fill();
}

function drawLinkTag(ctx, x, y, text, rgb) {
  ctx.save();
  ctx.font = '600 9.5px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace';
  const tw = ctx.measureText(text).width;
  const bx = x - tw * 0.5 - 5;
  const bw = tw + 10;
  ctx.fillStyle = 'rgba(4, 6, 12, 0.90)';
  ctx.fillRect(bx, y - 8, bw, 15);
  if (rgb === 'spectrum') {
    const g = ctx.createLinearGradient(bx, y, bx + bw, y);
    for (let i = 0; i < 6; i++) g.addColorStop(i / 5, `rgba(${spectralColor(i, 6).rgb}, 0.78)`);
    ctx.strokeStyle = g;
  } else {
    ctx.strokeStyle = `rgba(${rgb}, 0.48)`;
  }
  ctx.lineWidth = 1;
  ctx.strokeRect(bx, y - 8, bw, 15);
  ctx.fillStyle = rgb === 'spectrum'
    ? 'rgba(244, 247, 252, 0.96)'
    : `rgba(${mixWhiteRgb(rgb, 0.40)}, 0.94)`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(text, x, y);
  ctx.restore();
}

function fillRibbonQuad(ctx, x0, y0, x1, y1, nx, ny, o0, o1, fillStyle) {
  ctx.fillStyle = fillStyle;
  ctx.beginPath();
  ctx.moveTo(x0 + nx * o0, y0 + ny * o0);
  ctx.lineTo(x1 + nx * o0, y1 + ny * o0);
  ctx.lineTo(x1 + nx * o1, y1 + ny * o1);
  ctx.lineTo(x0 + nx * o1, y0 + ny * o1);
  ctx.closePath();
  ctx.fill();
}

function makeFlowShimmerGradient(ctx, x0, y0, x1, y1, st, phaseOffset, rgb, maxAlpha) {
  const p = (st.phase + phaseOffset) % 1.0;
  const grad = ctx.createLinearGradient(x0, y0, x1, y1);
  for (let i = 0; i <= 16; i++) {
    const u = i / 16;
    const d1 = Math.abs((((u - p) % 1 + 1.5) % 1) - 0.5);
    const wave = Math.exp(-Math.pow(d1 / 0.16, 2));
    grad.addColorStop(u, `rgba(${rgb}, ${Math.min(maxAlpha, wave * st.glow * maxAlpha).toFixed(3)})`);
  }
  return grad;
}

// Unified Figure-3 Straight Optical Ribbon: rich luminous band + feathered atmospheric aura (Zero curves, zero stark white core)
function drawStraightOpticalRibbon(ctx, x0, y0, x1, y1, rgb, st, phaseOffset = 0, tag = '') {
  const dx = x1 - x0;
  const dy = y1 - y0;
  const len = Math.hypot(dx, dy);
  if (len < 2) return;

  const ux = dx / len;
  const uy = dy / len;
  const nx = -uy;
  const ny = ux;
  const g = st.glow;
  const active = st.vel > 0.01;
  const isSpec = rgb === 'spectrum';

  ctx.save();
  if (isSpec) {
    // 7 parallel dispersed rainbow strands matching Figure-3 multi-wavelength band
    const totalHalf = Math.max(4.0, st.width * 1.85);
    const nStripes = 7;
    const bandAlpha = 0.56 + g * 0.34;
    const outerReach = 9 + g * 10;
    const outerAlpha = 0.14 + g * 0.18;

    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    drawFeatheredRect(
      ctx,
      x0 - nx * totalHalf, y0 - ny * totalHalf,
      x1 - nx * totalHalf, y1 - ny * totalHalf,
      -nx, -ny, outerReach, spectralColor(0, nStripes).rgb, outerAlpha
    );
    drawFeatheredRect(
      ctx,
      x0 + nx * totalHalf, y0 + ny * totalHalf,
      x1 + nx * totalHalf, y1 + ny * totalHalf,
      nx, ny, outerReach, spectralColor(nStripes - 1, nStripes).rgb, outerAlpha
    );
    ctx.restore();

    for (let i = 0; i < nStripes; i++) {
      const f0 = -1 + (2 * i) / nStripes;
      const f1 = -1 + (2 * (i + 1)) / nStripes;
      fillRibbonQuad(
        ctx, x0, y0, x1, y1, nx, ny,
        f0 * totalHalf - 0.18, f1 * totalHalf + 0.18,
        `rgba(${spectralColor(i, nStripes).rgb}, ${bandAlpha.toFixed(3)})`
      );
    }

    if (active && g > 0.10) {
      ctx.save();
      ctx.globalCompositeOperation = 'lighter';
      fillRibbonQuad(
        ctx, x0, y0, x1, y1, nx, ny,
        -totalHalf * 0.72, totalHalf * 0.72,
        makeFlowShimmerGradient(ctx, x0, y0, x1, y1, st, phaseOffset, '255, 255, 255', 0.18)
      );
      ctx.restore();
    }
  } else {
    // Monochrome Figure-3 luminous band (rich chromatic core + smooth perpendicular feather aura)
    const bandHalf = 1.9 + g * 1.15;
    const bloomReach = 10 + g * 11;
    const edgeAlpha = 0.14 + g * 0.21;
    const bodyAlpha = 0.62 + g * 0.30;

    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    drawFeatheredRect(
      ctx,
      x0 + nx * bandHalf, y0 + ny * bandHalf,
      x1 + nx * bandHalf, y1 + ny * bandHalf,
      nx, ny, bloomReach, rgb, edgeAlpha
    );
    drawFeatheredRect(
      ctx,
      x0 - nx * bandHalf, y0 - ny * bandHalf,
      x1 - nx * bandHalf, y1 - ny * bandHalf,
      -nx, -ny, bloomReach, rgb, edgeAlpha
    );
    ctx.restore();

    fillRibbonQuad(ctx, x0, y0, x1, y1, nx, ny, -bandHalf, bandHalf, `rgba(${rgb}, ${bodyAlpha.toFixed(3)})`);

    // Gentle pure-color inner boost (stays saturated color matching Figure 3)
    const innerHalf = Math.max(0.8, bandHalf * 0.46);
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    fillRibbonQuad(
      ctx, x0, y0, x1, y1, nx, ny, -innerHalf, innerHalf,
      `rgba(${mixWhiteRgb(rgb, 0.24)}, ${(0.22 + g * 0.24).toFixed(3)})`
    );

    if (active && g > 0.10) {
      fillRibbonQuad(
        ctx, x0, y0, x1, y1, nx, ny, -bandHalf, bandHalf,
        makeFlowShimmerGradient(ctx, x0, y0, x1, y1, st, phaseOffset, mixWhiteRgb(rgb, 0.38), 0.24)
      );
    }
    ctx.restore();
  }
  ctx.restore();

  if (tag && len >= 22) {
    drawLinkTag(ctx, (x0 + x1) * 0.5, (y0 + y1) * 0.5, tag, rgb);
  }
}

function drawFocalPrismAndFan(ctx, W, H, ing, vip, tun, dom) {
  const gapW = Math.min(vip.x, tun.x, dom.x) - ing.right;
  if (gapW < 24) return;

  const focalX = ing.right + gapW * 0.44;
  const focalY = tun.cy;
  const side = Math.max(28, Math.min(48, gapW * 0.56));
  const triH = (side * Math.sqrt(3)) / 2;

  const topX = focalX;
  const topY = focalY - triH * 0.56;
  const leftX = focalX - side * 0.5;
  const leftY = topY + triH;
  const rightX = focalX + side * 0.5;
  const rightY = topY + triH;

  // Left incident entry & right 1->3 exit points on sloped crystal faces
  const entryX = topX + (leftX - topX) * 0.48;
  const entryY = topY + (leftY - topY) * 0.48;
  const ingStartY = Math.max(ing.y + 20, Math.min(ing.bottom - 20, entryY + 12));

  const exits = [
    { t: 0.25, tx: vip.x + 2, ty: vip.cy, rgb: '100, 174, 245', st: waveState[0], phase: 0.00 },
    { t: 0.50, tx: tun.x + 2, ty: tun.cy, rgb: '170, 142, 240', st: waveState[1], phase: 0.16 },
    { t: 0.75, tx: dom.x + 2, ty: dom.cy, rgb: '87, 209, 146',  st: waveState[2], phase: 0.32 },
  ].map((e) => {
    const ex = topX + (rightX - topX) * e.t;
    const ey = topY + (rightY - topY) * e.t;
    const dx = e.tx - ex;
    const dy = e.ty - ey;
    const l = Math.hypot(dx, dy) || 1;
    return { ...e, ex, ey, bx: ex - (dx / l) * 32, by: ey - (dy / l) * 32 };
  });

  // 1. Straight Ingress -> Focal Prism Left Bevel (clipped flush to left slope)
  const inDx = entryX - (ing.right - 2);
  const inDy = entryY - ingStartY;
  const inLen = Math.hypot(inDx, inDy) || 1;
  ctx.save();
  clipHalfPlane(ctx, topX, topY, leftX, leftY, -1, W, H);
  drawStraightOpticalRibbon(
    ctx,
    ing.right - 2, ingStartY,
    entryX + (inDx / inLen) * 32, entryY + (inDy / inLen) * 32,
    'spectrum', waveState[4], 0.05
  );
  ctx.restore();

  // 2. Straight 1->3 Dispersed Branches (clipped flush to right slope)
  ctx.save();
  clipHalfPlane(ctx, topX, topY, rightX, rightY, 1, W, H);
  for (const e of exits) {
    drawStraightOpticalRibbon(ctx, e.bx, e.by, e.tx, e.ty, e.rgb, e.st, e.phase);
  }
  ctx.restore();

  // 3. Focal Equilateral Crystal Prism (Dark glass + subtle internal scatter wedge + luminous edge)
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

  const wGrad = ctx.createLinearGradient(entryX, entryY, exits[1].ex, exits[1].ey);
  wGrad.addColorStop(0.00, 'rgba(244, 249, 255, 0.72)');
  wGrad.addColorStop(0.45, 'rgba(195, 222, 252, 0.24)');
  wGrad.addColorStop(1.00, 'rgba(155, 190, 232, 0.04)');
  ctx.fillStyle = wGrad;
  ctx.beginPath();
  ctx.moveTo(entryX, entryY - 3);
  ctx.lineTo(exits[0].ex, exits[0].ey);
  ctx.lineTo(exits[2].ex, exits[2].ey);
  ctx.lineTo(entryX, entryY + 3);
  ctx.closePath();
  ctx.fill();
  ctx.restore();

  ctx.save();
  ctx.shadowColor = 'rgba(180, 214, 250, 0.35)';
  ctx.shadowBlur = 9;
  ctx.strokeStyle = 'rgba(232, 242, 255, 0.90)';
  ctx.lineWidth = 1.6;
  ctx.beginPath();
  ctx.moveTo(topX, topY);
  ctx.lineTo(rightX, rightY);
  ctx.lineTo(leftX, leftY);
  ctx.closePath();
  ctx.stroke();
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
  const q10 = relBox($('#bp-qos-10'), rect);
  const q20 = relBox($('#bp-qos-20'), rect);
  const q30 = relBox($('#bp-qos-30'), rect);
  const up  = relBox($('#bp-card-uplink'), rect);
  if (!pre || !ing || !vip || !tun || !dom || !qos || !up) return;

  const ctx = canvas.getContext('2d');
  ctx.save();
  ctx.scale(dpr, dpr);
  ctx.clearRect(0, 0, rect.width, rect.height);

  // Stage 1 Vertical Conduit: Pre-Gate -> Nftables Classify Engine
  if (ing.y - pre.bottom > 6) {
    drawStraightOpticalRibbon(ctx, pre.cx, pre.bottom - 2, ing.cx, ing.y + 2, 'spectrum', waveState[4], 0.00, 'QUIC→TCP');
  }

  // Inter-Engine Cross-Feed: TW-HOME (TProxy weave_out) -> Burst-Harvest Pool
  if (dom.y - tun.bottom > 6) {
    drawStraightOpticalRibbon(ctx, tun.cx, tun.bottom - 2, dom.cx, dom.y + 2, '170, 142, 240', waveState[3], 0.12, 'weave_out');
  }

  // Stage 3 Vertical Convergence: 3-Band HTB QoS -> 21-Uplink NAT & Egress
  if (up.y - qos.bottom > 6) {
    drawStraightOpticalRibbon(ctx, qos.cx, qos.bottom - 2, up.cx, up.y + 2, 'spectrum', waveState[4], 0.30, '21 WAN NAT');
  }

  // Horizontal/Straight Optical Channels + Focal Prism (1 -> 3 Dispersion)
  if (vip.x - ing.right > 24) {
    drawFocalPrismAndFan(ctx, rect.width, rect.height, ing, vip, tun, dom);

    if (qos.x - tun.right > 16) {
      const y10 = q10 ? q10.cy : (qos.y + qos.h * 0.30);
      const y20 = q20 ? q20.cy : (qos.y + qos.h * 0.55);
      const y30 = q30 ? q30.cy : (qos.y + qos.h * 0.80);

      drawStraightOpticalRibbon(ctx, vip.right - 2, vip.cy, qos.x + 2, y10, '100, 174, 245', waveState[0], 0.24);
      drawStraightOpticalRibbon(ctx, tun.right - 2, tun.cy, qos.x + 2, y20, '170, 142, 240', waveState[1], 0.38);
      drawStraightOpticalRibbon(ctx, dom.right - 2, dom.cy, qos.x + 2, y30, '87, 209, 146',  waveState[2], 0.52);
    }
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
        el('span', { class: pkts > 0 ? 'c-bright' : 'c-muted', style: { fontWeight: pkts > 0 ? '600' : '400', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', minWidth: '0' } }, label),
        el('span', { class: pkts > 0 ? textCls : 'c-muted', style: { fontVariantNumeric: 'tabular-nums', fontWeight: '600', whiteSpace: 'nowrap', fontSize: '9.5px' } }, `${pktTxt}·${pctTxt}`)
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
  renderSegMeter($('#bp-harvest-meter'), chargedRatio, 10, 'spectrum');
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

  // Tier 3: Stage 3 Full-Height HTB QoS + 21-Uplink Egress Telemetry & Meters
  const setMeter = (sel, pct, active) => {
    const node = $(sel);
    if (!node) return;
    node.style.width = `${Math.max(0, Math.min(100, pct)).toFixed(1)}%`;
    node.classList.toggle('active', !!active);
  };

  if ($('#bp-qos-meta')) $('#bp-qos-meta').textContent = `MSS ${st.settings?.['main.mss'] ?? 1440}`;
  const qosDomBps = Math.max(liveFlow.domBps, Math.max(0, totalRate - liveFlow.vipBps - liveFlow.tunBps));
  const qosTotBps = Math.max(1, liveFlow.vipBps + liveFlow.tunBps + qosDomBps);
  const shareBar = (bps) => (bps > 0 ? Math.max(6, (bps / qosTotBps) * 100) : 0);

  if ($('#bp-qos-10-rate')) $('#bp-qos-10-rate').textContent = fmtRate(liveFlow.vipBps).full;
  if ($('#bp-qos-20-rate')) $('#bp-qos-20-rate').textContent = fmtRate(liveFlow.tunBps).full;
  if ($('#bp-qos-30-rate')) $('#bp-qos-30-rate').textContent = fmtRate(qosDomBps).full;
  setMeter('#bp-qos-10-bar', shareBar(liveFlow.vipBps), liveFlow.vipBps > 400);
  setMeter('#bp-qos-20-bar', shareBar(liveFlow.tunBps), liveFlow.tunBps > 400);
  setMeter('#bp-qos-30-bar', shareBar(qosDomBps), qosDomBps > 400);

  const ewmaDown = st.rate_ewma ?? st.rate ?? 0;
  const ewmaUp = st.rate_up_ewma ?? st.rate_up ?? 0;
  const ewmaMbps = ((ewmaDown + ewmaUp) * 8) / 1e6;
  if ($('#bp-qos-tx-txt')) $('#bp-qos-tx-txt').textContent = `↑ ${fmtRate(ewmaUp).full} · ↓ ${fmtRate(ewmaDown).full}`;
  setMeter('#bp-qos-tx-bar', ewmaMbps > 0 ? Math.min(100, Math.max(6, Math.log10(1 + ewmaMbps * 3.5) * 44)) : 0, ewmaMbps > 0.02);

  const upSec = st.sys?.uptime || 0;
  const upDays = Math.floor(upSec / 86400);
  const upHours = Math.floor((upSec % 86400) / 3600);
  if ($('#bp-up-uptime')) $('#bp-up-uptime').textContent = upSec > 0 ? `up ${upDays}d ${upHours}h` : 'up —';

  const nTotal = Math.max(1, st.strand_count || 21);
  if ($('#bp-up-pool-txt')) $('#bp-up-pool-txt').textContent = `${w.charged_count ?? 0}/${nTotal} charged · ${st.healthy_count ?? 0} up`;
  setMeter('#bp-up-pool-bar', ((w.charged_count ?? 0) / nTotal) * 100, (w.charged_count ?? 0) > 0 && totalRate > 2000);

  const ctCount = st.sys?.conntrack?.count ?? 0;
  const ctMax = Math.max(1, st.sys?.conntrack?.max ?? 131072);
  if ($('#bp-up-ct-txt')) $('#bp-up-ct-txt').textContent = `${ctCount.toLocaleString()} / ${ctMax.toLocaleString()}`;
  setMeter('#bp-up-ct-bar', Math.max(ctCount > 0 ? 3 : 0, (ctCount / ctMax) * 100), ctCount > 0);

  const memMb = Math.round((st.sys?.mem_available_kb || 0) / 1024);
  const load1 = st.sys?.load1 ?? 0;
  if ($('#bp-up-mem-txt')) $('#bp-up-mem-txt').textContent = `${memMb} MB free · load ${load1}`;
  setMeter('#bp-up-mem-bar', Math.max(10, Math.min(100, (memMb / 256) * 100)), load1 > 0.5);

  $('#bp-verify-summary').textContent = st.ok
    ? `累計 ↓ ${fmtBytes(st.down_bytes)} · ↑ ${fmtBytes(st.up_bytes)} · ${nTotal}/${nTotal} kernel ok`
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
