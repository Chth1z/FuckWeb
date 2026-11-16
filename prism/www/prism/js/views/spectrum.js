/* ============================================================================
 * PRISM — View 03: Full-Page Gapless 21-Ch Pure Color Matrix & Slot Bars
 * ============================================================================ */

import { S, spectralColor, fmtRateCompact } from '../state.js?v=5.6.6';
import { $, $$, el, svgEl } from '../dom.js?v=5.6.6';

let hoverStrandId = null;
let chartLimit = 360;
const strandMetaById = new Map();

const fmtShortRate = (bps) => fmtRateCompact(bps, '0');

function getActiveStrandId() {
  return hoverStrandId != null ? hoverStrandId : S.pinnedStrandId;
}

function downsamplePeak(arr, maxPts = 44) {
  const n = arr.length;
  if (n <= maxPts) return arr;
  const out = new Array(maxPts);
  const step = n / maxPts;
  for (let i = 0; i < maxPts; i++) {
    const start = Math.floor(i * step);
    const end = Math.min(n, Math.floor((i + 1) * step));
    let peak = 0;
    for (let j = start; j < end; j++) {
      if ((arr[j] || 0) > peak) peak = arr[j];
    }
    out[i] = peak;
  }
  return out;
}

function sparkPathCoords(pts, maxVal) {
  const W = 100, padT = 3, padB = 1.5;
  const plotH = 32 - padT - padB;
  const n = pts.length;
  let d = '';
  for (let i = 0; i < n; i++) {
    const x = (i / Math.max(1, n - 1)) * W;
    const y = padT + plotH - Math.min(1, Math.max(0, (pts[i] || 0) / maxVal)) * plotH;
    d += `${i === 0 ? 'M' : 'L'}${x.toFixed(1)},${y.toFixed(1)}`;
  }
  return d;
}

function renderTileSpark(tile, dev) {
  const svg = tile._ui?.spark;
  if (!svg) return;
  const ser = S.series;
  const lastTs = ser?.ts?.length ? ser.ts[ser.ts.length - 1] : 0;
  const key = `${dev}:${chartLimit}:${lastTs}`;
  if (tile._sparkKey === key) return;
  tile._sparkKey = key;

  svg.innerHTML = '';
  const rawDown = ser?.strands?.[dev];
  if (!Array.isArray(rawDown) || rawDown.length < 2) return;

  const rawUp = Array.isArray(ser?.strands_up?.[dev]) ? ser.strands_up[dev] : [];
  const slDown = downsamplePeak(rawDown.slice(Math.max(0, rawDown.length - chartLimit)), 44);
  const slUp = rawUp.length >= 2
    ? downsamplePeak(rawUp.slice(Math.max(0, rawUp.length - chartLimit)), slDown.length)
    : [];

  let peakBps = 125000;
  for (let i = 0; i < slDown.length; i++) {
    if ((slDown[i] || 0) > peakBps) peakBps = slDown[i];
    if ((slUp[i] || 0) > peakBps) peakBps = slUp[i];
  }
  const scaleMax = peakBps * 1.10;

  const dDown = sparkPathCoords(slDown, scaleMax);
  const dArea = `${dDown} L100.0,32.0 L0.0,32.0 Z`;
  svg.appendChild(svgEl('path', { d: dArea, fill: 'rgba(255, 255, 255, 0.11)' }));

  if (slUp.length === slDown.length && slUp.some(v => v > 0)) {
    svg.appendChild(svgEl('path', {
      d: sparkPathCoords(slUp, scaleMax),
      fill: 'none',
      stroke: 'rgba(255, 255, 255, 0.24)',
      'stroke-width': '0.85'
    }));
  }

  svg.appendChild(svgEl('path', {
    d: dDown,
    fill: 'none',
    stroke: 'rgba(255, 255, 255, 0.48)',
    'stroke-width': '1.2'
  }));
}

function renderSlotBar(barEl, slotsCount, slotCols, maxSlots, healthy) {
  if (!barEl) return;
  const lit = !healthy ? 0
    : (maxSlots > slotCols
      ? Math.min(slotCols, Math.round((slotsCount / maxSlots) * slotCols))
      : Math.min(slotCols, Math.max(0, slotsCount)));
  const sig = `${slotCols}:${lit}`;
  if (barEl.dataset.sig === sig) return;
  barEl.dataset.sig = sig;
  barEl.style.setProperty('--slot-cols', String(slotCols));

  const frag = document.createDocumentFragment();
  for (let i = 0; i < slotCols; i++) {
    frag.appendChild(el('span', { class: i < lit ? 'heat-slot-cell on' : 'heat-slot-cell' }));
  }
  barEl.innerHTML = '';
  barEl.appendChild(frag);
}

