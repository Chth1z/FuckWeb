/* ============================================================================
 * PRISM 5.0 — "The Dark Side of the Moon" Standalone Cover Engine
 * Faithful geometry: single straight incident white beam, equilateral glass
 * prism with internal dispersion wedge, 21 contiguous straight uniform color
 * bands (no curves, no core lines, no particles), zero shadowBlur lag.
 * ============================================================================ */

import { S, spectralColor, parseRgb, mixWhiteRgb, desatObsidianRgb, fmtRate } from '../state.js?v=5.8.1';
import { $ } from '../dom.js?v=5.8.1';

let rafId = null;
let needsRedraw = true;
let lastPrismTs = 0;

export function markPrismDirty() {
  needsRedraw = true;
  ensureLoop();
}

export function renderPrismNow() {
  if (S.tab === 'overview') drawPrismFrame(0);
}

function ensureLoop() {
  if (!rafId && S.tab === 'overview') {
    rafId = requestAnimationFrame(stepPrism);
  }
}

export function initPrismCanvas() {
  const canvas = $('#topo');
  if (!canvas) return;

  canvas.addEventListener('mousemove', (e) => {
    const rect = canvas.getBoundingClientRect();
    S.topoPointer = { x: e.clientX - rect.left, y: e.clientY - rect.top };
    handlePrismHover(rect);
    markPrismDirty();
  });

  canvas.addEventListener('mouseleave', () => {
    S.topoPointer = { x: -1, y: -1 };
    if (S.hoverStrand !== null) {
      S.hoverStrand = null;
      markPrismDirty();
    }
    $('#topo-tip')?.classList.remove('show');
  });

  if (typeof ResizeObserver !== 'undefined' && !canvas._prismRo) {
    let lastW = 0, lastH = 0;
    const ro = new ResizeObserver(() => {
      if (S.tab !== 'overview') return;
      const r = canvas.getBoundingClientRect();
      const rw = Math.round(r.width), rh = Math.round(r.height);
      if (rw > 0 && rh > 0 && (rw !== lastW || rh !== lastH)) {
        lastW = rw;
        lastH = rh;
        drawPrismFrame(0);
      }
    });
    ro.observe(canvas);
    canvas._prismRo = ro;
  }

  window.addEventListener('resize', () => {
    if (S.tab === 'overview') drawPrismFrame(0);
    else markPrismDirty();
  });
  markPrismDirty();
}

function stepPrism(now) {
  rafId = null;
  if (S.tab !== 'overview') {
    lastPrismTs = 0;
    return;
  }
  const ts = (typeof now === 'number' && now > 0) ? now : (globalThis.performance?.now?.() || Date.now());
  const dt = lastPrismTs ? Math.min(0.08, Math.max(0.004, (ts - lastPrismTs) / 1000)) : 0.016;
  lastPrismTs = ts;
  const stillAnimating = drawPrismFrame(dt);
  if (stillAnimating || needsRedraw) {
    needsRedraw = false;
    rafId = requestAnimationFrame(stepPrism);
  } else {
    lastPrismTs = 0;
  }
}

// Point-in-convex-quadrilateral test for exact straight band hover detection
function pointInQuad(px, py, q) {
  // q = [x0,y0, x1,y1, x2,y2, x3,y3] clockwise
  let pos = 0, neg = 0;
  for (let i = 0; i < 4; i++) {
    const x1 = q[i * 2], y1 = q[i * 2 + 1];
    const x2 = q[((i + 1) % 4) * 2], y2 = q[((i + 1) % 4) * 2 + 1];
    const cross = (x2 - x1) * (py - y1) - (y2 - y1) * (px - x1);
    if (cross > 0) pos++;
    else if (cross < 0) neg++;
    if (pos && neg) return false;
  }
  return true;
}

function distToSegment(px, py, x1, y1, x2, y2) {
  const dx = x2 - x1, dy = y2 - y1;
  const l2 = dx * dx + dy * dy;
  if (l2 === 0) return Math.hypot(px - x1, py - y1);
  const t = Math.max(0, Math.min(1, ((px - x1) * dx + (py - y1) * dy) / l2));
  return Math.hypot(px - (x1 + t * dx), py - (y1 + t * dy));
}

