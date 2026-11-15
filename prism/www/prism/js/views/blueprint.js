/* ============================================================================
 * PRISM — View 02: Kernel Routing Architecture, Proportional Classify & Ribbons
 * ============================================================================ */

import { S, LOCKED_SPECS, EDITABLE_SPECS, spectralColor, fmtRate, fmtBytes, fmtClock } from '../state.js?v=5.6.1';
import { $, $$, el, renderSegMeter, renderSessionLog } from '../dom.js?v=5.6.1';
import { write, call } from '../api.js?v=5.6.1';

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

function orthoStepPts(x0, y0, xTurn, y1, x1) {
  if (Math.abs(y1 - y0) < 2) {
    const ym = (y0 + y1) * 0.5;
    return [{ x: x0, y: ym }, { x: x1, y: ym }];
  }
  return [
    { x: x0, y: y0 },
    { x: xTurn, y: y0 },
    { x: xTurn, y: y1 },
    { x: x1, y: y1 },
  ];
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

// Smooth Fig-5 continuous perpendicular Gaussian glow + solid optical core (zero contour layering)
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
  const g = st.glow;
  const active = st.vel > 0.01;
  const makePerpGrad = (halfW) => ctx.createLinearGradient(
    mx - nx * halfW, my - ny * halfW,
    mx + nx * halfW, my + ny * halfW
  );

  ctx.save();
  if (rgb === 'spectrum') {
    const totalHalf = Math.max(3.6, st.width * 1.45);
    const auraHalf = totalHalf + (10.5 + g * 6.0) * auraScale;
    const redRgb = spectralColor(0, 7).rgb;
    const midRgb = spectralColor(3, 7).rgb;
    const vioRgb = spectralColor(6, 7).rgb;
    const auraA = 0.12 + g * 0.08;

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

    const bodyHalf = totalHalf + 0.9;
    const bandA = (0.76 + g * 0.18).toFixed(3);
    const specGrad = makePerpGrad(bodyHalf);
    specGrad.addColorStop(0.00, `rgba(${redRgb}, 0)`);
    for (let i = 0; i < 7; i++) {
      specGrad.addColorStop(0.10 + (i / 6) * 0.80, `rgba(${spectralColor(i, 7).rgb}, ${bandA})`);
    }
    specGrad.addColorStop(1.00, `rgba(${vioRgb}, 0)`);
    fillBeamQuad(ctx, x0, y0, x1, y1, nx, ny, bodyHalf, specGrad);

    if (active && g > 0.10) {
      ctx.save();
      ctx.globalCompositeOperation = 'lighter';
      const shim = makeFlowShimmerGradient(ctx, x0, y0, x1, y1, st, phaseOffset, '255, 255, 255', 0.16);
      fillBeamQuad(ctx, x0, y0, x1, y1, nx, ny, totalHalf * 0.85, shim);
      ctx.restore();
    }
  } else {
    const coreHalf = 1.65 + g * 0.88;
    const glowHalf = (11.0 + g * 7.2) * auraScale;
    const peakA = (0.14 + g * 0.10) * (0.72 + 0.28 * auraScale);

    const haloGrad = makePerpGrad(glowHalf);
    for (let k = 0; k <= 8; k++) {
      const u = k / 8;
      const t = (u - 0.5) * 2;
      const a = (k === 0 || k === 8) ? 0 : peakA * Math.exp(-(t * t) / 0.18);
      haloGrad.addColorStop(u, `rgba(${rgb}, ${a.toFixed(4)})`);
    }

    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    fillBeamQuad(ctx, x0, y0, x1, y1, nx, ny, glowHalf, haloGrad);
    ctx.restore();

    const bodyHalf = coreHalf + 0.9;
    const edgeA = (0.76 + g * 0.20).toFixed(3);
    const centerA = (0.94 + g * 0.05).toFixed(3);
    const bodyGrad = makePerpGrad(bodyHalf);
    bodyGrad.addColorStop(0.00, `rgba(${rgb}, 0)`);
    bodyGrad.addColorStop(0.24, `rgba(${rgb}, ${edgeA})`);
    bodyGrad.addColorStop(0.50, `rgba(${mixWhiteRgb(rgb, 0.40)}, ${centerA})`);
    bodyGrad.addColorStop(0.76, `rgba(${rgb}, ${edgeA})`);
    bodyGrad.addColorStop(1.00, `rgba(${rgb}, 0)`);
    fillBeamQuad(ctx, x0, y0, x1, y1, nx, ny, bodyHalf, bodyGrad);

    if (active && g > 0.10) {
      ctx.save();
      ctx.globalCompositeOperation = 'lighter';
      const shim = makeFlowShimmerGradient(
        ctx, x0, y0, x1, y1, st, phaseOffset, mixWhiteRgb(rgb, 0.45), 0.22
      );
      fillBeamQuad(ctx, x0, y0, x1, y1, nx, ny, coreHalf * 0.90, shim);
      ctx.restore();
    }
  }
  ctx.restore();
}

