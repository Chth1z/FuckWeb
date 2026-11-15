/* ============================================================================
 * PRISM 5.0 — Dual-Channel SVG Throughput Oscilloscope
 * ============================================================================ */

import { S, fmtRate, fmtClock } from '../state.js?v=5.6.1';
import { $, svgEl } from '../dom.js?v=5.6.1';

let lastSig = '';
let chartLimit = 360;

export function setChartLimit(lim) {
  chartLimit = lim;
  lastSig = '';
  renderOscilloscope();
}

export function getChartLimit() {
  return chartLimit;
}

export function renderOscilloscope() {
  const svg = $('#chart');
  const tip = $('#tip');
  const ser = S.series;
  if (!svg || !ser || !ser.ts || ser.ts.length < 2) return;

  const sliceStart = Math.max(0, ser.ts.length - chartLimit);
  const ts = ser.ts.slice(sliceStart);
  const down = ser.total.slice(sliceStart);
  const up = (ser.up || []).slice(sliceStart);
  const n = ts.length;

  const sig = `${n}:${ts[n - 1]}:${down[n - 1]}:${up[n - 1]}:${chartLimit}`;
  if (sig === lastSig) return;
  lastSig = sig;

  const W = 900, H = 210;
  const padL = 44, padR = 12, padT = 14, padB = 22;
  const plotW = W - padL - padR;
  const plotH = H - padT - padB;

  let maxBps = 1250000; // min 10 Mbps scale
  for (let i = 0; i < n; i++) {
    if (down[i] > maxBps) maxBps = down[i];
    if ((up[i] || 0) > maxBps) maxBps = up[i];
  }
  maxBps *= 1.15;

  const toX = (i) => padL + (i / Math.max(1, n - 1)) * plotW;
  const toY = (bps) => padT + plotH - (Math.max(0, bps) / maxBps) * plotH;

  svg.innerHTML = '';

  const defs = svgEl('defs');
  const gradDown = svgEl('linearGradient', { id: 'scopeDownG', x1: '0', y1: '0', x2: '0', y2: '1' },
    svgEl('stop', { offset: '0%', 'stop-color': '#5bc28c', 'stop-opacity': '0.32' }),
    svgEl('stop', { offset: '100%', 'stop-color': '#5bc28c', 'stop-opacity': '0.01' })
  );
  defs.appendChild(gradDown);
  svg.appendChild(defs);

  // Horizontal dashed grid + Y-axis labels
  const steps = 3;
  for (let k = 0; k <= steps; k++) {
    const val = (maxBps / steps) * k;
    const y = toY(val);
    svg.appendChild(svgEl('line', {
      x1: padL, y1: y, x2: W - padR, y2: y,
      stroke: k === 0 ? '#252a3a' : '#181c28',
      'stroke-dasharray': k === 0 ? '' : '3 4'
    }));
    const lbl = svgEl('text', {
      x: padL - 6, y: y + 4,
      fill: '#7f8ca6', 'font-size': '11', 'text-anchor': 'end', 'font-family': 'monospace'
    });
    lbl.textContent = ((val * 8) / 1e6).toFixed(val * 8 >= 10e6 ? 0 : 1) + 'M';
    svg.appendChild(lbl);
  }

  let dDown = '', dUp = '';
  for (let i = 0; i < n; i++) {
    const cmd = i === 0 ? 'M' : 'L';
    const x = toX(i).toFixed(1);
    dDown += `${cmd}${x},${toY(down[i]).toFixed(1)}`;
    dUp += `${cmd}${x},${toY(up[i] || 0).toFixed(1)}`;
  }

  // Area fill + glowing dual-channel waveforms
  const dArea = dDown + ` L${toX(n - 1).toFixed(1)},${(padT + plotH).toFixed(1)} L${padL},${(padT + plotH).toFixed(1)} Z`;
  svg.appendChild(svgEl('path', { d: dArea, fill: 'url(#scopeDownG)' }));
  svg.appendChild(svgEl('path', { d: dUp, fill: 'none', stroke: '#64aef5', 'stroke-width': '3.8', opacity: '0.22' }));
  svg.appendChild(svgEl('path', { d: dUp, fill: 'none', stroke: '#64aef5', 'stroke-width': '1.4', opacity: '0.88' }));
  svg.appendChild(svgEl('path', { d: dDown, fill: 'none', stroke: '#57d192', 'stroke-width': '4.6', opacity: '0.24' }));
  svg.appendChild(svgEl('path', { d: dDown, fill: 'none', stroke: '#57d192', 'stroke-width': '1.8' }));

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
      tip.innerHTML = `
        <div class="tt-head"><span>${fmtClock(ts[idx])}</span><span class="c-muted">2s window</span></div>
        <div class="tt-grid">
          <span class="tt-k c-mint">下行</span><span class="tt-v">${fmtRate(down[idx]).full}</span>
          <span class="tt-k c-blue">上行</span><span class="tt-v">${fmtRate(up[idx] || 0).full}</span>
        </div>
      `;
      tip.style.left = Math.min(box.width - 190, Math.max(10, e.clientX - box.left + 12)) + 'px';
      tip.style.top = '10px';
      tip.classList.add('show');
    }
  });
  hit.addEventListener('mouseleave', () => {
    cursorLine.setAttribute('visibility', 'hidden');
    tip?.classList.remove('show');
  });
  svg.appendChild(hit);
}