function syncStrandHighlight() {
  const activeId = getActiveStrandId();
  const activeMeta = activeId != null ? (strandMetaById.get(activeId) || null) : null;

  const tiles = $('#spectrum-heatmap')?.children || [];
  for (const tile of tiles) {
    const id = Number(tile.dataset.sid);
    tile.classList.toggle('pinned', S.pinnedStrandId != null && id === S.pinnedStrandId);
    if (activeId == null) {
      tile.classList.remove('dim', 'hi');
    } else {
      tile.classList.toggle('hi', id === activeId);
      tile.classList.toggle('dim', id !== activeId);
    }
  }

  const ticks = $('#pattern')?.children || [];
  for (const t of ticks) {
    const id = Number(t.dataset.sid);
    if (activeId == null) {
      t.classList.remove('dim', 'hi');
    } else {
      t.classList.toggle('hi', id === activeId);
      t.classList.toggle('dim', id !== activeId);
    }
  }

  const activeTag = $('#spec-active-tag');
  if (activeTag) {
    if (activeMeta) {
      const modeLabel = hoverStrandId != null && hoverStrandId !== S.pinnedStrandId ? 'HOVER' : 'PINNED';
      activeTag.textContent = `${modeLabel} · ${activeMeta.dev} (λ=${activeMeta.lambda}nm)`;
      activeTag.style.color = activeMeta.css;
    } else {
      const strands = S.status?.strands || [];
      const nOk = S.status?.healthy_count ?? strands.filter(s => s.healthy).length;
      activeTag.textContent = `${nOk}/${strands.length || 21} 波長在線`;
      activeTag.style.color = '';
    }
  }

  const hintEl = $('#spec-pin-hint');
  if (hintEl) {
    hintEl.textContent = S.pinnedStrandId != null
      ? `已鎖定 ${strandMetaById.get(S.pinnedStrandId)?.dev || ''} · 再按一次或 Esc 解除`
      : '懸停／點擊鎖定單路 · Esc 解除';
  }
}

function setHoverStrand(strandId) {
  hoverStrandId = strandId;
  syncStrandHighlight();
}

function togglePinStrand(strandId) {
  S.pinnedStrandId = (S.pinnedStrandId === strandId) ? null : strandId;
  syncStrandHighlight();
}

export function bindSpectrumEvents() {
  $$('#chart-range .seg-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      chartLimit = Number(btn.dataset.limit || 360);
      $$('#chart-range .seg-btn').forEach(b => b.classList.toggle('on', Number(b.dataset.limit) === chartLimit));
      renderSpectrum();
    });
  });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && S.tab === 'spectrum' && S.pinnedStrandId != null) {
      S.pinnedStrandId = null;
      syncStrandHighlight();
    }
  });
}

function buildHeatmapTiles(grid, strands) {
  const frag = document.createDocumentFragment();
  const total = Math.max(1, strands.length);
  strands.forEach((s, idx) => {
    const col = spectralColor(idx, total);
    const shortName = s.dev === 'wan' ? 'wan' : String(s.dev || idx).replace(/^vwan/, 'v');

    const spark = svgEl('svg', {
      class: 'heat-spark',
      viewBox: '0 0 100 32',
      preserveAspectRatio: 'none',
      'aria-hidden': 'true'
    });
    const nameEl = el('span', { class: 'heat-name' }, shortName);
    const lamEl = el('span', { class: 'heat-lam' }, `${col.lambda}nm`);
    const flagEl = el('span', { class: 'heat-flag' }, '');
    const rttEl = el('span', { class: 'heat-rtt' }, '—');
    const downEl = el('span', { class: 'heat-rate-down idle' }, 'idle');
    const subEl = el('span', { class: 'heat-rate-sub' }, '');
    const brEl = el('span', { class: 'heat-br' }, '100% · 0槽');
    const slotsBarEl = el('div', { class: 'heat-slots-bar', 'aria-label': '分配槽位條' });

    const tile = el('div', {
      class: 'heat-tile',
      role: 'gridcell',
      tabindex: '0',
      'data-sid': s.id,
      'aria-label': `${s.dev} 波長 ${col.lambda}nm`,
      style: { '--sc-rgb': col.rgb },
      onMouseenter: () => setHoverStrand(s.id),
      onMouseleave: () => setHoverStrand(null),
      onFocus: () => setHoverStrand(s.id),
      onBlur: () => setHoverStrand(null),
      onClick: () => togglePinStrand(s.id),
      onKeydown: (e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          togglePinStrand(s.id);
        }
      }
    },
      spark,
      el('div', { class: 'heat-top' },
        el('div', { class: 'heat-top-row' },
          el('div', { class: 'heat-tl' }, nameEl, lamEl),
          el('div', { class: 'heat-tr' }, rttEl, flagEl)
        ),
        el('div', { class: 'heat-speed-tl' }, downEl, subEl)
      ),
      el('div', { class: 'heat-bottom' },
        slotsBarEl,
        brEl
      )
    );

    tile._ui = { spark, rttEl, flagEl, downEl, subEl, brEl, slotsBarEl };
    frag.appendChild(tile);
  });
  grid.innerHTML = '';
  grid.appendChild(frag);
  grid.dataset.count = String(strands.length);
}