// 45-45-90 Total Internal Reflection Crystal Prism placed at each 90-degree beam bend
function drawRightAngleTurningPrism(ctx, prism) {
  const { x, y, inDir, outDir, rgb, glow, r } = prism;
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
  sheen.addColorStop(0.00, `rgba(${mixWhiteRgb(rgb, 0.55)}, ${(0.28 + glow * 0.26).toFixed(3)})`);
  sheen.addColorStop(0.65, `rgba(${rgb}, ${(0.08 + glow * 0.08).toFixed(3)})`);
  sheen.addColorStop(1.00, `rgba(${rgb}, 0)`);
  ctx.fillStyle = sheen;
  ctx.fillRect(x - r - 2, y - r - 2, r * 2 + 4, r * 2 + 4);
  ctx.restore();

  ctx.strokeStyle = 'rgba(210, 228, 252, 0.56)';
  ctx.lineWidth = 1.0;
  ctx.beginPath();
  ctx.moveTo(cX, cY);
  ctx.lineTo(aX, aY);
  ctx.lineTo(bX, bY);
  ctx.closePath();
  ctx.stroke();

  ctx.shadowColor = `rgba(${rgb}, 0.50)`;
  ctx.shadowBlur = 4;
  ctx.strokeStyle = `rgba(${mixWhiteRgb(rgb, 0.65)}, ${(0.72 + glow * 0.22).toFixed(3)})`;
  ctx.lineWidth = 1.25;
  ctx.beginPath();
  ctx.moveTo(aX, aY);
  ctx.lineTo(bX, bY);
  ctx.stroke();
  ctx.restore();
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

    if (i === 0 && opts.clipFirst) {
      ctx.save();
      opts.clipFirst(ctx);
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

function drawFocalPrismAndFan(ctx, W, H, ing, vip, tun, dom, prismsQueue) {
  const rightEdgeEnd = Math.min(vip.x, tun.x, dom.x);
  const gapW = rightEdgeEnd - ing.right;
  if (gapW < 30) return;

  const focalX = ing.right + gapW * 0.34;
  const focalY = Math.max(ing.y + 28, Math.min(ing.bottom - 28, tun.cy));
  const side = Math.max(28, Math.min(40, gapW * 0.35));
  const triH = (side * Math.sqrt(3)) / 2;

  const topX = focalX;
  const topY = focalY - triH * 0.56;
  const leftX = focalX - side * 0.5;
  const leftY = topY + triH;
  const rightX = focalX + side * 0.5;
  const rightY = topY + triH;

  const tMid = (focalY - topY) / triH;
  const entryX = topX + (leftX - topX) * tMid;
  const entryY = focalY;

  const splitDy = Math.min(7.5, triH * 0.18);
  const splitBaseX = Math.max(rightX + 18, rightX + (rightEdgeEnd - rightX) * 0.48);

  const exits = [
    { dy: -splitDy, xTurn: splitBaseX - 6, tx: vip.x + 1, ty: vip.cy, rgb: '100, 174, 245', st: waveState[0], phase: 0.00 },
    { dy: 0,        xTurn: splitBaseX,     tx: tun.x + 1, ty: tun.cy, rgb: '170, 142, 240', st: waveState[1], phase: 0.16 },
    { dy: splitDy,  xTurn: splitBaseX + 6, tx: dom.x + 1, ty: dom.cy, rgb: '87, 209, 146',  st: waveState[2], phase: 0.32 },
  ].map((e) => {
    const ey = focalY + e.dy;
    const tOut = (ey - topY) / triH;
    const ex = topX + (rightX - topX) * tOut;
    return { ...e, ex, ey };
  });

  // 1. Strictly Straight Rainbow Ingress -> Focal Prism Left Bevel (locally clipped to left of bevel)
  const inPts = orthoStepPts(ing.right - 1, focalY, ing.right + (leftX - ing.right) * 0.42, focalY, entryX + 14);
  drawOrthoStepWithPrisms(ctx, inPts, 'spectrum', waveState[4], 0.05, prismsQueue, {
    clipFirst: (c) => clipHalfPlane(c, topX, topY, leftX, leftY, -1, W, H),
    prismRadius: 6
  });

  // 2. Strictly Horizontal/Vertical 1 -> 3 Dispersed Branches (clipFirst ONLY on horizontal prism stub!)
  for (const e of exits) {
    const branchPts = orthoStepPts(e.ex - 14, e.ey, e.xTurn, e.ty, e.tx);
    drawOrthoStepWithPrisms(ctx, branchPts, e.rgb, e.st, e.phase, prismsQueue, {
      clipFirst: (c) => clipHalfPlane(c, topX, topY, rightX, rightY, 1, W, H),
      auraScale: 0.78,
      prismRadius: 6
    });
  }

  // 3. Main Dispersion Crystal Prism (drawn crisp above ingress/exit beam stubs)
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

  const innerR = Math.max(12, Math.hypot(exits[1].ex - entryX, exits[1].ey - entryY) * 1.15);
  const wGrad = ctx.createRadialGradient(entryX, entryY, 0, entryX + innerR * 0.25, entryY, innerR);
  wGrad.addColorStop(0.00, 'rgba(244, 249, 255, 0.72)');
  wGrad.addColorStop(0.32, 'rgba(204, 226, 252, 0.28)');
  wGrad.addColorStop(0.68, 'rgba(165, 198, 238, 0.08)');
  wGrad.addColorStop(1.00, 'rgba(140, 175, 220, 0)');
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
  ctx.shadowColor = 'rgba(180, 214, 250, 0.28)';
  ctx.shadowBlur = 6;
  ctx.strokeStyle = 'rgba(232, 242, 255, 0.88)';
  ctx.lineWidth = 1.5;
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

  const prismsQueue = [];

  // Stage 1 Vertical Conduit: Pre-Gate -> Nftables Classify Engine
  if (ing.y - pre.bottom > 6) {
    drawOrthoStepWithPrisms(
      ctx,
      [{ x: pre.cx, y: pre.bottom - 1 }, { x: pre.cx, y: ing.y + 1 }],
      'spectrum', waveState[4], 0.00, prismsQueue, { tag: 'QUIC→TCP' }
    );
  }

  // Inter-Engine Vertical Cross-Feed: TW-HOME (TProxy weave_out) -> Burst-Harvest Pool
  if (dom.y - tun.bottom > 6) {
    drawOrthoStepWithPrisms(
      ctx,
      [{ x: tun.cx, y: tun.bottom - 1 }, { x: tun.cx, y: dom.y + 1 }],
      '170, 142, 240', waveState[3], 0.12, prismsQueue, { tag: 'weave_out' }
    );
  }

  // Stage 3 Vertical Convergence: 3-Band HTB QoS -> 21-Uplink NAT & Egress
  if (up.y - qos.bottom > 6) {
    drawOrthoStepWithPrisms(
      ctx,
      [{ x: qos.cx, y: qos.bottom - 1 }, { x: qos.cx, y: up.y + 1 }],
      'spectrum', waveState[4], 0.30, prismsQueue, { tag: '21 WAN NAT' }
    );
  }

  // Horizontal/Vertical Optical Bus + Main Focal Prism + 45-45-90 TIR Turning Prisms
  if (Math.min(vip.x, tun.x, dom.x) - ing.right > 30) {
    drawFocalPrismAndFan(ctx, rect.width, rect.height, ing, vip, tun, dom, prismsQueue);

    const rightS2 = Math.max(vip.right, tun.right, dom.right);
    const gap2W = qos.x - rightS2;
    if (gap2W > 18) {
      const y10 = q10 ? q10.cy : (qos.y + qos.h * 0.30);
      const y20 = q20 ? q20.cy : (qos.y + qos.h * 0.55);
      const y30 = q30 ? q30.cy : (qos.y + qos.h * 0.80);

      const xLane0 = vip.right + (qos.x - vip.right) * 0.28;
      const xLane1 = tun.right + (qos.x - tun.right) * 0.50;
      const xLane2 = dom.right + (qos.x - dom.right) * 0.72;

      drawOrthoStepWithPrisms(ctx, orthoStepPts(vip.right - 1, vip.cy, xLane0, y10, qos.x + 1), '100, 174, 245', waveState[0], 0.24, prismsQueue);
      drawOrthoStepWithPrisms(ctx, orthoStepPts(tun.right - 1, tun.cy, xLane1, y20, qos.x + 1), '170, 142, 240', waveState[1], 0.38, prismsQueue);
      drawOrthoStepWithPrisms(ctx, orthoStepPts(dom.right - 1, dom.cy, xLane2, y30, qos.x + 1), '87, 209, 146',  waveState[2], 0.52, prismsQueue);
    }
  }

  // Render all 45-degree crystal turning prisms crisply above all straight beam spans
  for (const p of prismsQueue) drawRightAngleTurningPrism(ctx, p);

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

    let colorName = 'mint';
    let colorRgb = '87, 209, 146';
    let textCls = 'c-mint';
    if (r.tag.includes('tunnel') || r.tag === 'rest-tunnel') {
      colorName = 'violet';
      colorRgb = '170, 142, 240';
      textCls = 'c-violet';
    } else if (r.tag === 'device-game') {
      colorName = 'blue';
      colorRgb = '100, 174, 245';
      textCls = 'c-blue';
    } else if (r.tag === 'quic') {
      colorName = 'amber';
      colorRgb = '235, 154, 94';
      textCls = 'c-amber';
    } else if (r.tag === 'device-block') {
      colorName = 'crimson';
      colorRgb = '230, 108, 120';
      textCls = 'c-crimson';
    }

    const pktTxt = pkts >= 1000 ? `${(pkts / 1000).toFixed(1)}k` : `${pkts}`;
    const pctTxt = pkts > 0 ? (share >= 1 ? `${Math.round(share)}%` : `${share.toFixed(1)}%`) : '0%';

    const segEl = el('span', { class: `seg-meter compact${pkts > 0 ? ' active' : ''}` });
    renderSegMeter(segEl, fillPct / 100, 16, colorName, true);

    frag.appendChild(el('div', {
      class: `classify-bar-card ${pkts > 0 ? 'active' : ''}`,
      style: { '--cb-rgb': colorRgb }
    },
      el('div', { class: 'classify-bar-head' },
        el('span', { class: pkts > 0 ? 'c-bright' : 'c-muted', style: { fontWeight: pkts > 0 ? '600' : '400', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', minWidth: '0' } }, label),
        el('span', { class: pkts > 0 ? textCls : 'c-muted', style: { fontVariantNumeric: 'tabular-nums', fontWeight: '600', whiteSpace: 'nowrap', fontSize: '9.5px' } }, `${pktTxt}·${pctTxt}`)
      ),
      segEl
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

  // Left Guard Rail (Dominant Security & Invariant Panel)
  const canaryMs = st.tunnel?.canary_ms || 0;
  const canaryFails = st.tunnel?.canary_fails ?? 0;
  $('#adv-verdict').textContent = st.ok ? 'zero-leak verified' : (st.fail?.join(', ') || 'check failed');
  $('#adv-verdict').className = `v ${st.ok ? 'c-mint' : 'c-crimson'}`;

  const failClosedEl = $('#adv-failclosed');
  if (failClosedEl) {
    const fc = !st.tunnel?.fail_open;
    failClosedEl.textContent = fc ? 'locked · 0x20000000' : 'fail-open (!)';
    failClosedEl.className = `v ${fc ? 'c-violet' : 'c-amber'}`;
  }

  const dnsEl = $('#adv-dns');
  if (dnsEl) {
    dnsEl.textContent = st.dns?.smartdns
      ? `53 → ${st.dns.port || 6053} · ${st.settings?.['dns.ads'] ? 'ads on' : 'ads off'}`
      : 'offline';
    dnsEl.className = `v ${st.dns?.smartdns ? 'c-mint' : 'c-crimson'}`;
  }

  $('#adv-canary').textContent = canaryMs > 0 ? `${canaryMs} ms (${canaryFails} fail)` : (st.tunnel?.on ? 'active' : 'off');
  const checks = S.doctor?.checks || [];
  const offCheck = checks.find(c => c.id === 'privacy_no_offload');
  const offEl = $('#adv-offload');
  if (offEl) {
    const offOk = offCheck ? !!offCheck.ok : true;
    offEl.textContent = offOk ? 'disabled (per-pkt)' : 'offload leak!';
    offEl.className = `v ${offOk ? 'c-mint' : 'c-crimson'}`;
  }

  const siteEl = $('#adv-site');
  if (siteEl) {
    const sName = st.site?.name || (st.site?.gateway ? 'unnamed gw' : 'direct');
    siteEl.textContent = `${sName} · ${st.settings?.['strands.aggregate'] || st.site?.mode || 'auto'}`;
  }

  const ctCount = st.sys?.conntrack?.count ?? 0;
  const ctMax = Math.max(1, st.sys?.conntrack?.max ?? 131072);
  $('#adv-ct').textContent = `${ctCount.toLocaleString()} / ${(ctMax / 1024).toFixed(0)}k`;
  $('#adv-strands').textContent = `${st.healthy_count ?? 0}/${st.strand_count ?? 21} · ${st.role || 'primary'}`;

  // Subsystem Invariants Grid inside PRISM_GUARD
  const totChecks = checks.length || 41;
  const okChecks = checks.length ? checks.filter(c => c.ok).length : (st.ok ? totChecks : 0);
  if ($('#adv-inv-score')) {
    $('#adv-inv-score').textContent = `${okChecks}/${totChecks} ok`;
    $('#adv-inv-score').className = okChecks === totChecks ? 'c-mint' : 'c-crimson';
  }
  renderSegMeter($('#adv-invariants-meter'), totChecks > 0 ? okChecks / totChecks : 0, 14, okChecks === totChecks ? 'mint' : 'crimson', true);

  const invGrid = $('#adv-invariants-grid');
  if (invGrid && checks.length) {
    const groups = [
      { label: 'fw4/guard',  test: c => c.id.startsWith('privacy_') || c.id === 'nft_table' || c.id === 'ip_forward' },
      { label: 'dns/6053',   test: c => c.id.includes('dns') || c.id.includes('dhcp') },
      { label: 'tproxy/cage',test: c => c.id.startsWith('tunnel_') },
      { label: 'weave/126',  test: c => c.id.includes('weave') || c.id.includes('pattern') || c.id.includes('strands') || c.id.includes('domestic') },
      { label: 'mptcp/pool', test: c => c.id.startsWith('mptcp_') },
      { label: 'canary/ok',  test: c => c.id === 'tunnel_canary' || c.id.includes('site') || c.level === 'fail' },
    ];
    const gFrag = document.createDocumentFragment();
    for (const grp of groups) {
      const matched = checks.filter(grp.test);
      const passed = matched.filter(c => c.ok).length;
      const allOk = matched.length === 0 || passed === matched.length;
      gFrag.appendChild(el('div', { class: `guard-inv-cell ${allOk ? 'ok' : 'bad'}` },
        el('span', { style: { display: 'inline-flex', alignItems: 'center', gap: '4px' } },
          el('span', { class: `run-dot ${allOk ? 'mint' : 'crimson'}` }),
          el('span', { class: 'c-sec' }, grp.label)
        ),
        el('span', { class: allOk ? 'c-bright' : 'c-crimson', style: { fontWeight: '600', fontVariantNumeric: 'tabular-nums' } }, `${passed}/${matched.length || 1}`)
      ));
    }
    invGrid.innerHTML = '';
    invGrid.appendChild(gFrag);
  }

  if ($('#adv-relays')) {
    $('#adv-relays').textContent = `TProxy :61235 · ${st.tunnel?.relays ?? 0} relays · ${(st.mptcp?.endpoints?.length ?? 0)} ep`;
  }
  if ($('#adv-classify-mode')) {
    $('#adv-classify-mode').textContent = `remainder: ${st.settings?.['classify.remainder'] || 'tunnel'} · quic: ${st.settings?.['classify.quic'] || 'reject'}`;
  }
  if ($('#adv-reconcile')) {
    const recTs = st.reconciled || st.ts;
    $('#adv-reconcile').textContent = recTs ? `sync ${fmtClock(recTs)}` : 'live';
  }
  $('#adv-doctor').textContent = st.ok
    ? `all ${totChecks} invariants ok`
    : `${st.fail?.length || 1} fail · ${st.warn?.length || 0} warn`;

  const evList = S.events?.events || [];
  if ($('#log-count')) $('#log-count').textContent = `${evList.length} 條`;
  renderSessionLog($('#ov-session-log'), evList, 35);

  // Tier 1A: Pre-Gate & SmartDNS
  $('#bp-quic-pkts').textContent = liveFlow.quicPkts >= 1000
    ? `${(liveFlow.quicPkts / 1000).toFixed(1)}k pkts`
    : `${liveFlow.quicPkts} pkts`;
  const sz = S.rules?.sizes || {};
  if ($('#bp-dns-port')) {
    $('#bp-dns-port').textContent = st.dns?.smartdns ? `:${st.dns.port || 6053} · ${st.settings?.['dns.ads'] ? 'ads' : 'raw'}` : 'offline';
  }
  $('#bp-dns-st').textContent = `dom ${sz.domestic4 ?? 0} · cn ${sz.domestic4_dns ?? 0}`;
  if ($('#bp-dns-tun')) $('#bp-dns-tun').textContent = `${sz.tunnel4_dns ?? 0} (range ${sz.tunnel4 ?? 0})`;
  if ($('#bp-site-name')) $('#bp-site-name').textContent = `${st.site?.name || 'direct'} · ${st.site?.mode || 'auto'}`;

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
  $('#bp-tun-desc').textContent = `主力: ${(tun?.tw_home || tun?.selected || 'TW-HOME').slice(0, 26)} · ${(liveFlow.tunPkts / 1000).toFixed(1)}k pkts`;
  const mptcpEl = $('#bp-tun-mptcp');
  if (mptcpEl) {
    mptcpEl.textContent = st.mptcp?.enabled
      ? `MPTCP ${st.mptcp.subflows} subflows · ${st.mptcp.endpoints?.length || 0} ep → weave_out`
      : 'MPTCP single-path → weave_out';
  }
  if ($('#bp-tun-meta')) {
    $('#bp-tun-meta').textContent = `relays ${st.tunnel?.relays ?? 0} · canary ${canaryMs || '—'}ms · ${st.tunnel?.fail_open ? 'fail-open' : 'fail-closed'}`;
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
  if ($('#bp-dom-slots')) $('#bp-dom-slots').textContent = `${w.slots ?? 126} (${w.affinity || 'flow'})`;
  if ($('#bp-dom-direct')) $('#bp-dom-direct').textContent = `${(liveFlow.domPkts / 1000).toFixed(1)}k (${Math.round(directShare * 100)}%)`;
  if ($('#bp-dom-probe')) $('#bp-dom-probe').textContent = `every ${w.interval ?? 2}s / ${st.settings?.['strands.probe_interval'] ?? 45}s`;
  if ($('#bp-dom-buckets')) $('#bp-dom-buckets').textContent = `${w.charged_count ?? 0} chg · ${w.draining_count ?? 0} drn`;
  $('#bp-dom-desc').textContent = `vip #${w.vip_id ?? '—'} (${w.vip_dev || 'auto'})`;
  $('#bp-dom-st').textContent = `${w.charged_count ?? 0}/${nH} charged · ${(w.cooling_count || 0) + (w.depleted_count || 0)} cool`;

  // Tier 3: Stage 3 Full-Height HTB QoS + 21-Uplink Egress Unified Segmented Meters
  const setSegMeter = (sel, ratio, count, colorName, compact = false, active = false) => {
    const node = $(sel);
    if (!node) return;
    renderSegMeter(node, ratio, count, colorName, compact);
    node.classList.toggle('active', !!active);
  };

  if ($('#bp-qos-meta')) $('#bp-qos-meta').textContent = `MSS ${st.settings?.['main.mss'] ?? 1440}`;
  const qosDomBps = Math.max(liveFlow.domBps, Math.max(0, totalRate - liveFlow.vipBps - liveFlow.tunBps));
  const qosTotBps = Math.max(1, liveFlow.vipBps + liveFlow.tunBps + qosDomBps);
  const shareRatio = (bps) => (bps > 0 ? Math.max(1 / 14, bps / qosTotBps) : 0);

  if ($('#bp-qos-10-rate')) $('#bp-qos-10-rate').textContent = fmtRate(liveFlow.vipBps).full;
  if ($('#bp-qos-20-rate')) $('#bp-qos-20-rate').textContent = fmtRate(liveFlow.tunBps).full;
  if ($('#bp-qos-30-rate')) $('#bp-qos-30-rate').textContent = fmtRate(qosDomBps).full;
  setSegMeter('#bp-qos-10-bar', shareRatio(liveFlow.vipBps), 14, 'blue',   true, liveFlow.vipBps > 400);
  setSegMeter('#bp-qos-20-bar', shareRatio(liveFlow.tunBps), 14, 'violet', true, liveFlow.tunBps > 400);
  setSegMeter('#bp-qos-30-bar', shareRatio(qosDomBps),       14, 'mint',   true, qosDomBps > 400);

  const ewmaDown = st.rate_ewma ?? st.rate ?? 0;
  const ewmaUp = st.rate_up_ewma ?? st.rate_up ?? 0;
  const ewmaMbps = ((ewmaDown + ewmaUp) * 8) / 1e6;
  if ($('#bp-qos-tx-txt')) $('#bp-qos-tx-txt').textContent = `↑ ${fmtRate(ewmaUp).full} · ↓ ${fmtRate(ewmaDown).full}`;
  const ewmaRatio = ewmaMbps > 0 ? Math.min(1, Math.max(1 / 18, Math.log10(1 + ewmaMbps * 3.5) * 0.44)) : 0;
  setSegMeter('#bp-qos-tx-bar', ewmaRatio, 18, 'spectrum', true, ewmaMbps > 0.02);

  const upSec = st.sys?.uptime || 0;
  const upDays = Math.floor(upSec / 86400);
  const upHours = Math.floor((upSec % 86400) / 3600);
  if ($('#bp-up-uptime')) $('#bp-up-uptime').textContent = upSec > 0 ? `up ${upDays}d ${upHours}h` : 'up —';

  const nTotal = Math.max(1, st.strand_count || 21);
  if ($('#bp-up-pool-txt')) $('#bp-up-pool-txt').textContent = `${w.charged_count ?? 0}/${nTotal} charged · ${st.healthy_count ?? 0} up`;
  setSegMeter('#bp-up-pool-bar', (w.charged_count ?? 0) / nTotal, 16, 'spectrum', false, (w.charged_count ?? 0) > 0 && totalRate > 2000);

  if ($('#bp-up-ct-txt')) $('#bp-up-ct-txt').textContent = `${ctCount.toLocaleString()} / ${ctMax.toLocaleString()}`;
  const ctRatio = ctCount > 0 ? Math.max(1 / 16, ctCount / ctMax) : 0;
  setSegMeter('#bp-up-ct-bar', ctRatio, 16, 'blue', false, ctCount > 0);

  const memMb = Math.round((st.sys?.mem_available_kb || 0) / 1024);
  const load1 = st.sys?.load1 ?? 0;
  if ($('#bp-up-mem-txt')) $('#bp-up-mem-txt').textContent = `${memMb} MB free · load ${load1}`;
  setSegMeter('#bp-up-mem-bar', Math.max(1 / 16, Math.min(1, memMb / 256)), 16, 'gold', false, load1 > 0.5);

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