function handlePrismHover(rect) {
  const tip = $('#topo-tip');
  if (!tip) return;
  const { x, y } = S.topoPointer;
  if (x < 0 || y < 0) {
    tip.classList.remove('show');
    return;
  }

  let hit = null;
  for (const box of S.hitBoxes) {
    if (box.kind === 'band' && pointInQuad(x, y, box.quad)) {
      hit = box;
      break;
    }
    if (box.kind === 'beam' && distToSegment(x, y, box.x1, box.y1, box.x2, box.y2) <= box.tol) {
      hit = box;
      break;
    }
    if (box.kind === 'prism' && pointInQuad(x, y, box.quad)) {
      hit = box;
    }
  }

  const nextHoverId = hit?.kind === 'band' ? hit.data.id : null;
  if (S.hoverStrand !== nextHoverId) {
    S.hoverStrand = nextHoverId;
    needsRedraw = true;
  }

  if (!hit) {
    tip.classList.remove('show');
    return;
  }

  if (hit.kind === 'band') {
    const s = hit.data;
    const col = hit.col;
    const tKey = `b:${s.id}:${s.healthy ? 1 : 0}:${s.vip ? 1 : 0}:${s.bucket}:${s.now ?? s.rate}:${s.up_now ?? s.up}:${s.peak}:${s.ttfb_ms}:${s.tokens_pct}:${s.slots}:${s.ip || ''}`;
    if (tip._lastHoverKey !== tKey) {
      tip._lastHoverKey = tKey;
      const bucketNames = {
        charged: '⚡ 滿桶蓄能 (CHARGED)',
        draining: '🔥 脈衝釋放 (DRAINING)',
        cooling: '❄️ 冷卻回充 (COOLING)',
        depleted: '🛑 觸頂退避 (DEPLETED)'
      };
      const stateTxt = !s.healthy ? '離線 / 待認證' : (s.vip ? '💎 @vip_lane 極速光道' : (bucketNames[s.bucket] || s.bucket));
      tip.classList.remove('spectrum');
      tip.style.borderImage = '';
      tip.style.borderColor = `rgba(${col.rgb}, 0.85)`;
      tip.style.boxShadow = `0 0 18px rgba(${col.rgb}, 0.30), 0 0 38px rgba(${col.rgb}, 0.14), inset 0 0 14px rgba(${col.rgb}, 0.10), 0 14px 36px rgba(0, 0, 0, 0.90)`;
      tip.innerHTML = `
      <div class="tt-head">
        <span style="color:${col.css}">${s.dev} (#${s.id})</span>
        <span class="c-muted">λ = ${col.lambda} nm</span>
      </div>
      <div class="tt-grid">
        <span class="tt-k">狀態</span><span class="tt-v">${stateTxt}</span>
        <span class="tt-k">下行速率</span><span class="tt-v">${fmtRate(s.now ?? s.rate).full}</span>
        <span class="tt-k">上行速率</span><span class="tt-v">${fmtRate(s.up_now ?? s.up).full}</span>
        <span class="tt-k">峰值速率</span><span class="tt-v">${fmtRate(s.peak).full}</span>
        <span class="tt-k">純網路 τ_net</span><span class="tt-v">${s.ttfb_ms > 0 ? s.ttfb_ms + ' ms' : '—'}</span>
        <span class="tt-k">令牌桶 B_i/B_c</span><span class="tt-v">${Math.round((s.tokens || 0) / 1000)} KB (${s.tokens_pct ?? 100}%)</span>
        <span class="tt-k">ISWRR 槽位</span><span class="tt-v">${s.vip ? 'VIP (0x100)' : (s.slots ?? 0) + ' / ' + (S.status?.weave?.slots || 126)}</span>
        <span class="tt-k">線路 IP</span><span class="tt-v">${s.ip || '—'}</span>
      </div>
    `;
    }
  } else {
    const st = S.status || {};
    const devs = S.devices?.devices || [];
    const onlineCnt = devs.filter(d => d.online).length;
    const tKey = `beam:${onlineCnt}/${devs.length}:${st.rate}:${st.rate_up}:${st.healthy_count}:${st.weave?.vip_dev || ''}:${st.weave?.charged_count}`;
    if (tip._lastHoverKey !== tKey) {
      tip._lastHoverKey = tKey;
      tip.classList.add('spectrum');
      tip.style.borderColor = '';
      tip.style.borderImage = '';
      tip.style.boxShadow = '';
      tip.innerHTML = `
      <div class="tt-head">
        <span class="c-bright">INCIDENT BEAM · 原初聚合白光</span>
        <span class="c-spectrum">${onlineCnt} 在線 / ${devs.length} 終端</span>
      </div>
      <div class="tt-grid">
        <span class="tt-k">總下行吞吐</span><span class="tt-v">${fmtRate(st.rate).full}</span>
        <span class="tt-k">總上行吞吐</span><span class="tt-v">${fmtRate(st.rate_up).full}</span>
        <span class="tt-k">健康光譜</span><span class="tt-v">${st.healthy_count ?? 0} / ${st.strand_count ?? 21} 條</span>
        <span class="tt-k">極速光道</span><span class="tt-v">${st.weave?.vip_dev || '自動選舉'}</span>
        <span class="tt-k">滿桶待命</span><span class="tt-v">${st.weave?.charged_count ?? 0} 條</span>
      </div>
    `;
    }
  }

  const tipW = 248, tipH = 190;
  let tx = x + 18, ty = y - 16;
  if (tx + tipW > rect.width - 12) tx = x - tipW - 18;
  if (ty + tipH > rect.height - 12) ty = rect.height - tipH - 12;
  if (ty < 12) ty = 12;
  tip.style.left = `${tx}px`;
  tip.style.top = `${ty}px`;
  tip.classList.add('show');
}