function updateHeatmap(strands) {
  const grid = $('#spectrum-heatmap');
  if (!grid || !strands.length) return;
  if (Number(grid.dataset.count) !== strands.length) {
    buildHeatmapTiles(grid, strands);
  }

  const total = Math.max(1, strands.length);
  let maxMbps = 0.05;
  let maxSlots = 6;
  const mbpsList = strands.map(s => {
    const m = ((s.now ?? s.rate ?? 0) + (s.up_now ?? s.up ?? 0)) * 8 / 1e6;
    if (m > maxMbps) maxMbps = m;
    if ((s.slots || 0) > maxSlots) maxSlots = s.slots;
    return m;
  });
  const slotCols = Math.min(18, Math.max(6, maxSlots));

  const tiles = grid.children;
  for (let i = 0; i < strands.length; i++) {
    const s = strands[i];
    const tile = tiles[i];
    if (!tile || !tile._ui) continue;

    const col = spectralColor(i, total);
    const pct = s.healthy ? Math.max(0, Math.min(100, s.tokens_pct ?? 100)) : 0;
    const downBps = s.now ?? s.rate ?? 0;
    const upBps = s.up_now ?? s.up ?? 0;
    const rateTotal = downBps + upBps;
    const mbps = mbpsList[i];
    const rel = maxMbps > 0.12 ? mbps / maxMbps : 0;
    const absPulse = Math.min(1, Math.log10(1 + mbps * 6) / 1.45);
    const activeIntensity = Math.max(absPulse, rel * 0.90);

    // Rich saturated pure color fill modulated by real-time load
    const baseContrast = !s.healthy ? 0.06
      : (s.bucket === 'depleted' ? 0.08
        : (s.bucket === 'cooling' ? 0.10 : (0.12 + (pct / 100) * 0.06)));
    const heat = s.healthy ? Math.min(1, activeIntensity * 0.88 + (s.vip ? 0.12 : 0)) : 0;
    const fillAlpha = !s.healthy ? 0.08 : Math.min(0.88, baseContrast + activeIntensity * 0.74);

    tile.classList.toggle('vip', !!s.vip);
    tile.classList.toggle('down', !s.healthy);

    tile.style.setProperty('--sc-rgb', col.rgb);
    tile.style.setProperty('--heat-fill', fillAlpha.toFixed(2));
    tile.style.setProperty('--heat-halo', (heat > 0.08 ? 0.14 + heat * 0.68 : 0.04).toFixed(2));
    tile.style.setProperty('--heat-outer', (heat > 0.12 ? 0.06 + heat * 0.34 : 0.00).toFixed(2));
    tile.style.setProperty('--heat-crest', (0.03 + heat * 0.24).toFixed(2));
    tile.style.setProperty('--heat-blur', `${Math.round(12 + heat * 18)}px`);
    tile.style.setProperty('--heat-bloom', `${Math.round(22 + heat * 26)}px`);
    tile.style.setProperty('--heat-label-op', (!s.healthy ? 0.44 : (0.76 + heat * 0.24)).toFixed(2));

    tile.title = `${s.dev} (λ=${col.lambda}nm) · ${s.ip || '無租約'} · ↓${fmtShortRate(downBps)} ↑${fmtShortRate(upBps)} · pk ${fmtShortRate(s.peak)} · τ=${s.ttfb_ms || '—'}ms · loss ${s.loss_pct ?? 0}% · tokens ${Math.round(pct)}% · slots ${s.slots ?? 0}`;

    const ui = tile._ui;

    // Subtle contour sparkline at tile lower background
    renderTileSpark(tile, s.dev);

    // Top-right corner: RTT/loss + status flag
    const lossPct = s.loss_pct ?? 0;
    const rttTxt = s.ttfb_ms > 0 ? `${s.ttfb_ms}ms` : '—';
    ui.rttEl.textContent = lossPct > 0 ? `${rttTxt}·${lossPct}%` : rttTxt;
    ui.rttEl.style.color = lossPct >= 15 ? 'var(--c-amber)' : '';

    if (!s.healthy) {
      ui.flagEl.className = 'heat-flag down';
      ui.flagEl.textContent = s.parked ? 'PARK' : 'OFF';
      ui.flagEl.style.display = '';
    } else if (s.vip) {
      ui.flagEl.className = 'heat-flag vip';
      ui.flagEl.textContent = 'VIP';
      ui.flagEl.style.display = '';
    } else if (s.cooldown_rem > 0) {
      ui.flagEl.className = 'heat-flag cool';
      ui.flagEl.textContent = `${s.cooldown_rem}s`;
      ui.flagEl.style.display = '';
    } else {
      ui.flagEl.style.display = 'none';
    }

    // Bottom-left corner: speed + upload/peak compact inline
    const hasDown = downBps * 8 > 500;
    const hasUp = upBps * 8 > 500;
    ui.downEl.textContent = hasDown ? `↓${fmtShortRate(downBps)}` : (rateTotal > 0 ? '↓0' : 'idle');
    ui.downEl.className = `heat-rate-down${hasDown ? '' : ' idle'}`;
    ui.subEl.textContent = hasUp ? `↑${fmtShortRate(upBps)}·pk${fmtShortRate(s.peak)}` : `pk${fmtShortRate(s.peak)}`;

    // Bottom-right corner: token % + slots count
    const tokLabel = `${Math.round(pct)}%`;
    const slotLabel = s.vip ? ((s.slots || 0) > 0 ? `VIP·${s.slots}槽` : 'VIP') : `${s.slots ?? 0}槽`;
    ui.brEl.textContent = `${tokLabel} · ${slotLabel}`;

    // Bottom edge: slot bar in matching wavelength color & exact slot count
    renderSlotBar(ui.slotsBarEl, s.slots || 0, slotCols, maxSlots, s.healthy);
  }
}

