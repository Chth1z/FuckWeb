/* ============================================================================
 * PRISM 5.0 — "The Dark Side of the Moon" Standalone Cover Engine
 * Faithful geometry: single straight incident white beam, equilateral glass
 * prism with internal dispersion wedge, 21 contiguous straight uniform color
 * bands (no curves, no core lines, no particles), zero shadowBlur lag.
 * ============================================================================ */

import { S, SPECTRUM_STOPS, spectralColor, parseRgb, mixWhiteRgb, desatObsidianRgb, fmtRate } from '../state.js?v=5.6.6';
import { $ } from '../dom.js?v=5.6.6';

let rafId = null;
let needsRedraw = true;

export function markPrismDirty() {
  needsRedraw = true;
  ensureLoop();
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

  window.addEventListener('resize', () => markPrismDirty());
  markPrismDirty();
}

function stepPrism() {
  rafId = null;
  if (S.tab !== 'overview') return;
  const stillAnimating = drawPrismFrame();
  if (stillAnimating || needsRedraw) {
    needsRedraw = false;
    rafId = requestAnimationFrame(stepPrism);
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
    const bucketNames = {
      charged: '⚡ 滿桶脈衝 (CHARGED)',
      draining: '🔥 脈衝釋放 (DRAINING)',
      cooling: '❄️ 冷卻回血 (COOLING)',
      depleted: '🛑 觸頂退避 (DEPLETED)'
    };
    const stateTxt = !s.healthy ? '離線 / 待認證' : (s.vip ? '💎 VIP 電競零丟包專線' : (bucketNames[s.bucket] || s.bucket));
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
  } else {
    const st = S.status || {};
    const devs = S.devices?.devices || [];
    tip.classList.add('spectrum');
    tip.style.borderColor = '';
    tip.style.borderImage = '';
    tip.style.boxShadow = '';
    tip.innerHTML = `
      <div class="tt-head">
        <span class="c-bright">INCIDENT BEAM · 聚合入射白光</span>
        <span class="c-spectrum">${devs.length} 終端</span>
      </div>
      <div class="tt-grid">
        <span class="tt-k">總下行吞吐</span><span class="tt-v">${fmtRate(st.rate).full}</span>
        <span class="tt-k">總上行吞吐</span><span class="tt-v">${fmtRate(st.rate_up).full}</span>
        <span class="tt-k">健康光譜</span><span class="tt-v">${st.healthy_count ?? 0} / ${st.strand_count ?? 21} 條</span>
        <span class="tt-k">VIP 專線</span><span class="tt-v">${st.weave?.vip_dev || '自動選舉'}</span>
        <span class="tt-k">滿桶待命</span><span class="tt-v">${st.weave?.charged_count ?? 0} 條</span>
      </div>
    `;
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

function drawPrismFrame() {
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

  // Entry point on left slope (38% down from apex)
  const entryT = 0.38;
  const entryX = topX + (leftX - topX) * entryT;
  const entryY = topY + (leftY - topY) * entryT;

  // Exit span on right slope (33% to 56% down from apex)
  const exitTopT = 0.33;
  const exitBotT = 0.56;
  const exitTopX = topX + (rightX - topX) * exitTopT;
  const exitTopY = topY + (rightY - topY) * exitTopT;
  const exitBotX = topX + (rightX - topX) * exitBotT;
  const exitBotY = topY + (rightY - topY) * exitBotT;

  const st = S.status || {};
  const strands = st.strands || [];
  const nStrands = Math.max(1, strands.length);
  const totalRate = (st.rate || 0) + (st.rate_up || 0);
  const totalMbps = (totalRate * 8) / 1e6;

  S.hitBoxes = [];

  // 3. Single Straight Incident White Beam (Left Edge -> Prism Entry Point)
  // Radiant photon beam entering the left bevel at ~14.5 degrees
  const incidentAngle = 14.5 * Math.PI / 180;
  const startX = 0;
  const startY = entryY + entryX * Math.tan(incidentAngle);
  const beamHalf = Math.min(4.6, 1.5 + Math.sqrt(Math.max(0, totalMbps)) * 0.30);
  const beamGlowHalf = beamHalf * (6.2 + Math.min(2.8, totalMbps * 0.05));

  // Normal vector & unit direction to incident beam
  const bLen = Math.hypot(entryX - startX, entryY - startY) || 1;
  const ux = (entryX - startX) / bLen;
  const uy = (entryY - startY) / bLen;
  const nx = -uy;
  const ny = ux;
  const beamEndX = entryX + ux * 90;
  const beamEndY = entryY + uy * 90;

  // Dual-tier Gaussian-feathered optical photon bloom clipped flush to prism's left crystal face
  const outerGlowAlpha = Math.min(0.46, 0.24 + Math.sqrt(Math.max(0, totalMbps)) * 0.032);
  const innerGlowAlpha = Math.min(0.54, 0.32 + Math.sqrt(Math.max(0, totalMbps)) * 0.036);
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

  // Blazing crisp pure white incident photon core
  ctx.fillStyle = '#ffffff';
  ctx.beginPath();
  ctx.moveTo(startX + nx * beamHalf, startY + ny * beamHalf);
  ctx.lineTo(beamEndX + nx * (beamHalf * 0.85), beamEndY + ny * (beamHalf * 0.85));
  ctx.lineTo(beamEndX - nx * (beamHalf * 0.85), beamEndY - ny * (beamHalf * 0.85));
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
  const farTopY = exitTopY + rightSpan * Math.tan(10.0 * Math.PI / 180);
  const farBotY = exitBotY + rightSpan * Math.tan(15.2 * Math.PI / 180);

  let stillMoving = false;
  if (S.bandSmooth.length !== nStrands) {
    S.bandSmooth = new Array(nStrands).fill(null).map(() => ({ w: 1, alpha: 0.90, glow: 0.45 }));
  }

  const weights = [];
  let weightSum = 0;
  for (let i = 0; i < nStrands; i++) {
    const s = strands[i] || {};
    const rateBps = (s.now ?? s.rate ?? 0) + (s.up_now ?? s.up ?? 0);
    const mbps = (rateBps * 8) / 1e6;
    const tokRatio = (s.tokens_pct ?? 100) / 100;

    let targetW = 1.0;
    let targetAlpha = 0.90;
    let targetGlow = 0.46;
    if (!s.healthy) {
      targetW = 0.42;
      targetAlpha = 0.34;
      targetGlow = 0.0;
    } else if (s.bucket === 'depleted') {
      targetW = 0.62;
      targetAlpha = 0.56;
      targetGlow = 0.16;
    } else {
      targetW = 1.0 + 0.08 * tokRatio + Math.min(1.00, Math.sqrt(Math.max(0, mbps)) * 0.25);
      targetAlpha = Math.min(1.0, 0.86 + 0.08 * tokRatio + Math.min(0.12, Math.sqrt(Math.max(0, mbps)) * 0.04));
      targetGlow = Math.min(1.0, 0.40 + 0.10 * tokRatio + Math.log10(1 + Math.max(0, mbps) * 4.5) * 0.42);
    }

    const sm = S.bandSmooth[i];
    if (sm.glow == null) sm.glow = targetGlow;
    const dw = targetW - sm.w;
    const da = targetAlpha - sm.alpha;
    const dg = targetGlow - sm.glow;
    if (Math.abs(dw) > 0.003 || Math.abs(da) > 0.003 || Math.abs(dg) > 0.002) {
      sm.w += dw * 0.18;
      sm.alpha += da * 0.18;
      sm.glow += dg * (dg > 0 ? 0.24 : 0.055);
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

  // Wide volumetric spectral aura radiating out around & through the rainbow light beam
  const anyHover = S.hoverStrand !== null;
  if (!anyHover) {
    const outerReach = Math.min(68, 36 + Math.sqrt(Math.max(0, totalMbps)) * 4.2);
    const outerAlpha = Math.min(0.44, 0.26 + Math.sqrt(Math.max(0, totalMbps)) * 0.032);
    const colTop = spectralColor(0, nStrands);
    const colBot = spectralColor(nStrands - 1, nStrands);

    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    drawFeatheredEdge(
      ctx,
      rxTop, ryTop,
      W, farTopY,
      topDy / topLen, -topDx / topLen,
      outerReach,
      colTop.rgb,
      outerAlpha
    );
    drawFeatheredEdge(
      ctx,
      rxBot, ryBot,
      W, farBotY,
      -botDy / botLen, botDx / botLen,
      outerReach,
      colBot.rgb,
      outerAlpha
    );
    ctx.restore();
  }

  // Draw seamless contiguous opaque bands with luminous spectral richness (zero seams!)
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

    const col = spectralColor(i, nStrands);
    const isHover = S.hoverStrand === s.id;
    const smoothGlow = S.bandSmooth[i].glow;

    let exitRgb, midRgb, farRgb, exitLum, farLum;
    if (anyHover) {
      if (isHover) {
        exitRgb = mixWhiteRgb(col.rgb, 0.34);
        midRgb = mixWhiteRgb(col.rgb, 0.16);
        farRgb = col.rgb;
        exitLum = 1.0;
        farLum = 0.94;
      } else {
        const calmObs = desatObsidianRgb(col.rgb, 0.48);
        exitRgb = calmObs;
        midRgb = calmObs;
        farRgb = calmObs;
        exitLum = 0.58;
        farLum = 0.48;
      }
    } else if (!s.healthy) {
      const deadObs = desatObsidianRgb(col.rgb, 0.16);
      exitRgb = deadObs;
      midRgb = deadObs;
      farRgb = deadObs;
      exitLum = 0.36;
      farLum = 0.28;
    } else if (s.bucket === 'depleted') {
      const depObs = desatObsidianRgb(col.rgb, 0.44);
      exitRgb = depObs;
      midRgb = depObs;
      farRgb = depObs;
      exitLum = 0.58;
      farLum = 0.48;
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

    const rayGrad = ctx.createLinearGradient(x0Top, y0Top, W, y1Top);
    rayGrad.addColorStop(0.00, composeObsidianRgb(exitRgb, exitLum));
    rayGrad.addColorStop(0.32, composeObsidianRgb(midRgb, exitLum * 0.97));
    rayGrad.addColorStop(1.00, composeObsidianRgb(farRgb, farLum));

    ctx.fillStyle = rayGrad;
    ctx.beginPath();
    ctx.moveTo(bx0Top, by0Top);
    ctx.lineTo(W, y1Top);
    ctx.lineTo(W, farBotY + 0.5);
    ctx.lineTo(rxBot, ryBot + 0.5);
    ctx.closePath();
    ctx.fill();

    bandGeoms.push({
      bx0Top, by0Top, bx0Bot, by0Bot, y1Top, y1Bot, col, isHover, smoothGlow, healthy: !!s.healthy
    });

    S.hitBoxes.push({
      kind: 'band',
      quad: [x0Top, y0Top, W, y1Top, W, y1Bot, x0Bot, y0Bot],
      data: s,
      col
    });
  }

  // Broad atmospheric spectral sheet glow & luminous prism-exit dispersion shimmer
  ctx.save();
  ctx.globalCompositeOperation = 'lighter';
  const beamMidX = (exitTopX + W) * 0.5;
  const beamExitMidY = (exitTopY + exitBotY) * 0.5;
  const beamFarMidY = (farTopY + farBotY) * 0.5;
  const haloSpanExit = (exitBotY - exitTopY) * 0.5 + 22;
  const haloSpanFar = (farBotY - farTopY) * 0.5 + 40;
  const midSpan = (haloSpanExit + haloSpanFar) * 0.5;
  const midCenterY = (beamExitMidY + beamFarMidY) * 0.5;
  const sheetA = anyHover ? 0.06 : Math.min(0.22, 0.13 + Math.sqrt(Math.max(0, totalMbps)) * 0.022);
  const sheetGrad = ctx.createLinearGradient(beamMidX, midCenterY - midSpan, beamMidX, midCenterY + midSpan);
  sheetGrad.addColorStop(0.00, 'rgba(239, 68, 68, 0)');
  SPECTRUM_STOPS.forEach((rgb, idx) => {
    const pos = 0.14 + (idx / Math.max(1, SPECTRUM_STOPS.length - 1)) * 0.72;
    sheetGrad.addColorStop(pos, `rgba(${rgb}, ${sheetA.toFixed(3)})`);
  });
  sheetGrad.addColorStop(1.00, 'rgba(139, 92, 246, 0)');
  ctx.fillStyle = sheetGrad;
  ctx.beginPath();
  ctx.moveTo(rxTop, beamExitMidY - haloSpanExit);
  ctx.lineTo(W, beamFarMidY - haloSpanFar);
  ctx.lineTo(W, beamFarMidY + haloSpanFar);
  ctx.lineTo(rxBot, beamExitMidY + haloSpanExit);
  ctx.closePath();
  ctx.fill();

  // Warm optical shimmer right along crystal right-bevel exit
  const eDx = exitBotX - exitTopX;
  const eDy = exitBotY - exitTopY;
  const eLen = Math.hypot(eDx, eDy) || 1;
  drawFeatheredEdge(
    ctx,
    exitTopX, exitTopY,
    exitBotX, exitBotY,
    eDy / eLen, -eDx / eLen,
    Math.max(14, side * 0.075),
    '228, 242, 255',
    anyHover ? 0.10 : 0.24
  );

  // Soft radiant optical aura when hovering an individual strand
  if (anyHover) {
    for (let i = 0; i < bandGeoms.length; i++) {
      const b = bandGeoms[i];
      if (!b.isHover) continue;
      const bandMidThick = ((b.by0Bot - b.by0Top) + (b.y1Bot - b.y1Top)) * 0.5;
      const bloomPad = Math.max(22, bandMidThick * 2.2);
      const tDx = W - b.bx0Top;
      const tDy = b.y1Top - b.by0Top;
      const tLen = Math.hypot(tDx, tDy) || 1;
      drawFeatheredEdge(ctx, b.bx0Top, b.by0Top, W, b.y1Top, tDy / tLen, -tDx / tLen, bloomPad, b.col.rgb, 0.34);
      const bDx = W - b.bx0Bot;
      const bDy = b.y1Bot - b.by0Bot;
      const bLen = Math.hypot(bDx, bDy) || 1;
      drawFeatheredEdge(ctx, b.bx0Bot, b.by0Bot, W, b.y1Bot, -bDy / bLen, bDx / bLen, bloomPad, b.col.rgb, 0.34);
    }
  }
  ctx.restore();
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

  // Continuous C-infinity Gaussian inward teal-ice bevel (inverse winding outer frame casting inner shadow)
  const castInwardBevel = (blurPx, shadowCol) => {
    ctx.save();
    ctx.fillStyle = '#03050a';
    ctx.shadowColor = shadowCol;
    ctx.shadowBlur = blurPx;
    ctx.beginPath();
    // Outer frame clockwise
    ctx.moveTo(-80, -80);
    ctx.lineTo(W + 80, -80);
    ctx.lineTo(W + 80, H + 80);
    ctx.lineTo(-80, H + 80);
    ctx.closePath();
    // Inner triangle counter-clockwise hole
    ctx.moveTo(topX, topY);
    ctx.lineTo(leftX, leftY);
    ctx.lineTo(rightX, rightY);
    ctx.closePath();
    ctx.fill();
    ctx.restore();
  };
  castInwardBevel(Math.max(12, side * 0.088), 'rgba(130, 192, 214, 0.42)');
  castInwardBevel(Math.max(3, side * 0.018), 'rgba(196, 232, 240, 0.32)');

  const exitMidX = (exitTopX + exitBotX) * 0.5;
  const exitMidY = (exitTopY + exitBotY) * 0.5;
  const wEntTopY = entryY - beamHalf * 0.72;
  const wEntBotY = entryY + beamHalf * 0.72;

  // One seamless creamy-white internal dispersion wedge fading cleanly into obsidian void before right bevel
  ctx.save();
  ctx.globalCompositeOperation = 'screen';
  const wedgeGrad = ctx.createLinearGradient(entryX, entryY, exitMidX, exitMidY);
  wedgeGrad.addColorStop(0.00, 'rgba(255, 255, 255, 0.90)');
  wedgeGrad.addColorStop(0.12, 'rgba(228, 240, 252, 0.60)');
  wedgeGrad.addColorStop(0.28, 'rgba(186, 214, 240, 0.30)');
  wedgeGrad.addColorStop(0.48, 'rgba(146, 182, 218, 0.12)');
  wedgeGrad.addColorStop(0.70, 'rgba(116, 156, 198, 0.035)');
  wedgeGrad.addColorStop(0.88, 'rgba(100, 142, 188, 0.008)');
  wedgeGrad.addColorStop(1.00, 'rgba(100, 142, 188, 0.0)');

  ctx.shadowColor = 'rgba(205, 232, 255, 0.30)';
  ctx.shadowBlur = Math.max(8, side * 0.030);
  ctx.beginPath();
  ctx.moveTo(entryX - 1.5, wEntTopY);
  ctx.lineTo(exitTopX, exitTopY);
  ctx.lineTo(exitBotX, exitBotY);
  ctx.lineTo(entryX - 1.5, wEntBotY);
  ctx.closePath();
  ctx.fillStyle = wedgeGrad;
  ctx.fill();

  // Soft pinpoint glow right where incident photon beam strikes left crystal slope
  const entryRadius = Math.max(16, side * 0.14);
  const entryPeak = Math.min(0.32, 0.16 + Math.sqrt(Math.max(0, totalMbps)) * 0.025);
  const entryGlow = ctx.createRadialGradient(entryX + 1.5, entryY, 0.5, entryX + 2.5, entryY, entryRadius);
  entryGlow.addColorStop(0.00, `rgba(255, 255, 255, ${entryPeak.toFixed(3)})`);
  entryGlow.addColorStop(0.26, `rgba(220, 238, 255, ${(entryPeak * 0.52).toFixed(3)})`);
  entryGlow.addColorStop(0.58, `rgba(185, 216, 252, ${(entryPeak * 0.16).toFixed(3)})`);
  entryGlow.addColorStop(1.00, 'rgba(170, 206, 248, 0)');
  ctx.shadowBlur = 0;
  ctx.fillStyle = entryGlow;
  ctx.fillRect(entryX - entryRadius, entryY - entryRadius, entryRadius * 2, entryRadius * 2);
  ctx.restore();
  ctx.restore(); // End interior prism clip

  // Quiet understated hairline glass perimeter (never outshines the light beams)
  ctx.save();
  const rimGrad = ctx.createLinearGradient(topX, topY, cx, leftY);
  rimGrad.addColorStop(0.00, 'rgba(200, 226, 238, 0.42)');
  rimGrad.addColorStop(0.65, 'rgba(176, 206, 224, 0.34)');
  rimGrad.addColorStop(1.00, 'rgba(150, 186, 210, 0.24)');
  ctx.strokeStyle = rimGrad;
  ctx.lineWidth = 1.05;
  ctx.lineJoin = 'miter';
  ctx.beginPath();
  ctx.moveTo(topX, topY);
  ctx.lineTo(rightX, rightY);
  ctx.lineTo(leftX, leftY);
  ctx.closePath();
  ctx.stroke();
  ctx.restore();

  S.hitBoxes.push({
    kind: 'prism',
    quad: [topX, topY, rightX, rightY, leftX, leftY, topX, topY]
  });

  ctx.restore();
  return stillMoving;
}
