/* ============================================================================
 * PRISM 5.6 — Thick Rainbow-Bar Overlaid Smooth Phosphor SVG Oscilloscope
 * ============================================================================ */

import { S, fmtRate, fmtRateCompact, fmtClock } from '../state.js?v=5.6.6';
import { $, svgEl } from '../dom.js?v=5.6.6';

let lastSig = '';
let chartLimit = 360;
let lastFocus = null;

export function setChartLimit(lim) {
  chartLimit = lim;
  lastSig = '';
  renderOscilloscope(lastFocus);
}

export function getChartLimit() {
  return chartLimit;
}

function downsampleWindow(ts, down, up, focus, maxPts = 140) {
  const n = ts.length;
  if (n <= maxPts) return { ts, down, up, focus };
  const step = n / maxPts;
  const oTs = new Array(maxPts);
  const oDown = new Array(maxPts);
  const oUp = new Array(maxPts);
  const oFocus = focus ? new Array(maxPts) : null;
  for (let i = 0; i < maxPts; i++) {
    const start = Math.floor(i * step);
    const end = Math.max(start + 1, Math.min(n, Math.floor((i + 1) * step)));
    let maxD = 0, maxU = 0, maxF = 0;
    for (let j = start; j < end; j++) {
      if ((down[j] || 0) > maxD) maxD = down[j] || 0;
      if ((up[j] || 0) > maxU) maxU = up[j] || 0;
      if (oFocus && (focus[j] || 0) > maxF) maxF = focus[j] || 0;
    }
    oTs[i] = ts[end - 1];
    oDown[i] = maxD;
    oUp[i] = maxU;
    if (oFocus) oFocus[i] = maxF;
  }
  return { ts: oTs, down: oDown, up: oUp, focus: oFocus };
}

function buildPolylinePath(series, n, toX, toY, minY, maxY) {
  if (n < 2) return '';
  const clampY = (y) => Math.max(minY, Math.min(maxY, y));
  let d = '';
  for (let i = 0; i < n; i++) {
    const x = toX(i).toFixed(1);
    const y = clampY(toY(series[i] || 0)).toFixed(1);
    d += `${i === 0 ? 'M' : ' L'}${x},${y}`;
  }
  return d;
}

