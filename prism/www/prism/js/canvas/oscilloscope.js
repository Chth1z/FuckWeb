/* ============================================================================
 * PRISM 5.6 — Thick Rainbow-Bar Overlaid White SVG Throughput Oscilloscope
 * ============================================================================ */

import { S, fmtRate, fmtClock } from '../state.js?v=5.6.6';
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

function buildLinePath(series, n, toX, toY) {
  let d = '';
  for (let i = 0; i < n; i++) {
    const cmd = i === 0 ? 'M' : 'L';
    d += `${cmd}${toX(i).toFixed(1)},${toY(series[i] || 0).toFixed(1)}`;
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
  const ts = ser.ts.slice(sliceStart);
  const down = ser.total.slice(sliceStart);
  const up = (ser.up || []).slice(sliceStart);
  const n = ts.length;

  const focusDev = lastFocus?.dev || '';
  const fRaw = focusDev && Array.isArray(ser.strands?.[focusDev]) ? ser.strands[focusDev] : null;
  const focusDown = fRaw ? fRaw.slice(Math.max(0, fRaw.length - n)) : null;

  const rect = svg.getBoundingClientRect?.();
  const W = rect && rect.width > 120 ? Math.round(rect.width) : 1200;
  const H = rect && rect.height > 32 ? Math.round(rect.height) : 84;

  const sig = `${W}x${H}:${n}:${ts[n - 1]}:${down[n - 1]}:${up[n - 1]}:${chartLimit}:${focusDev}:${focusDown ? focusDown[focusDown.length - 1] : ''}`;
  if (sig === lastSig) return;
  lastSig = sig;

  svg.setAttribute('viewBox', `0 0 ${W} ${H}`);

  const padL = 40, padR = 6, padT = 8, padB = 6;
  const plotW = Math.max(20, W - padL - padR);
  const plotH = Math.max(18, H - padT - padB);

  let maxBps = 1250000; // min 10 Mbps scale
  for (let i = 0; i < n; i++) {
    if (down[i] > maxBps) maxBps = down[i];
    if ((up[i] || 0) > maxBps) maxBps = up[i];
  }
  maxBps *= 1.12;

  const toX = (i) => padL + (i / Math.max(1, n - 1)) * plotW;
  const toY = (bps) => padT + plotH - (Math.max(0, bps) / maxBps) * plotH;

  svg.innerHTML = '';

  const defs = svgEl('defs');
  const gradWhite = svgEl('linearGradient', { id: 'scopeWhiteG', x1: '0', y1: '0', x2: '0', y2: '1' },
    svgEl('stop', { offset: '0%', 'stop-color': '#ffffff', 'stop-opacity': '0.24' }),
    svgEl('stop', { offset: '100%', 'stop-color': '#ffffff', 'stop-opacity': '0.03' })
  );
  defs.appendChild(gradWhite);
  svg.appendChild(defs);

  // Subtle translucent grid lines & white haloed Y scale text over rainbow bar
  const steps = 2;
  for (let k = 0; k <= steps; k++) {
    const val = (maxBps / steps) * k;
    const y = toY(val);
    svg.appendChild(svgEl('line', {
      x1: padL, y1: y, x2: W - padR, y2: y,
      stroke: k === 0 ? 'rgba(255,255,255,0.22)' : 'rgba(255,255,255,0.12)',
      'stroke-dasharray': k === 0 ? '' : '3 4'
    }));
    if (k > 0) {
      const lbl = svgEl('text', {
        x: padL - 5, y: y + 3,
        fill: 'rgba(255, 255, 255, 0.90)',
        stroke: 'rgba(4, 6, 12, 0.85)',
        'stroke-width': '2.6',
        'paint-order': 'stroke',
        'font-size': '9.5', 'font-weight': '600',
        'text-anchor': 'end', 'font-family': 'monospace'
      });
      lbl.textContent = ((val * 8) / 1e6).toFixed(val * 8 >= 10e6 ? 0 : 1) + 'M';
      svg.appendChild(lbl);
    }
  }

  const dDown = buildLinePath(down, n, toX, toY);
  const dUp = buildLinePath(up, n, toX, toY);
  const hasFocus = !!(focusDown && focusDown.length >= 2 && lastFocus);
  const aggOp = hasFocus ? '0.42' : '0.90';

  // White translucent area + dark halo shadow + crisp white strokes matching tile aesthetic
  const dArea = `${dDown} L${toX(n - 1).toFixed(1)},${(padT + plotH).toFixed(1)} L${padL},${(padT + plotH).toFixed(1)} Z`;
  svg.appendChild(svgEl('path', { d: dArea, fill: 'url(#scopeWhiteG)', opacity: hasFocus ? '0.45' : '1' }));

  svg.appendChild(svgEl('path', { d: dUp, fill: 'none', stroke: 'rgba(4, 6, 12, 0.40)', 'stroke-width': '2.4', opacity: aggOp }));
  svg.appendChild(svgEl('path', { d: dUp, fill: 'none', stroke: 'rgba(255, 255, 255, 0.56)', 'stroke-width': '1.15', 'stroke-dasharray': '3 2.5', opacity: aggOp }));

  svg.appendChild(svgEl('path', { d: dDown, fill: 'none', stroke: 'rgba(4, 6, 12, 0.50)', 'stroke-width': '3.6', opacity: aggOp }));
  svg.appendChild(svgEl('path', { d: dDown, fill: 'none', stroke: 'rgba(255, 255, 255, 0.92)', 'stroke-width': '1.8', opacity: aggOp }));

  // Highlight hovered/pinned single strand directly over its bright rainbow slots
  if (hasFocus) {
    const fn = focusDown.length;
    const fOff = Math.max(0, n - fn);
    const toFocusX = (i) => toX(fOff + i);
    const dFocus = buildLinePath(focusDown, fn, toFocusX, toY);
    const dFocusArea = `${dFocus} L${toFocusX(fn - 1).toFixed(1)},${(padT + plotH).toFixed(1)} L${toFocusX(0).toFixed(1)},${(padT + plotH).toFixed(1)} Z`;
    svg.appendChild(svgEl('path', { d: dFocusArea, fill: 'rgba(255, 255, 255, 0.20)' }));
    svg.appendChild(svgEl('path', { d: dFocus, fill: 'none', stroke: 'rgba(4, 6, 12, 0.65)', 'stroke-width': '3.8' }));
    svg.appendChild(svgEl('path', { d: dFocus, fill: 'none', stroke: '#ffffff', 'stroke-width': '2.0' }));
  }

  const cursorLine = svgEl('line', {
    x1: -10, y1: padT, x2: -10, y2: padT + plotH,
    stroke: '#ffffff', 'stroke-width': '1.2', 'stroke-dasharray': '2 3', visibility: 'hidden'
  });
  svg.appendChild(cursorLine);

  const hit = svgEl('rect', { x: padL, y: padT, width: plotW, height: plotH, fill: 'transparent', style: 'cursor:crosshair' });
  hit.addEventListener('mousemove', (e) => {
    const box = svg.getBoundingClientRect();
    const rx = ((e.clientX - box.left) / box.width) * W;
    const idx = Math.max(0, Math.min(n - 1, Math.round(((rx - padL) / plotW) * (n - 1))));
    const cx = toX(idx);
    cursorLine.setAttribute('x1', cx);
    cursorLine.setAttribute('x2', cx);
    cursorLine.setAttribute('visibility', 'visible');
    if (tip) {
      const fVal = focusDown ? focusDown[idx - Math.max(0, n - focusDown.length)] : null;
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
