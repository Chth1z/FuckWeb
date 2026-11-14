/* ============================================================================
 * PRISM 5.0 — "The Dark Side of the Moon" Standalone Cover Engine
 * Faithful geometry: single straight incident white beam, equilateral glass
 * prism with internal dispersion wedge, 21 contiguous straight uniform color
 * bands (no curves, no core lines, no particles), zero shadowBlur lag.
 * ============================================================================ */

import { S, spectralColor, fmtRate } from '../state.js';
import { $ } from '../dom.js';

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
    tip.style.borderColor = col.css;
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
    tip.style.borderColor = 'var(--c-amber)';
    tip.innerHTML = `
      <div class="tt-head">
        <span class="c-bright">INCIDENT BEAM · 聚合入射白光</span>
        <span class="c-amber">${devs.length} 終端</span>
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

  // 1. Pure Album-Cover Obsidian Black Background
  ctx.fillStyle = '#030407';
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
  // Angles upward at ~14.5 degrees, faithful to the album cover
  const incidentAngle = 14.5 * Math.PI / 180;
  const startX = 0;
  const startY = entryY + entryX * Math.tan(incidentAngle);
  const beamHalf = Math.min(4.8, 1.4 + Math.sqrt(Math.max(0, totalMbps)) * 0.32);
  const beamGlowHalf = beamHalf * (2.6 + Math.min(2.2, totalMbps * 0.05));

  // Normal vector to incident beam
  const bLen = Math.hypot(entryX - startX, entryY - startY) || 1;
  const nx = -(entryY - startY) / bLen;
  const ny = (entryX - startX) / bLen;

  // Outer soft luminance polygon (zero shadowBlur!)
  const glowAlpha = Math.min(0.32, 0.10 + Math.sqrt(Math.max(0, totalMbps)) * 0.025);
  ctx.fillStyle = `rgba(225, 238, 255, ${glowAlpha})`;
  ctx.beginPath();
  ctx.moveTo(startX + nx * beamGlowHalf, startY + ny * beamGlowHalf);
  ctx.lineTo(entryX + nx * beamGlowHalf, entryY + ny * beamGlowHalf);
  ctx.lineTo(entryX - nx * beamGlowHalf, entryY - ny * beamGlowHalf);
  ctx.lineTo(startX - nx * beamGlowHalf, startY - ny * beamGlowHalf);
  ctx.closePath();
  ctx.fill();

  // Solid crisp white incident beam
  ctx.fillStyle = '#ffffff';
  ctx.beginPath();
  ctx.moveTo(startX + nx * beamHalf, startY + ny * beamHalf);
  ctx.lineTo(entryX + nx * (beamHalf * 0.85), entryY + ny * (beamHalf * 0.85));
  ctx.lineTo(entryX - nx * (beamHalf * 0.85), entryY - ny * (beamHalf * 0.85));
  ctx.lineTo(startX - nx * beamHalf, startY - ny * beamHalf);
  ctx.closePath();
  ctx.fill();

  S.hitBoxes.push({
    kind: 'beam',
    x1: startX, y1: startY,
    x2: entryX, y2: entryY,
    tol: Math.max(12, beamGlowHalf + 6)
  });

  // 4. Right Straight Spectrum Bands (21 Uniform Flat Color Bands, No Curves, No Dots)
  // Straight dispersion fan from right face to right edge of canvas (x = W)
  const rightSpan = W - exitTopX;
  const farTopY = exitTopY + rightSpan * Math.tan(10.0 * Math.PI / 180);
  const farBotY = exitBotY + rightSpan * Math.tan(15.2 * Math.PI / 180);

  let stillMoving = false;
  if (S.bandSmooth.length !== nStrands) {
    S.bandSmooth = new Array(nStrands).fill(null).map(() => ({ w: 1, alpha: 0.84 }));
  }

  const weights = [];
  let weightSum = 0;
  for (let i = 0; i < nStrands; i++) {
    const s = strands[i] || {};
    const rateBps = (s.now ?? s.rate ?? 0) + (s.up_now ?? s.up ?? 0);
    const mbps = (rateBps * 8) / 1e6;
    const tokRatio = (s.tokens_pct ?? 100) / 100;

    // Target thickness weight & luminance alpha based on traffic speed & bucket state
    let targetW = 1.0;
    let targetAlpha = 0.84;
    if (!s.healthy) {
      targetW = 0.38;
      targetAlpha = 0.22;
    } else if (s.bucket === 'depleted') {
      targetW = 0.52;
      targetAlpha = 0.45;
    } else {
      targetW = 0.85 + 0.30 * tokRatio + Math.min(2.4, Math.sqrt(Math.max(0, mbps)) * 0.48);
      targetAlpha = Math.min(0.98, 0.78 + 0.10 * tokRatio + Math.min(0.18, Math.sqrt(Math.max(0, mbps)) * 0.05));
    }

    const sm = S.bandSmooth[i];
    const dw = targetW - sm.w;
    const da = targetAlpha - sm.alpha;
    if (Math.abs(dw) > 0.003 || Math.abs(da) > 0.003) {
      sm.w += dw * 0.18;
      sm.alpha += da * 0.18;
      stillMoving = true;
    } else {
      sm.w = targetW;
      sm.alpha = targetAlpha;
    }
    weights.push(sm.w);
    weightSum += sm.w;
  }

  // Soft collective outer glow behind the rainbow fan when traffic is flowing
  if (totalMbps > 0.05) {
    const fanGlowAlpha = Math.min(0.18, 0.04 + Math.sqrt(totalMbps) * 0.02);
    const fanGrad = ctx.createLinearGradient(exitTopX, exitTopY, exitBotX, farBotY);
    fanGrad.addColorStop(0, `rgba(238, 52, 46, ${fanGlowAlpha})`);
    fanGrad.addColorStop(0.5, `rgba(68, 198, 92, ${fanGlowAlpha})`);
    fanGrad.addColorStop(1, `rgba(144, 82, 228, ${fanGlowAlpha})`);
    ctx.fillStyle = fanGrad;
    ctx.beginPath();
    ctx.moveTo(exitTopX, exitTopY - 6);
    ctx.lineTo(W, farTopY - 14);
    ctx.lineTo(W, farBotY + 14);
    ctx.lineTo(exitBotX, exitBotY + 6);
    ctx.closePath();
    ctx.fill();
  }

  // Draw each of the 21 contiguous straight uniform bands
  let cum = 0;
  for (let i = 0; i < nStrands; i++) {
    const s = strands[i] || { id: i + 1, dev: i === 0 ? 'wan' : `vwan${i}`, healthy: true };
    const t0 = cum / weightSum;
    cum += weights[i];
    const t1 = cum / weightSum;

    // Near segment along the prism's right slope
    const x0Top = exitTopX + (exitBotX - exitTopX) * t0;
    const y0Top = exitTopY + (exitBotY - exitTopY) * t0;
    const x0Bot = exitTopX + (exitBotX - exitTopX) * t1;
    const y0Bot = exitTopY + (exitBotY - exitTopY) * t1;

    // Far segment at right canvas edge (x = W)
    const y1Top = farTopY + (farBotY - farTopY) * t0;
    const y1Bot = farTopY + (farBotY - farTopY) * t1;

    const col = spectralColor(i, nStrands);
    const isHover = S.hoverStrand === s.id;
    const anyHover = S.hoverStrand !== null;

    let alpha = S.bandSmooth[i].alpha;
    if (anyHover) {
      alpha = isHover ? 1.0 : alpha * 0.28;
    }

    ctx.fillStyle = `rgba(${col.rgb}, ${alpha.toFixed(3)})`;
    ctx.beginPath();
    // Slight 0.35px overlap prevents subpixel anti-aliasing seams between contiguous bands
    ctx.moveTo(x0Top, y0Top - 0.25);
    ctx.lineTo(W, y1Top - 0.35);
    ctx.lineTo(W, y1Bot + 0.35);
    ctx.lineTo(x0Bot, y0Bot + 0.25);
    ctx.closePath();
    ctx.fill();

    if (isHover) {
      ctx.strokeStyle = 'rgba(255, 255, 255, 0.75)';
      ctx.lineWidth = 1;
      ctx.stroke();
    }

    S.hitBoxes.push({
      kind: 'band',
      quad: [x0Top, y0Top, W, y1Top, W, y1Bot, x0Bot, y0Bot],
      data: s,
      col
    });
  }

  // 5. Equilateral Prism Body & Internal Dispersion Wedge (Iconic Album Cover Look)
  // Fill dark glass interior
  ctx.fillStyle = '#04060a';
  ctx.beginPath();
  ctx.moveTo(topX, topY);
  ctx.lineTo(rightX, rightY);
  ctx.lineTo(leftX, leftY);
  ctx.closePath();
  ctx.fill();

  // Internal frosted white-to-translucent dispersion triangle inside the prism
  const wedgeGrad = ctx.createLinearGradient(entryX, entryY, (exitTopX + exitBotX) * 0.5, (exitTopY + exitBotY) * 0.5);
  wedgeGrad.addColorStop(0, 'rgba(255, 255, 255, 0.92)');
  wedgeGrad.addColorStop(0.28, 'rgba(215, 228, 242, 0.46)');
  wedgeGrad.addColorStop(0.72, 'rgba(165, 185, 210, 0.16)');
  wedgeGrad.addColorStop(1, 'rgba(140, 165, 195, 0.04)');

  ctx.fillStyle = wedgeGrad;
  ctx.beginPath();
  ctx.moveTo(entryX, entryY - beamHalf * 0.7);
  ctx.lineTo(exitTopX, exitTopY);
  ctx.lineTo(exitBotX, exitBotY);
  ctx.lineTo(entryX, entryY + beamHalf * 0.7);
  ctx.closePath();
  ctx.fill();

  // Inner glass bevel glow (thick cyan-grey frost inside the triangle edges, like the cover)
  ctx.strokeStyle = 'rgba(155, 185, 210, 0.18)';
  ctx.lineWidth = 7;
  ctx.lineJoin = 'miter';
  ctx.beginPath();
  ctx.moveTo(topX, topY + 4);
  ctx.lineTo(rightX - 3.5, rightY - 2);
  ctx.lineTo(leftX + 3.5, leftY - 2);
  ctx.closePath();
  ctx.stroke();

  // Crisp outer silver-white prism edge
  ctx.strokeStyle = 'rgba(230, 240, 252, 0.88)';
  ctx.lineWidth = 2.2;
  ctx.beginPath();
  ctx.moveTo(topX, topY);
  ctx.lineTo(rightX, rightY);
  ctx.lineTo(leftX, leftY);
  ctx.closePath();
  ctx.stroke();

  S.hitBoxes.push({
    kind: 'prism',
    quad: [topX, topY, rightX, rightY, leftX, leftY, topX, topY]
  });

  ctx.restore();
  return stillMoving;
}