export function renderSpectrum() {
  const st = S.status;
  if (!st) return;

  const strands = st.strands || [];
  const w = st.weave || {};
  const pat = w.pattern || [];
  strandMetaById.clear();
  const colorById = {};
  strands.forEach((s, idx) => {
    const col = spectralColor(idx, Math.max(1, strands.length));
    colorById[s.id] = col;
    strandMetaById.set(s.id, { id: s.id, dev: s.dev, lambda: col.lambda, rgb: col.rgb, css: col.css });
  });

  if (S.pinnedStrandId != null && !strands.some(s => s.id === S.pinnedStrandId)) {
    S.pinnedStrandId = null;
  }

  // 1. Header capacity & compact summary KPIs
  const capEl = $('#weave-cap');
  if (capEl) capEl.textContent = `${w.slots || pat.length || 126} slots · VIP=${w.vip_dev || '—'} · ${w.interval || 2}s`;
  const kpiEl = $('#spec-summary-kpi');
  if (kpiEl) {
    kpiEl.textContent = `${w.charged_count ?? 0}/${st.healthy_count ?? strands.length} 滿桶 · ↓ ${fmtShortRate(st.rate || 0)} · ↑ ${fmtShortRate(st.rate_up || 0)}`;
  }

  // 2. Full-Page Gapless 21-Wavelength Pure Color Matrix
  updateHeatmap(strands);

  // 3. Full-Width 126-Slot Kernel Timeline Ribbon
  const mat = $('#pattern');
  if (mat) {
    const sig = pat.join(',');
    if (mat.dataset.sig !== sig) {
      mat.dataset.sig = sig;
      const frag = document.createDocumentFragment();
      for (let i = 0; i < pat.length; i++) {
        const sid = pat[i];
        const col = colorById[sid] || { css: '#64aef5', lambda: 520 };
        const tick = el('div', {
          class: 'slot-tick',
          'data-sid': sid,
          title: `slot #${i} → strand ${sid} (λ=${col.lambda}nm)`,
          style: { backgroundColor: col.css, color: col.css }
        });
        tick.addEventListener('mouseenter', () => setHoverStrand(sid));
        tick.addEventListener('mouseleave', () => setHoverStrand(null));
        tick.addEventListener('click', () => togglePinStrand(sid));
        frag.appendChild(tick);
      }
      mat.innerHTML = '';
      mat.appendChild(frag);
    }
  }

  $$('#chart-range .seg-btn').forEach(b => b.classList.toggle('on', Number(b.dataset.limit) === chartLimit));
  syncStrandHighlight();
}