export function renderOscilloscope(activeStrand = lastFocus) {
  lastFocus = activeStrand || null;
  const svg = $('#chart');
  const tip = $('#tip');
  const ser = S.series;
  if (!svg || !ser || !ser.ts || ser.ts.length < 2) return;

  const sliceStart = Math.max(0, ser.ts.length - chartLimit);
  const rawTs = ser.ts.slice(sliceStart);
  const rawDown = ser.total.slice(sliceStart);
  const rawUp = (ser.up || []).slice(sliceStart);

  const focusDev = lastFocus?.dev || '';
  const fRaw = focusDev && Array.isArray(ser.strands?.[focusDev]) ? ser.strands[focusDev] : null;
  const fAligned = fRaw ? fRaw.slice(Math.max(0, fRaw.length - rawTs.length)) : null;
  const focusFull = fAligned
    ? (fAligned.length < rawTs.length
      ? new Array(rawTs.length - fAligned.length).fill(0).concat(fAligned)
      : fAligned)
    : null;

  const winPeakBps = Math.max(0, ...rawDown, ...rawUp);
  const subEl = $('#ribbon-rate-sub');
  if (subEl && S.status) {
    const upNow = S.status.rate_up || rawUp[rawUp.length - 1] || 0;
    subEl.textContent = `↑${fmtRateCompact(upNow, '0')} · pk ${fmtRateCompact(winPeakBps, '0')}`;
  }

  const rect = svg.getBoundingClientRect?.();
  const W = rect && rect.width > 120 ? Math.round(rect.width) : 1200;
  const H = rect && rect.height > 40 ? Math.round(rect.height) : 112;

  const lastF = focusFull ? focusFull[focusFull.length - 1] : '';
  const sig = `${W}x${H}:${rawTs.length}:${rawTs[rawTs.length - 1]}:${rawDown[rawDown.length - 1]}:${rawUp[rawUp.length - 1]}:${chartLimit}:${focusDev}:${lastF}`;
  if (sig === lastSig) return;
  lastSig = sig;

  svg.setAttribute('viewBox', `0 0 ${W} ${H}`);

  const ds = downsampleWindow(rawTs, rawDown, rawUp, focusFull, 140);
  const ts = ds.ts, down = ds.down, up = ds.up, focus = ds.focus;
  const n = ts.length;

  const padL = 8, padR = 36, padT = 26, padB = 6;
  const plotW = Math.max(20, W - padL - padR);
  const plotH = Math.max(22, H - padT - padB);

  let maxBps = 1250000; // min 10 Mbps baseline
  for (let i = 0; i < n; i++) {
    if (down[i] > maxBps) maxBps = down[i];
    if ((up[i] || 0) > maxBps) maxBps = up[i];
  }
  maxBps *= 1.12;

  const toX = (i) => padL + (i / Math.max(1, n - 1)) * plotW;
  const toY = (bps) => padT + plotH - (Math.max(0, bps) / maxBps) * plotH;
  const baseY = padT + plotH;

  svg.innerHTML = '';

  const defs = svgEl('defs');
  const gradWhite = svgEl('linearGradient', { id: 'scopeWhiteG', x1: '0', y1: '0', x2: '0', y2: '1' },
    svgEl('stop', { offset: '0%', 'stop-color': '#ffffff', 'stop-opacity': '0.28' }),
    svgEl('stop', { offset: '100%', 'stop-color': '#ffffff', 'stop-opacity': '0.02' })
  );
  const gradFocus = svgEl('linearGradient', { id: 'scopeFocusG', x1: '0', y1: '0', x2: '0', y2: '1' },
    svgEl('stop', { offset: '0%', 'stop-color': '#ffffff', 'stop-opacity': '0.32' }),
    svgEl('stop', { offset: '100%', 'stop-color': '#ffffff', 'stop-opacity': '0.03' })
  );
  defs.append(gradWhite, gradFocus);
  svg.appendChild(defs);

  // Subtle horizontal guides & right-margin scale labels cleanly below HUD
  const steps = 2;
  for (let k = 0; k <= steps; k++) {
    const val = (maxBps / steps) * k;
    const y = toY(val);
    svg.appendChild(svgEl('line', {
      x1: padL, y1: y, x2: W - padR, y2: y,
      stroke: k === 0 ? 'rgba(255,255,255,0.24)' : 'rgba(255,255,255,0.12)',
      'stroke-dasharray': k === 0 ? '' : '3 4'
    }));
    if (k > 0) {
      const lbl = svgEl('text', {
        x: W - 4, y: y + 3,
        fill: 'rgba(255, 255, 255, 0.84)',
        stroke: 'rgba(4, 6, 12, 0.85)',
        'stroke-width': '2.4',
        'paint-order': 'stroke',
        'font-size': '9', 'font-weight': '600',
        'text-anchor': 'end', 'font-family': 'monospace'
      });
      lbl.textContent = ((val * 8) / 1e6).toFixed(val * 8 >= 10e6 ? 0 : 1) + 'M';
      svg.appendChild(lbl);
    }
  }

  const dDown = buildPolylinePath(down, n, toX, toY, padT, baseY);
  const dUp = buildPolylinePath(up, n, toX, toY, padT, baseY);
  const hasFocus = !!(focus && focus.length >= 2 && lastFocus);
  const aggOp = hasFocus ? '0.38' : '0.94';

  const dArea = `${dDown} L${toX(n - 1).toFixed(1)},${baseY.toFixed(1)} L${padL},${baseY.toFixed(1)} Z`;
  svg.appendChild(svgEl('path', { d: dArea, fill: 'url(#scopeWhiteG)', opacity: hasFocus ? '0.35' : '1' }));

  // Clean continuous translucent ice-white upload polyline
  svg.appendChild(svgEl('path', {
    d: dUp, fill: 'none', stroke: 'rgba(218, 236, 255, 0.62)', 'stroke-width': '1.25', 'stroke-linejoin': 'bevel', opacity: aggOp
  }));

  // Crisp single-stroke white download polyline (zero outer sleeve)
  svg.appendChild(svgEl('path', {
    d: dDown, fill: 'none', stroke: 'rgba(255, 255, 255, 0.96)', 'stroke-width': '1.85', 'stroke-linejoin': 'bevel', opacity: aggOp
  }));

  // Focused strand clean overlay polyline (zero outer sleeve or terminal dot)
  const tipX = toX(n - 1);
  if (hasFocus) {
    const dFocus = buildPolylinePath(focus, n, toX, toY, padT, baseY);
    const dFocusArea = `${dFocus} L${tipX.toFixed(1)},${baseY.toFixed(1)} L${padL},${baseY.toFixed(1)} Z`;
    svg.appendChild(svgEl('path', { d: dFocusArea, fill: 'url(#scopeFocusG)' }));
    svg.appendChild(svgEl('path', { d: dFocus, fill: 'none', stroke: '#ffffff', 'stroke-width': '2.0', 'stroke-linejoin': 'bevel' }));
  }

  const cursorLine = svgEl('line', {
    x1: -10, y1: padT, x2: -10, y2: baseY,
    stroke: '#ffffff', 'stroke-width': '1.1', 'stroke-dasharray': '2 3', visibility: 'hidden'
  });
  svg.appendChild(cursorLine);

  const hit = svgEl('rect', { x: padL, y: 0, width: plotW, height: H, fill: 'transparent', style: 'cursor:crosshair' });
  hit.addEventListener('mousemove', (e) => {
    const box = svg.getBoundingClientRect();
    const rx = ((e.clientX - box.left) / box.width) * W;
    const idx = Math.max(0, Math.min(n - 1, Math.round(((rx - padL) / plotW) * (n - 1))));
    const cx = toX(idx);
    cursorLine.setAttribute('x1', cx);
    cursorLine.setAttribute('x2', cx);
    cursorLine.setAttribute('visibility', 'visible');
    if (tip) {
      if (lastFocus) {
        tip.classList.remove('spectrum');
        tip.style.borderColor = lastFocus.css;
        tip.style.borderImage = 'none';
        tip.style.boxShadow = `0 0 18px rgba(${lastFocus.rgb}, 0.34), 0 0 36px rgba(${lastFocus.rgb}, 0.14), 0 14px 36px rgba(0,0,0,0.92)`;
      } else {
        tip.classList.add('spectrum');
        tip.style.borderColor = '';
        tip.style.borderImage = '';
        tip.style.boxShadow = '';
      }
      const fVal = hasFocus ? focus[idx] : null;
      const focusRow = (lastFocus && fVal != null)
        ? `<span class="tt-k" style="color:${lastFocus.css}">${lastFocus.dev}</span><span class="tt-v">${fmtRate(fVal).full}</span>`
        : '';
      tip.innerHTML = `
        <div class="tt-head"><span>${fmtClock(ts[idx])}</span><span class="c-muted">2s window</span></div>
        <div class="tt-grid">
          <span class="tt-k c-bright">總下行</span><span class="tt-v">${fmtRate(down[idx]).full}</span>
          <span class="tt-k c-sec">總上行</span><span class="tt-v">${fmtRate(up[idx] || 0).full}</span>
          ${focusRow}
        </div>
      `;
      tip.style.left = Math.min(Math.max(10, box.width - 220), Math.max(10, e.clientX - box.left + 12)) + 'px';
      tip.classList.add('show');
    }
  });
  hit.addEventListener('mouseleave', () => {
    cursorLine.setAttribute('visibility', 'hidden');
    tip?.classList.remove('show');
  });
  svg.appendChild(hit);
}