function clipSlopeHalfPlane(ctx, ax, ay, bx, by, sideSign, W, H) {
  const dx = bx - ax;
  const dy = (by - ay) || 1;
  const yTop = -120;
  const yBot = H + 120;
  const xTop = ax + dx * ((yTop - ay) / dy);
  const xBot = ax + dx * ((yBot - ay) / dy);
  ctx.beginPath();
  if (sideSign < 0) {
    const xFar = Math.min(-120, xTop - 200, xBot - 200);
    ctx.moveTo(xFar, yTop);
    ctx.lineTo(xTop, yTop);
    ctx.lineTo(xBot, yBot);
    ctx.lineTo(xFar, yBot);
  } else {
    const xFar = Math.max(W + 120, xTop + 200, xBot + 200);
    ctx.moveTo(xTop, yTop);
    ctx.lineTo(xFar, yTop);
    ctx.lineTo(xFar, yBot);
    ctx.lineTo(xBot, yBot);
  }
  ctx.closePath();
  ctx.clip();
}

function composeObsidianRgb(rgbStr, intensity, fade = 1) {
  const [r, g, b] = parseRgb(rgbStr);
  const k = Math.max(0, Math.min(1, intensity)) * Math.max(0, Math.min(1, fade));
  const rr = Math.min(255, Math.round(4 + (r - 4) * k));
  const gg = Math.min(255, Math.round(5 + (g - 5) * k));
  const bb = Math.min(255, Math.round(9 + (b - 9) * k));
  return `rgb(${rr}, ${gg}, ${bb})`;
}

function drawFeatheredEdge(ctx, x0, y0, x1, y1, nx, ny, dist, rgb, alpha) {
  if (alpha <= 0.004 || dist <= 0.5) return;
  const mx = (x0 + x1) * 0.5;
  const my = (y0 + y1) * 0.5;
  const g = ctx.createLinearGradient(mx, my, mx + nx * dist, my + ny * dist);
  // 8-stop smooth Gaussian falloff (eliminates hard gradient knees & boxy bloom contours)
  g.addColorStop(0.00, `rgba(${rgb}, ${alpha.toFixed(3)})`);
  g.addColorStop(0.14, `rgba(${rgb}, ${(alpha * 0.72).toFixed(3)})`);
  g.addColorStop(0.28, `rgba(${rgb}, ${(alpha * 0.46).toFixed(3)})`);
  g.addColorStop(0.44, `rgba(${rgb}, ${(alpha * 0.24).toFixed(3)})`);
  g.addColorStop(0.60, `rgba(${rgb}, ${(alpha * 0.11).toFixed(3)})`);
  g.addColorStop(0.76, `rgba(${rgb}, ${(alpha * 0.04).toFixed(3)})`);
  g.addColorStop(0.90, `rgba(${rgb}, ${(alpha * 0.01).toFixed(3)})`);
  g.addColorStop(1.00, `rgba(${rgb}, 0)`);
  ctx.fillStyle = g;
  ctx.beginPath();
  ctx.moveTo(x0, y0);
  ctx.lineTo(x1, y1);
  ctx.lineTo(x1 + nx * dist, y1 + ny * dist);
  ctx.lineTo(x0 + nx * dist, y0 + ny * dist);
  ctx.closePath();
  ctx.fill();
}

