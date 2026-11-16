/* ============================================================================
 * PRISM 5.6 — Ribbon-Integrated Dual-Channel + Hover-Overlay SVG Oscilloscope
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
  const H = rect && rect.height > 24 ? Math.round(rect.height) : 54;

  const sig = `${W}x${H}:${n}:${ts[n - 1]}:${down[n - 1]}:${up[n - 1]}:${chartLimit}:${focusDev}:${focusDown ? focusDown[focusDown.length - 1] : ''}`;
  if (sig === lastSig) return;
  lastSig = sig;

  svg.setAttribute('viewBox', `0 0 ${W} ${H}`);

  const padL = 40, padR = 6, padT = 6, padB = 4;
  const plotW = Math.max(20, W - padL - padR);
  const plotH = Math.max(14, H - padT - padB);

  let maxBps = 1250000; // min 10 Mbps floor
  for (let i = 0; i < n; i++) {
    if (down[i] > maxBps) maxBps = down[i];
    if ((up[i] || 0) > maxBps) maxBps = up[i];
  }
  maxBps *= 1.12;

  const toX = (i) => padL + (i / Math.max(1, n - 1)) * plotW;
  const toY = (bps) => padT + plotH - (Math.max(0, bps) / maxBps) * plotH;

  svg.innerHTML = '';

  const defs = svgEl('defs');
  const gradDown = svgEl('linearGradient', { id: 'scopeDownG', x1: '0', y1: '0', x2: '0', y2: '1' },
    svgEl('stop', { offset: '0%', 'stop-color': '#5bc28c', 'stop-opacity': '0.26' }),
    svgEl('stop', { offset: '100%', 'stop-color': '#5bc28c', 'stop-opacity': '0.01' })
  );
  defs.appendChild(gradDown);
  svg.appendChild(defs);

  // Subtle horizontal reference guidelines + peak/mid scale labels
  const steps = 2;
  for (let k = 0; k <= steps; k++) {
    const val = (maxBps / steps) * k;
    const y = toY(val);
    svg.appendChild(svgEl('line', {
      x1: padL, y1: y, x2: W - padR, y2: y,
      stroke: k === 0 ? 'rgba(255,255,255,0.12)' : 'rgba(255,255,255,0.06)',
      'stroke-dasharray': k === 0 ? '' : '3 4'
    }));
    if (k > 0) {
      const lbl = svgEl('text', {
        x: padL - 5, y: y + 3,
        fill: '#8e9bb3', 'font-size': '9', 'text-anchor': 'end', 'font-family': 'monospace'
      });
      lbl.textContent = ((val * 8) / 1e6).toFixed(val * 8 >= 10e6 ? 0 : 1) + 'M';
      svg.appendChild(lbl);
    }
  }

  const dDown = buildLinePath(down, n, toX, toY);
  const dUp = buildLinePath(up, n, toX, toY);

  const dArea = `${dDown} L${toX(n - 1).toFixed(1)},${(padT + plotH).toFixed(1)} L${padL},${(padT + plotH).toFixed(1)} Z`;
  svg.appendChild(svgEl('path', { d: dArea, fill: 'url(#scopeDownG)' }));
  svg.appendChild(svgEl('path', { d: dUp, fill: 'none', stroke: '#64aef5', 'stroke-width': '2.6', opacity: '0.22' }));
  svg.appendChild(svgEl('path', { d: dUp, fill: 'none', stroke: '#64aef5', 'stroke-width': '1.25', opacity: '0.90' }));
  svg.appendChild(svgEl('path', { d: dDown, fill: 'none', stroke: '#57d192', 'stroke-width': '3.6', opacity: '0.26' }));
  svg.appendChild(svgEl('path', { d: dDown, fill: 'none', stroke: '#57d192', 'stroke-width': '1.65' }));

  // Highlighted strand trace overlay above its glowing rainbow slots
  if (focusDown && focusDown.length >= 2 && lastFocus) {
    const fn = focusDown.length;
    const fOff = Math.max(0, n - fn);
    const toFocusX = (i) => toX(fOff + i);
    const dFocus = buildLinePath(focusDown, fn, toFocusX, toY);
    const dFocusArea = `${dFocus} L${toFocusX(fn - 1).toFixed(1)},${(padT + plotH).toFixed(1)} L${toFocusX(0).toFixed(1)},${(padT + plotH).toFixed(1)} Z`;
    svg.appendChild(svgEl('path', { d: dFocusArea, fill: `rgba(${lastFocus.rgb}, 0.18)` }));
    svg.appendChild(svgEl('path', { d: dFocus, fill: 'none', stroke: lastFocus.css, 'stroke-width': '4.0', opacity: '0.32' }));
    svg.appendChild(svgEl('path', { d: dFocus, fill: 'none', stroke: lastFocus.css, 'stroke-width': '1.8' }));
  }

  const cursorLine = svgEl('line', {
    x1: -10, y1: padT, x2: -10, y2: padT + plotH,
    stroke: '#ebc465', 'stroke-width': '1', 'stroke-dasharray': '2 3', visibility: 'hidden'
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
          <span class="tt-k c-mint">總下行</span><span class="tt-v">${fmtRate(down[idx]).full}</span>
          <span class="tt-k c-blue">總上行</span><span class="tt-v">${fmtRate(up[idx] || 0).full}</span>
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
