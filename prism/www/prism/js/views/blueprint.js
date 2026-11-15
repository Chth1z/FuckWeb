/* ============================================================================
 * PRISM — View 02: Kernel Routing Architecture, Proportional Classify & Ribbons
 * ============================================================================ */

import { S, LOCKED_SPECS, EDITABLE_SPECS, spectralColor, fmtRate, fmtBytes } from '../state.js?v=5.6.0';
import { $, $$, el, renderSegMeter, renderSessionLog } from '../dom.js?v=5.6.0';
import { write, call } from '../api.js?v=5.6.0';

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

function blendDarkCss(rgb, alpha, bg = 5) {
  const parts = String(rgb).split(',').map(v => Number(v.trim()) || 0);
  const a = Math.max(0, Math.min(1, alpha));
  const c = (v) => Math.round(bg * (1 - a) + v * a);
  return `rgb(${c(parts[0])}, ${c(parts[1])}, ${c(parts[2])})`;
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

function cleanOrthoPts(pts) {
  const out = [];
  for (const p of pts) {
    const prev = out[out.length - 1];
    if (!prev || Math.hypot(p.x - prev.x, p.y - prev.y) > 0.5) {
      out.push({ x: p.x, y: p.y });
    }
  }
  return out;
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

function segDir(a, b) {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const l = Math.hypot(dx, dy) || 1;
  return { nx: -dy / l, ny: dx / l };
}

function offsetOrthoPts(pts, dist) {
  if (pts.length < 2 || Math.abs(dist) < 1e-4) return pts;
  const out = [];
  for (let i = 0; i < pts.length; i++) {
    if (i === 0) {
      const d0 = segDir(pts[0], pts[1]);
      out.push({ x: pts[0].x + d0.nx * dist, y: pts[0].y + d0.ny * dist });
    } else if (i === pts.length - 1) {
      const dn = segDir(pts[i - 1], pts[i]);
      out.push({ x: pts[i].x + dn.nx * dist, y: pts[i].y + dn.ny * dist });
    } else {
      const dPrev = segDir(pts[i - 1], pts[i]);
      const dNext = segDir(pts[i], pts[i + 1]);
      const denom = 1 + (dPrev.nx * dNext.nx + dPrev.ny * dNext.ny);
      if (denom < 0.25) {
        out.push({ x: pts[i].x + dPrev.nx * dist, y: pts[i].y + dPrev.ny * dist });
      } else {
        out.push({
          x: pts[i].x + ((dPrev.nx + dNext.nx) / denom) * dist,
          y: pts[i].y + ((dPrev.ny + dNext.ny) / denom) * dist,
        });
      }
    }
  }
  return out;
}

function tracePts(ctx, pArr) {
  ctx.beginPath();
  ctx.moveTo(pArr[0].x, pArr[0].y);
  for (let i = 1; i < pArr.length; i++) ctx.lineTo(pArr[i].x, pArr[i].y);
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

// Unified Figure-3 Strictly Horizontal/Vertical Mitered Optical Bus
function drawOrthoOpticalRibbon(ctx, rawPts, rgb, st, phaseOffset = 0, tag = '', tagAt = null) {
  const pts = cleanOrthoPts(rawPts);
  if (pts.length < 2) return;

  let len = 0;
  for (let i = 1; i < pts.length; i++) {
    len += Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y);
  }
  if (len < 2) return;

  const p0 = pts[0];
  const pLast = pts[pts.length - 1];
  const g = st.glow;
  const active = st.vel > 0.01;
  const isSpec = rgb === 'spectrum';

  ctx.save();
  ctx.lineJoin = 'miter';
  ctx.lineCap = 'butt';
  ctx.miterLimit = 6;

  if (isSpec) {
    // Seamless 7-strand opaque-composited rainbow bus + soft chromatic outer edge halo
    const nStripes = 7;
    const totalHalf = Math.max(4.0, st.width * 1.85);
    const bandAlpha = 0.58 + g * 0.34;
    const redRgb = spectralColor(0, nStripes).rgb;
    const vioRgb = spectralColor(nStripes - 1, nStripes).rgb;

    const topAura = offsetOrthoPts(pts, -totalHalf * 0.55);
    const botAura = offsetOrthoPts(pts, totalHalf * 0.55);
    const edgeGlows = [
      { addW: 16 + g * 10, a: 0.025 + g * 0.032 },
      { addW: 9 + g * 6,   a: 0.052 + g * 0.055 },
      { addW: 4 + g * 3,   a: 0.088 + g * 0.080 },
    ];
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    for (const eg of edgeGlows) {
      ctx.lineWidth = totalHalf + eg.addW;
      ctx.strokeStyle = `rgba(${redRgb}, ${eg.a.toFixed(3)})`;
      tracePts(ctx, topAura);
      ctx.stroke();
      ctx.strokeStyle = `rgba(${vioRgb}, ${eg.a.toFixed(3)})`;
      tracePts(ctx, botAura);
      ctx.stroke();
    }
    ctx.restore();

    const bandW = (totalHalf * 2) / nStripes;
    for (let i = 0; i < nStripes; i++) {
      const offset = (-1 + (2 * (i + 0.5)) / nStripes) * totalHalf;
      ctx.strokeStyle = blendDarkCss(spectralColor(i, nStripes).rgb, bandAlpha);
      ctx.lineWidth = bandW + 0.45;
      tracePts(ctx, offsetOrthoPts(pts, offset));
      ctx.stroke();
    }

    if (active && g > 0.10) {
      ctx.save();
      ctx.globalCompositeOperation = 'lighter';
      ctx.strokeStyle = makeFlowShimmerGradient(
        ctx, p0.x, p0.y, pLast.x, pLast.y, st, phaseOffset, '255, 255, 255', 0.16
      );
      ctx.lineWidth = totalHalf * 1.42;
      tracePts(ctx, pts);
      ctx.stroke();
      ctx.restore();
    }
  } else {
    // Monochrome Figure-3 mitered H/V bus (smooth concentric aura + rich saturated core)
    const bandW = 3.8 + g * 2.2;
    const haloPasses = [
      { addW: 20 + g * 14, a: 0.024 + g * 0.032 },
      { addW: 13 + g * 9,  a: 0.048 + g * 0.056 },
      { addW: 7 + g * 5,   a: 0.088 + g * 0.095 },
      { addW: 3 + g * 2,   a: 0.145 + g * 0.125 },
    ];

    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    tracePts(ctx, pts);
    for (const hp of haloPasses) {
      ctx.strokeStyle = `rgba(${rgb}, ${hp.a.toFixed(3)})`;
      ctx.lineWidth = bandW + hp.addW;
      ctx.stroke();
    }
    ctx.restore();

    ctx.strokeStyle = `rgba(${rgb}, ${(0.64 + g * 0.30).toFixed(3)})`;
    ctx.lineWidth = bandW;
    tracePts(ctx, pts);
    ctx.stroke();

    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    ctx.strokeStyle = `rgba(${mixWhiteRgb(rgb, 0.25)}, ${(0.22 + g * 0.24).toFixed(3)})`;
    ctx.lineWidth = Math.max(1.5, bandW * 0.44);
    tracePts(ctx, pts);
    ctx.stroke();

    if (active && g > 0.10) {
      ctx.strokeStyle = makeFlowShimmerGradient(
        ctx, p0.x, p0.y, pLast.x, pLast.y,
        st, phaseOffset, mixWhiteRgb(rgb, 0.38), 0.24
      );
      ctx.lineWidth = bandW * 0.90;
      tracePts(ctx, pts);
      ctx.stroke();
    }
    ctx.restore();
  }
  ctx.restore();

  if (tag && len >= 18) {
    const tp = tagAt || { x: (p0.x + pLast.x) * 0.5, y: (p0.y + pLast.y) * 0.5 };
    drawLinkTag(ctx, tp.x, tp.y, tag, rgb);
  }
}

function drawFocalPrismAndFan(ctx, W, H, ing, vip, tun, dom) {
  const rightEdgeEnd = Math.min(vip.x, tun.x, dom.x);
  const gapW = rightEdgeEnd - ing.right;
  if (gapW < 30) return;

  const focalX = ing.right + gapW * 0.34;
  const focalY = tun.cy;
  const side = Math.max(26, Math.min(40, gapW * 0.36));
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

  const splitDy = Math.min(7, triH * 0.17);
  const splitBaseX = rightX + (rightEdgeEnd - rightX) * 0.48;

  const exits = [
    { dy: -splitDy, xTurn: splitBaseX - 6, tx: vip.x + 2, ty: vip.cy, rgb: '100, 174, 245', st: waveState[0], phase: 0.00 },
    { dy: 0,        xTurn: splitBaseX,     tx: tun.x + 2, ty: tun.cy, rgb: '170, 142, 240', st: waveState[1], phase: 0.16 },
    { dy: splitDy,  xTurn: splitBaseX + 6, tx: dom.x + 2, ty: dom.cy, rgb: '87, 209, 146',  st: waveState[2], phase: 0.32 },
  ].map((e) => {
    const ey = focalY + e.dy;
    const tOut = (ey - topY) / triH;
    const ex = topX + (rightX - topX) * tOut;
    return { ...e, ex, ey };
  });

  // 1. Strictly Horizontal Ingress -> Focal Prism Left Bevel (with H-V-H guard on extreme viewports)
  const ingY = Math.max(ing.y + 14, Math.min(ing.bottom - 14, focalY));
  const inPts = Math.abs(ingY - focalY) < 2
    ? [{ x: ing.right - 2, y: focalY }, { x: entryX + 16, y: focalY }]
    : orthoStepPts(ing.right - 2, ingY, ing.right + (leftX - ing.right) * 0.42, focalY, entryX + 16);

  ctx.save();
  clipHalfPlane(ctx, topX, topY, leftX, leftY, -1, W, H);
  drawOrthoOpticalRibbon(ctx, inPts, 'spectrum', waveState[4], 0.05);
  ctx.restore();

  // 2. Strictly Horizontal/Vertical 1 -> 3 Dispersed Optical Branches from Focal Prism Right Bevel
  ctx.save();
  clipHalfPlane(ctx, topX, topY, rightX, rightY, 1, W, H);
  for (const e of exits) {
    const branchPts = orthoStepPts(e.ex - 16, e.ey, e.xTurn, e.ty, e.tx);
    drawOrthoOpticalRibbon(ctx, branchPts, e.rgb, e.st, e.phase);
  }
  ctx.restore();

  // 3. Focal Crystal Prism (dark optical glass + soft radial dispersion + uniform rim)
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
  ctx.shadowColor = 'rgba(180, 214, 250, 0.30)';
  ctx.shadowBlur = 7;
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

  // Stage 1 Vertical Conduit: Pre-Gate -> Nftables Classify Engine
  if (ing.y - pre.bottom > 6) {
    drawOrthoOpticalRibbon(
      ctx,
      [{ x: pre.cx, y: pre.bottom - 2 }, { x: pre.cx, y: ing.y + 2 }],
      'spectrum', waveState[4], 0.00, 'QUIC→TCP'
    );
  }

  // Inter-Engine Vertical Cross-Feed: TW-HOME (TProxy weave_out) -> Burst-Harvest Pool
  if (dom.y - tun.bottom > 6) {
    drawOrthoOpticalRibbon(
      ctx,
      [{ x: tun.cx, y: tun.bottom - 2 }, { x: tun.cx, y: dom.y + 2 }],
      '170, 142, 240', waveState[3], 0.12, 'weave_out'
    );
  }

  // Stage 3 Vertical Convergence: 3-Band HTB QoS -> 21-Uplink NAT & Egress
  if (up.y - qos.bottom > 6) {
    drawOrthoOpticalRibbon(
      ctx,
      [{ x: qos.cx, y: qos.bottom - 2 }, { x: qos.cx, y: up.y + 2 }],
      'spectrum', waveState[4], 0.30, '21 WAN NAT'
    );
  }

  // Strictly Horizontal/Vertical Optical Channels + Focal Prism (1 -> 3 Dispersion)
  if (Math.min(vip.x, tun.x, dom.x) - ing.right > 30) {
    drawFocalPrismAndFan(ctx, rect.width, rect.height, ing, vip, tun, dom);

    const rightS2 = Math.max(vip.right, tun.right, dom.right);
    const gap2W = qos.x - rightS2;
    if (gap2W > 18) {
      const y10 = q10 ? q10.cy : (qos.y + qos.h * 0.30);
      const y20 = q20 ? q20.cy : (qos.y + qos.h * 0.55);
      const y30 = q30 ? q30.cy : (qos.y + qos.h * 0.80);

      const xLane0 = vip.right + (qos.x - vip.right) * 0.28;
      const xLane1 = tun.right + (qos.x - tun.right) * 0.50;
      const xLane2 = dom.right + (qos.x - dom.right) * 0.72;

      drawOrthoOpticalRibbon(ctx, orthoStepPts(vip.right - 2, vip.cy, xLane0, y10, qos.x + 2), '100, 174, 245', waveState[0], 0.24);
      drawOrthoOpticalRibbon(ctx, orthoStepPts(tun.right - 2, tun.cy, xLane1, y20, qos.x + 2), '170, 142, 240', waveState[1], 0.38);
      drawOrthoOpticalRibbon(ctx, orthoStepPts(dom.right - 2, dom.cy, xLane2, y30, qos.x + 2), '87, 209, 146',  waveState[2], 0.52);
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
    renderSegMeter(segEl, fillPct / 100, 10, colorName, true);

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

  const ctCount = st.sys?.conntrack?.count ?? 0;
  const ctMax = Math.max(1, st.sys?.conntrack?.max ?? 131072);
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