function drawPrismFrame(dt = 0.016) {
  const canvas = $('#topo');
  if (!canvas) return false;
  const rect = canvas.getBoundingClientRect();
  if (rect.width <= 0 || rect.height <= 0) return false;

  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const targetW = Math.round(rect.width * dpr);
  const targetH = Math.round(rect.height * dpr);
  if (canvas.width !== targetW || canvas.height !== targetH) {
    canvas.width = targetW;
    canvas.height = targetH;
  }

  const ctx = canvas.getContext('2d', { alpha: false });
  ctx.save();
  ctx.scale(dpr, dpr);

  const W = rect.width;
  const H = rect.height;

  // 1. Pure Album-Cover Obsidian Black Background (matches --bg-void)
  ctx.fillStyle = '#040509';
  ctx.fillRect(0, 0, W, H);

  // 2. Equilateral Triangle Prism Geometry (Centered like Dark Side of the Moon)
  const cx = W * 0.485;
  const cy = H * 0.50;
  const side = Math.min(W * 0.23, H * 0.45);
  const triH = side * Math.sqrt(3) / 2;

  const topX = cx;
  const topY = cy - triH * 0.54;
  const leftX = cx - side / 2;
  const leftY = topY + triH;
  const rightX = cx + side / 2;
  const rightY = topY + triH;

  // Entry point centered on left crystal slope (38% down from apex)
  const entryT = 0.38;
  const entryX = topX + (leftX - topX) * entryT;
  const entryY = topY + (leftY - topY) * entryT;

  const st = S.status || {};
  const strands = st.strands || [];
  const nStrands = Math.max(1, strands.length);
  const rawTotalRate = (st.rate || 0) + (st.rate_up || 0);
  const ewmaTotalRate = (st.rate_ewma ?? st.rate ?? 0) + (st.rate_up_ewma ?? st.rate_up ?? 0);
  const targetTotalMbps = ((rawTotalRate * 0.45 + ewmaTotalRate * 0.55) * 8) / 1e6;
  if (S.prismTotalMbps == null) S.prismTotalMbps = targetTotalMbps;
  const kEnv = Math.min(1, 1 - Math.exp(-dt * 4.8));
  const dTot = targetTotalMbps - S.prismTotalMbps;
  let stillMoving = false;
  if (Math.abs(dTot) > 0.004) {
    S.prismTotalMbps += dTot * kEnv;
    stillMoving = true;
  } else {
    S.prismTotalMbps = targetTotalMbps;
  }
  const totalMbps = S.prismTotalMbps;

  // Unified optical flux factor (0..1): thickens incident white beam AND proportionally widens refracted exit fan together
  const fluxNorm = Math.min(1, Math.sqrt(Math.max(0, totalMbps)) * 0.11 + Math.log10(1 + Math.max(0, totalMbps)) * 0.16);
  const beamHalf = 1.40 + fluxNorm * 3.10;
  const beamGlowHalf = beamHalf * (5.2 + fluxNorm * 2.2);

  const exitCenterT = 0.445;
  const exitSpanT = 0.145 + fluxNorm * 0.145;
  const exitTopT = exitCenterT - exitSpanT * 0.5;
  const exitBotT = exitCenterT + exitSpanT * 0.5;
  const exitTopX = topX + (rightX - topX) * exitTopT;
  const exitTopY = topY + (rightY - topY) * exitTopT;
  const exitBotX = topX + (rightX - topX) * exitBotT;
  const exitBotY = topY + (rightY - topY) * exitBotT;

  S.hitBoxes = [];

  // 3. Single Straight Incident White Beam (Left Edge -> Prism Entry Point)
  // Radiant photon beam entering the left bevel at ~14.5 degrees
  const incidentAngle = 14.5 * Math.PI / 180;
  const startX = 0;
  const startY = entryY + entryX * Math.tan(incidentAngle);

  // Normal vector & unit direction to incident beam
  const bLen = Math.hypot(entryX - startX, entryY - startY) || 1;
  const ux = (entryX - startX) / bLen;
  const uy = (entryY - startY) / bLen;
  const nx = -uy;
  const ny = ux;
  const beamEndX = entryX + ux * 90;
  const beamEndY = entryY + uy * 90;

  // Dual-tier Gaussian-feathered optical photon bloom clipped flush to prism's left crystal face
  const outerGlowAlpha = Math.min(0.34, 0.18 + Math.sqrt(Math.max(0, totalMbps)) * 0.026);
  const innerGlowAlpha = Math.min(0.44, 0.26 + Math.sqrt(Math.max(0, totalMbps)) * 0.030);
  ctx.save();
  clipSlopeHalfPlane(ctx, topX, topY, leftX, leftY, -1, W, H);
  ctx.save();
  ctx.globalCompositeOperation = 'lighter';
  // Wide soft outer Gaussian feather
  drawFeatheredEdge(ctx, startX, startY, beamEndX, beamEndY, nx, ny, beamGlowHalf, '205, 232, 255', outerGlowAlpha);
  drawFeatheredEdge(ctx, startX, startY, beamEndX, beamEndY, -nx, -ny, beamGlowHalf, '205, 232, 255', outerGlowAlpha);
  // Tight core bloom
  drawFeatheredEdge(ctx, startX, startY, beamEndX, beamEndY, nx, ny, beamHalf * 2.5, '255, 255, 255', innerGlowAlpha);
  drawFeatheredEdge(ctx, startX, startY, beamEndX, beamEndY, -nx, -ny, beamHalf * 2.5, '255, 255, 255', innerGlowAlpha);
  ctx.restore();

  // Blazing crisp pure white incident photon core (exact uniform width matching internal entry hit segment)
  ctx.fillStyle = '#ffffff';
  ctx.beginPath();
  ctx.moveTo(startX + nx * beamHalf, startY + ny * beamHalf);
  ctx.lineTo(beamEndX + nx * beamHalf, beamEndY + ny * beamHalf);
  ctx.lineTo(beamEndX - nx * beamHalf, beamEndY - ny * beamHalf);
  ctx.lineTo(startX - nx * beamHalf, startY - ny * beamHalf);
  ctx.closePath();
  ctx.fill();
  ctx.restore();

  S.hitBoxes.push({
    kind: 'beam',
    x1: startX, y1: startY,
    x2: entryX, y2: entryY,
    tol: Math.max(12, beamGlowHalf + 6)
  });

  // 4. Right Straight Spectrum Bands (21 Radiant Photonic Rainbow Bands)
  // Straight dispersion fan from right face to right edge of canvas (x = W)
  const rightSpan = W - exitTopX;
  const farTopY = exitTopY + rightSpan * Math.tan((10.0 - fluxNorm * 0.6) * Math.PI / 180);
  const farBotY = exitBotY + rightSpan * Math.tan((15.2 + fluxNorm * 0.8) * Math.PI / 180);

  if (S.bandSmooth.length !== nStrands) {
    S.bandSmooth = new Array(nStrands).fill(null).map(() => ({ w: 1, alpha: 0.90, glow: 0.45 }));
  }

  const kUp = Math.min(1, 1 - Math.exp(-dt * 5.2));
  const kDown = Math.min(1, 1 - Math.exp(-dt * 3.0));
  const weights = [];
  let weightSum = 0;
  for (let i = 0; i < nStrands; i++) {
    const s = strands[i] || {};
    const rawNowBps = (s.now ?? s.rate ?? 0) + (s.up_now ?? s.up ?? 0);
    const ewmaBps = (s.rate ?? s.now ?? 0) + (s.up ?? s.up_now ?? 0);
    const rateBps = rawNowBps * 0.45 + ewmaBps * 0.55;
    const mbps = (rateBps * 8) / 1e6;

    let targetW = 1.0;
    let targetAlpha = 0.90;
    let targetGlow = 0.46;
    if (!s.healthy) {
      targetW = 0.78;
      targetAlpha = 0.72;
      targetGlow = 0.14;
    } else {
      targetW = 1.0 + Math.min(0.85, Math.sqrt(Math.max(0, mbps)) * 0.22);
      targetAlpha = Math.min(1.0, 0.90 + Math.min(0.10, Math.sqrt(Math.max(0, mbps)) * 0.035));
      targetGlow = Math.min(1.0, 0.46 + Math.log10(1 + Math.max(0, mbps) * 4.5) * 0.44);
    }

    const sm = S.bandSmooth[i];
    if (sm.glow == null) sm.glow = targetGlow;
    const dw = targetW - sm.w;
    const da = targetAlpha - sm.alpha;
    const dg = targetGlow - sm.glow;
    if (Math.abs(dw) > 0.002 || Math.abs(da) > 0.002 || Math.abs(dg) > 0.002) {
      sm.w += dw * kUp;
      sm.alpha += da * kUp;
      sm.glow += dg * (dg > 0 ? kUp : kDown);
      stillMoving = true;
    } else {
      sm.w = targetW;
      sm.alpha = targetAlpha;
      sm.glow = targetGlow;
    }
    weights.push(sm.w);
    weightSum += sm.w;
  }

  // Clip all right-side dispersed bands + radiant atmospheric halos flush to prism's right face
  ctx.save();
  clipSlopeHalfPlane(ctx, topX, topY, rightX, rightY, 1, W, H);

  const topDx = W - exitTopX;
  const topDy = farTopY - exitTopY;
  const topLen = Math.hypot(topDx, topDy) || 1;
  const rxTop = exitTopX - (topDx / topLen) * 65;
  const ryTop = exitTopY - (topDy / topLen) * 65;

  const botDx = W - exitBotX;
  const botDy = farBotY - exitBotY;
  const botLen = Math.hypot(botDx, botDy) || 1;
  const rxBot = exitBotX - (botDx / botLen) * 65;
  const ryBot = exitBotY - (botDy / botLen) * 65;

  // Extend dispersed rays + outer edge blooms well past right canvas boundary (W + 80) to eliminate diagonal corner notches
  const farEndX = W + 80;
  const farEndTopY = exitTopY + topDy * ((farEndX - exitTopX) / (topDx || 1));
  const farEndBotY = exitBotY + botDy * ((farEndX - exitBotX) / (botDx || 1));

  // Precompute unified band colors & geometry so outer edge bloom seamlessly matches Boundary Strands #0 & #N-1
  const anyHover = S.hoverStrand !== null;
  let cum = 0;
  const bandGeoms = [];
  for (let i = 0; i < nStrands; i++) {
    const s = strands[i] || { id: i + 1, dev: i === 0 ? 'wan' : `vwan${i}`, healthy: true };
    const t0 = cum / weightSum;
    cum += weights[i];
    const t1 = cum / weightSum;

    const x0Top = exitTopX + (exitBotX - exitTopX) * t0;
    const y0Top = exitTopY + (exitBotY - exitTopY) * t0;
    const x0Bot = exitTopX + (exitBotX - exitTopX) * t1;
    const y0Bot = exitTopY + (exitBotY - exitTopY) * t1;

    const bx0Top = rxTop + (rxBot - rxTop) * t0;
    const by0Top = ryTop + (ryBot - ryTop) * t0;
    const bx0Bot = rxTop + (rxBot - rxTop) * t1;
    const by0Bot = ryTop + (ryBot - ryTop) * t1;

    const y1Top = farTopY + (farBotY - farTopY) * t0;
    const y1Bot = farTopY + (farBotY - farTopY) * t1;
    const yEndTop = farEndTopY + (farEndBotY - farEndTopY) * t0;
    const yEndBot = farEndTopY + (farEndBotY - farEndTopY) * t1;

    const col = spectralColor(i, nStrands);
    const isHover = S.hoverStrand === s.id;
    const smoothGlow = S.bandSmooth[i].glow;

    let exitRgb, midRgb, farRgb, exitLum, farLum;
    if (anyHover) {
      if (isHover) {
        if (!s.healthy) {
          const softDead = desatObsidianRgb(col.rgb, 0.66);
          exitRgb = mixWhiteRgb(softDead, 0.14);
          midRgb = softDead;
          farRgb = desatObsidianRgb(col.rgb, 0.58);
          exitLum = 0.78;
          farLum = 0.70;
        } else {
          exitRgb = mixWhiteRgb(col.rgb, 0.34);
          midRgb = mixWhiteRgb(col.rgb, 0.16);
          farRgb = col.rgb;
          exitLum = 1.0;
          farLum = 0.94;
        }
      } else if (!s.healthy) {
        const calmDead = desatObsidianRgb(col.rgb, 0.34);
        exitRgb = calmDead;
        midRgb = calmDead;
        farRgb = calmDead;
        exitLum = 0.40;
        farLum = 0.32;
      } else {
        const calmObs = desatObsidianRgb(col.rgb, 0.48);
        exitRgb = calmObs;
        midRgb = calmObs;
        farRgb = calmObs;
        exitLum = 0.58;
        farLum = 0.48;
      }
    } else if (!s.healthy) {
      // Only genuinely unhealthy links dim in brightness + saturation; token-bucket exhaustion keeps full healthy radiance
      const downObs = desatObsidianRgb(col.rgb, 0.44);
      exitRgb = downObs;
      midRgb = downObs;
      farRgb = downObs;
      exitLum = 0.52;
      farLum = 0.44;
    } else {
      const k = Math.max(0.20, Math.min(1, smoothGlow));
      const sat = 0.88 + 0.12 * k;
      const litCol = desatObsidianRgb(col.rgb, sat);
      const coreRgb = k > 0.48 ? mixWhiteRgb(litCol, (k - 0.48) * 0.26) : litCol;
      exitRgb = mixWhiteRgb(coreRgb, 0.14 + 0.08 * k);
      midRgb = coreRgb;
      farRgb = litCol;
      exitLum = 0.90 + 0.10 * k;
      farLum = exitLum * 0.90;
    }

    bandGeoms.push({
      s, col, isHover,
      x0Top, y0Top, x0Bot, y0Bot,
      bx0Top, by0Top, bx0Bot, by0Bot,
      y1Top, y1Bot, yEndTop, yEndBot,
      exitRgb, midRgb, farRgb, exitLum, farLum
    });
  }

  // Tight crisp outer edge sheen hugging top Red & bottom Violet without smearing past bevel exit corners
  if (!anyHover && bandGeoms.length > 0) {
    const firstB = bandGeoms[0];
    const lastB = bandGeoms[bandGeoms.length - 1];
    const outerReach = Math.min(10, 6 + Math.sqrt(Math.max(0, totalMbps)) * 0.9);
    const nxTop = topDy / topLen, nyTop = -topDx / topLen;
    const nxBot = -botDy / botLen, nyBot = botDx / botLen;
    const topStartA = Math.min(0.28, ((firstB.exitLum + firstB.farLum) * 0.5) * (0.24 + Math.min(0.06, Math.sqrt(Math.max(0, totalMbps)) * 0.01)));
    const botStartA = Math.min(0.28, ((lastB.exitLum + lastB.farLum) * 0.5) * (0.24 + Math.min(0.06, Math.sqrt(Math.max(0, totalMbps)) * 0.01)));

    drawFeatheredEdge(
      ctx,
      rxTop - nxTop * 2, ryTop - nyTop * 2,
      farEndX - nxTop * 2, farEndTopY - nyTop * 2,
      nxTop, nyTop,
      outerReach + 2,
      firstB.midRgb,
      topStartA
    );
    drawFeatheredEdge(
      ctx,
      rxBot - nxBot * 2, ryBot - nyBot * 2,
      farEndX - nxBot * 2, farEndBotY - nyBot * 2,
      nxBot, nyBot,
      outerReach + 2,
      lastB.midRgb,
      botStartA
    );
  }

  // Draw seamless contiguous opaque bands with luminous spectral richness
  for (let i = 0; i < bandGeoms.length; i++) {
    const b = bandGeoms[i];
    const rayGrad = ctx.createLinearGradient(b.x0Top, b.y0Top, W, b.y1Top);
    rayGrad.addColorStop(0.00, composeObsidianRgb(b.exitRgb, b.exitLum));
    rayGrad.addColorStop(0.32, composeObsidianRgb(b.midRgb, b.exitLum * 0.97));
    rayGrad.addColorStop(1.00, composeObsidianRgb(b.farRgb, b.farLum));

    ctx.fillStyle = rayGrad;
    ctx.beginPath();
    ctx.moveTo(b.bx0Top, b.by0Top);
    ctx.lineTo(farEndX, b.yEndTop);
    ctx.lineTo(farEndX, farEndBotY + 0.5);
    ctx.lineTo(rxBot, ryBot + 0.5);
    ctx.closePath();
    ctx.fill();

    S.hitBoxes.push({
      kind: 'band',
      quad: [b.x0Top, b.y0Top, W, b.y1Top, W, b.y1Bot, b.x0Bot, b.y0Bot],
      data: b.s,
      col: b.col
    });
  }

  // Calm Gaussian optical aura when hovering an individual strand (also extended past W)
  if (anyHover) {
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    for (let i = 0; i < bandGeoms.length; i++) {
      const b = bandGeoms[i];
      if (!b.isHover) continue;
      const bandMidThick = ((b.by0Bot - b.by0Top) + (b.y1Bot - b.y1Top)) * 0.5;
      const bloomPad = Math.max(16, Math.min(28, bandMidThick * 1.9));
      const tDx = farEndX - b.bx0Top;
      const tDy = b.yEndTop - b.by0Top;
      const tLen = Math.hypot(tDx, tDy) || 1;
      drawFeatheredEdge(ctx, b.bx0Top, b.by0Top, farEndX, b.yEndTop, tDy / tLen, -tDx / tLen, bloomPad, b.midRgb, 0.24);
      const bDx = farEndX - b.bx0Bot;
      const bDy = b.yEndBot - b.by0Bot;
      const bLen = Math.hypot(bDx, bDy) || 1;
      drawFeatheredEdge(ctx, b.bx0Bot, b.by0Bot, farEndX, b.yEndBot, -bDy / bLen, bDx / bLen, bloomPad, b.midRgb, 0.24);
    }
    ctx.restore();
  }
  ctx.restore(); // End right-bevel half-plane clip

  // 5. Classic "The Dark Side of the Moon" Sculpted Glass Prism (Quiet Dark Crystal)
  // Zero stepped rings, zero loud neon border, continuous Gaussian inward cyan-slate bevel
  ctx.save();
  ctx.beginPath();
  ctx.moveTo(topX, topY);
  ctx.lineTo(rightX, rightY);
  ctx.lineTo(leftX, leftY);
  ctx.closePath();
  ctx.clip();

  // Deep obsidian void interior
  ctx.fillStyle = '#03050a';
  ctx.fillRect(leftX - 2, topY - 2, side + 4, triH + 4);

  // Frosted DSOTM inward cyan-slate bevel (no hard outer stroke line or flat border ring: pure inward light decay matching cover)
  const bevelReach = Math.max(14, side * 0.105);
  const drawInwardEdgeBevel = (ax, ay, bx, by, reach, alpha) => {
    const dx = bx - ax;
    const dy = by - ay;
    const len = Math.hypot(dx, dy) || 1;
    const uxEdge = dx / len;
    const uyEdge = dy / len;
    // Clockwise triangle winding (top -> right -> left): (-uy, ux) points strictly INWARD
    drawFeatheredEdge(
      ctx,
      ax - uxEdge * 20, ay - uyEdge * 20,
      bx + uxEdge * 20, by + uyEdge * 20,
      -uyEdge, uxEdge,
      reach,
      '158, 200, 216',
      alpha
    );
  };
  ctx.save();
  ctx.globalCompositeOperation = 'screen';
  drawInwardEdgeBevel(topX, topY, rightX, rightY, bevelReach, 0.72);
  drawInwardEdgeBevel(rightX, rightY, leftX, leftY, bevelReach, 0.72);
  drawInwardEdgeBevel(leftX, leftY, topX, topY, bevelReach, 0.72);
  ctx.restore();

  // Exact ray-slope intersection so internal wedge origin locks 1:1 to incident white beam at every beamHalf
  const intersectLeftSlope = (px, py) => {
    const lx = leftX - topX;
    const ly = leftY - topY;
    const denom = (ly * ux - lx * uy) || 1;
    const t = ((py - topY) * ux - (px - topX) * uy) / denom;
    return [topX + lx * t, topY + ly * t];
  };
  const [hitAX, hitAY] = intersectLeftSlope(entryX + nx * beamHalf, entryY + ny * beamHalf);
  const [hitBX, hitBY] = intersectLeftSlope(entryX - nx * beamHalf, entryY - ny * beamHalf);
  const hitTopX = hitAY <= hitBY ? hitAX : hitBX;
  const hitTopY = hitAY <= hitBY ? hitAY : hitBY;
  const hitBotX = hitAY <= hitBY ? hitBX : hitAX;
  const hitBotY = hitAY <= hitBY ? hitBY : hitAY;

  // Orient internal dispersion gradient perpendicular to right slope so BOTH exitTop & exitBot meet the crystal wall evenly
  const rSlopeDx = rightX - topX;
  const rSlopeDy = rightY - topY;
  const rSlopeLen = Math.hypot(rSlopeDx, rSlopeDy) || 1;
  const rOutNx = rSlopeDy / rSlopeLen;
  const rOutNy = -rSlopeDx / rSlopeLen;
  const spanPerp = Math.max(10, (exitTopX - entryX) * rOutNx + (exitTopY - entryY) * rOutNy);

  ctx.save();
  ctx.globalCompositeOperation = 'screen';
  const wedgeGrad = ctx.createLinearGradient(
    entryX,
    entryY,
    entryX + rOutNx * spanPerp,
    entryY + rOutNy * spanPerp
  );
  wedgeGrad.addColorStop(0.00, 'rgba(255, 255, 255, 0.88)');
  wedgeGrad.addColorStop(0.14, 'rgba(228, 240, 252, 0.52)');
  wedgeGrad.addColorStop(0.34, 'rgba(186, 214, 240, 0.24)');
  wedgeGrad.addColorStop(0.62, 'rgba(146, 182, 218, 0.10)');
  wedgeGrad.addColorStop(0.86, 'rgba(122, 164, 206, 0.055)');
  wedgeGrad.addColorStop(1.00, 'rgba(116, 160, 204, 0.04)');

  ctx.beginPath();
  ctx.moveTo(hitTopX, hitTopY);
  ctx.lineTo(exitTopX, exitTopY);
  ctx.lineTo(exitBotX, exitBotY);
  ctx.lineTo(hitBotX, hitBotY);
  ctx.closePath();
  ctx.fillStyle = wedgeGrad;
  ctx.fill();

  // Soft pinpoint glow right where incident photon beam strikes left crystal slope
  const entryRadius = Math.max(16, side * 0.14);
  const entryPeak = Math.min(0.34, 0.18 + Math.sqrt(Math.max(0, totalMbps)) * 0.025);
  const entryGlow = ctx.createRadialGradient(entryX + 1.5, entryY, 0.5, entryX + 2.5, entryY, entryRadius);
  entryGlow.addColorStop(0.00, `rgba(255, 255, 255, ${entryPeak.toFixed(3)})`);
  entryGlow.addColorStop(0.26, `rgba(220, 238, 255, ${(entryPeak * 0.52).toFixed(3)})`);
  entryGlow.addColorStop(0.58, `rgba(185, 216, 252, ${(entryPeak * 0.16).toFixed(3)})`);
  entryGlow.addColorStop(1.00, 'rgba(170, 206, 248, 0)');
  ctx.fillStyle = entryGlow;
  ctx.fillRect(entryX - entryRadius, entryY - entryRadius, entryRadius * 2, entryRadius * 2);
  ctx.restore();

  // Crisp bright left entry junction flush with incident white beam thickness
  ctx.fillStyle = '#ffffff';
  ctx.beginPath();
  ctx.moveTo(hitTopX - ux * 1.4, hitTopY - uy * 1.4);
  ctx.lineTo(hitTopX + ux * 1.8, hitTopY + uy * 1.8);
  ctx.lineTo(hitBotX + ux * 1.8, hitBotY + uy * 1.8);
  ctx.lineTo(hitBotX - ux * 1.4, hitBotY - uy * 1.4);
  ctx.closePath();
  ctx.fill();
  ctx.restore(); // End interior prism clip

  S.hitBoxes.push({
    kind: 'prism',
    quad: [topX, topY, rightX, rightY, leftX, leftY, topX, topY]
  });

  ctx.restore();
  return stillMoving;
}
