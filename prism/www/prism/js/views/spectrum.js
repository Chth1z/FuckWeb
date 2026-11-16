/* ============================================================================
 * PRISM — View 03: Full-Page Gapless 21-Ch Pure Color Matrix & Slot Bars
 * ============================================================================ */

import { S, SPECTRUM_STOPS, spectralColor, mixWhiteRgb, desatObsidianRgb, fmtRateCompact } from '../state.js?v=5.6.6';
import { $, $$, el, svgEl } from '../dom.js?v=5.6.6';
import { renderOscilloscope, setChartLimit, getChartLimit } from '../canvas/oscilloscope.js?v=5.6.6';

let hoverStrandId = null;
const strandMetaById = new Map();

const fmtShortRate = (bps) => fmtRateCompact(bps, '0');

function getActiveStrandId() {
  return hoverStrandId != null ? hoverStrandId : S.pinnedStrandId;
}

function getActiveStrandMeta() {
  const id = getActiveStrandId();
  return id != null ? (strandMetaById.get(id) || null) : null;
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
  const limit = getChartLimit();
  const lastTs = ser?.ts?.length ? ser.ts[ser.ts.length - 1] : 0;
  const key = `${dev}:${limit}:${lastTs}`;
  if (tile._sparkKey === key) return;
  tile._sparkKey = key;

  svg.innerHTML = '';
  const rawDown = ser?.strands?.[dev];
  if (!Array.isArray(rawDown) || rawDown.length < 2) return;

  const rawUp = Array.isArray(ser?.strands_up?.[dev]) ? ser.strands_up[dev] : [];
  const slDown = downsamplePeak(rawDown.slice(Math.max(0, rawDown.length - limit)), 44);
  const slUp = rawUp.length >= 2
    ? downsamplePeak(rawUp.slice(Math.max(0, rawUp.length - limit)), slDown.length)
    : [];

  let peakBps = 125000;
  for (let i = 0; i < slDown.length; i++) {
    if ((slDown[i] || 0) > peakBps) peakBps = slDown[i];
    if ((slUp[i] || 0) > peakBps) peakBps = slUp[i];
  }
  const scaleMax = peakBps * 1.10;

  const gId = `sp-grad-${String(dev).replace(/[^a-zA-Z0-9_-]/g, '')}`;
  svg.appendChild(
    svgEl('defs', {},
      svgEl('linearGradient', { id: gId, x1: '0', y1: '0', x2: '0', y2: '1' },
        svgEl('stop', { offset: '0%', 'stop-color': 'rgba(255, 255, 255, 0.13)' }),
        svgEl('stop', { offset: '68%', 'stop-color': 'rgba(255, 255, 255, 0.04)' }),
        svgEl('stop', { offset: '100%', 'stop-color': 'rgba(255, 255, 255, 0)' })
      )
    )
  );

  const dDown = sparkPathCoords(slDown, scaleMax);
  const dArea = `${dDown} L100.0,32.0 L0.0,32.0 Z`;
  svg.appendChild(svgEl('path', { d: dArea, fill: `url(#${gId})` }));

  if (slUp.length === slDown.length && slUp.some(v => v > 0)) {
    svg.appendChild(svgEl('path', {
      d: sparkPathCoords(slUp, scaleMax),
      fill: 'none',
      stroke: 'rgba(255, 255, 255, 0.22)',
      'stroke-width': '0.85'
    }));
  }

  svg.appendChild(svgEl('path', {
    d: dDown,
    fill: 'none',
    stroke: 'rgba(255, 255, 255, 0.40)',
    'stroke-width': '1.1'
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
      activeTag.textContent = '';
      activeTag.style.color = '';
    }
  }

  const hintEl = $('#spec-pin-hint');
  if (hintEl) {
    hintEl.textContent = S.pinnedStrandId != null
      ? `已鎖定 ${strandMetaById.get(S.pinnedStrandId)?.dev || ''} · 再按一次或 Esc 解除`
      : '懸停／點擊鎖定單路 · Esc 解除';
  }

  renderOscilloscope(activeMeta);
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
      const lim = Number(btn.dataset.limit || 360);
      $$('#chart-range .seg-btn').forEach(b => b.classList.toggle('on', Number(b.dataset.limit) === lim));
      setChartLimit(lim);
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
    const absPulse = Math.min(1, Math.log10(1 + mbps * 6) / 1.55);
    const k = !s.healthy ? 0.04 : Math.max(0.08, Math.min(1, Math.max(absPulse * 0.85, rel * 0.72) + (s.vip ? 0.10 : 0)));
    const sat = !s.healthy ? 0.18 : (0.26 + 0.74 * Math.pow(k, 0.78));
    const litRgb = desatObsidianRgb(col.rgb, sat);
    const coreRgb = k > 0.76 ? mixWhiteRgb(litRgb, (k - 0.76) * 0.28) : litRgb;

    const baseFill = !s.healthy ? 0.10
      : (s.bucket === 'depleted' ? 0.16
        : (s.bucket === 'cooling' ? 0.19 : (0.22 + (pct / 100) * 0.04)));
    const fillAlpha = !s.healthy ? 0.10 : Math.min(0.62, baseFill + k * 0.36);

    tile.classList.toggle('vip', !!s.vip);
    tile.classList.toggle('down', !s.healthy);

    tile.style.setProperty('--sc-rgb', col.rgb);
    tile.style.setProperty('--lit-rgb', coreRgb);
    tile.style.setProperty('--heat-fill', fillAlpha.toFixed(2));
    tile.style.setProperty('--heat-halo', (0.04 + 0.24 * Math.pow(k, 1.15)).toFixed(3));
    tile.style.setProperty('--heat-outer', (0.01 + 0.11 * Math.pow(k, 1.25)).toFixed(3));
    tile.style.setProperty('--heat-crest', (0.02 + 0.07 * Math.pow(k, 1.10)).toFixed(3));
    tile.style.setProperty('--heat-blur', `${Math.round(8 + 16 * k)}px`);
    tile.style.setProperty('--heat-bloom', `${Math.round(18 + 22 * k)}px`);
    tile.style.setProperty('--heat-label-op', (!s.healthy ? 0.48 : (0.80 + k * 0.20)).toFixed(2));

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

  // 1. Header scheduler params (non-duplicate with bottom ribbon HUD)
  const capEl = $('#weave-cap');
  if (capEl) capEl.textContent = `VIP=${w.vip_dev || '—'} · ${w.interval || 2}s`;
  const downNow = st.rate || 0;
  const upNow = st.rate_up || 0;
  const totBps = downNow + upNow;

  // 2. Full-Page Gapless 21-Wavelength Matrix (unified obsidian saturation & glow)
  updateHeatmap(strands);

  // 3. Modulate rainbow bar fill, obsidian saturation & 4-stop prism bloom smoothly by total network speed
  const totMbps = (totBps * 8) / 1e6;
  const ribK = totMbps > 0.01 ? Math.min(1, Math.max(0.08, Math.log10(1 + totMbps * 4.5) / 1.65)) : 0.08;
  const ribSat = 0.34 + 0.66 * Math.pow(ribK, 0.78);
  const ribFill = (0.36 + 0.30 * Math.pow(ribK, 0.85)).toFixed(2);
  const ribScope = $('#spec-ribbon-scope');
  if (ribScope) {
    const rLit = desatObsidianRgb(SPECTRUM_STOPS[0], ribSat);
    const gLit = desatObsidianRgb(SPECTRUM_STOPS[3], ribSat);
    const bLit = desatObsidianRgb(SPECTRUM_STOPS[5], ribSat);
    const vLit = desatObsidianRgb(SPECTRUM_STOPS[6], ribSat);
    const sA = (0.03 + 0.16 * Math.pow(ribK, 1.12)).toFixed(3);
    const vA = (0.02 + 0.12 * Math.pow(ribK, 1.18)).toFixed(3);
    const blur1 = Math.round(8 + 14 * ribK);
    const blur2 = Math.round(18 + 20 * ribK);
    ribScope.style.setProperty('--ribbon-fill', ribFill);
    ribScope.style.setProperty('--ribbon-shadow',
      `-6px 0 ${blur1}px rgba(${rLit}, ${sA}), ` +
      `0 0 ${blur1}px rgba(${gLit}, ${sA}), ` +
      `6px 0 ${blur1}px rgba(${bLit}, ${sA}), ` +
      `10px 0 ${blur2}px rgba(${vLit}, ${vA}), ` +
      `inset 0 0 0 0.5px rgba(0, 0, 0, 0.45)`
    );
  }

  const ribDownEl = $('#ribbon-rate-down');
  if (ribDownEl) {
    const hasDown = downNow * 8 > 500;
    ribDownEl.textContent = hasDown ? `↓${fmtShortRate(downNow)}` : (totBps > 0 ? '↓0' : 'idle');
    ribDownEl.className = `heat-rate-down${hasDown ? '' : ' idle'}`;
  }
  const ribSubEl = $('#ribbon-rate-sub');
  if (ribSubEl && (!S.series || !S.series.ts || S.series.ts.length < 2)) {
    ribSubEl.textContent = `↑${fmtShortRate(upNow)}`;
  }
  const ribSlotsMeta = $('#ribbon-slots-meta');
  if (ribSlotsMeta) ribSlotsMeta.textContent = `${w.slots || pat.length || 126} slots`;
  const ribHealthEl = $('#ribbon-health-meta');
  if (ribHealthEl) {
    ribHealthEl.textContent = `${st.healthy_count ?? strands.length}/${strands.length || 21} UP · ${w.charged_count ?? 0} 滿桶`;
  }

  // 4. Full-Width 126-Slot Kernel Timeline Ribbon with shared obsidian desaturation
  const mat = $('#pattern');
  if (mat) {
    const sig = pat.join(',');
    const satKey = String(Math.round(ribSat * 50));
    if (mat.dataset.sig !== sig) {
      mat.dataset.sig = sig;
      mat.dataset.satKey = satKey;
      const frag = document.createDocumentFragment();
      for (let i = 0; i < pat.length; i++) {
        const sid = pat[i];
        const col = colorById[sid] || { css: '#64aef5', rgb: '100, 174, 245', lambda: 520 };
        const tick = el('div', {
          class: 'slot-tick',
          'data-sid': sid,
          title: `slot #${i} → strand ${sid} (λ=${col.lambda}nm)`,
          style: { '--pure-rgb': col.rgb, '--tick-rgb': desatObsidianRgb(col.rgb, ribSat), color: col.css }
        });
        tick._pureRgb = col.rgb;
        tick.addEventListener('mouseenter', () => setHoverStrand(sid));
        tick.addEventListener('mouseleave', () => setHoverStrand(null));
        tick.addEventListener('click', () => togglePinStrand(sid));
        frag.appendChild(tick);
      }
      mat.innerHTML = '';
      mat.appendChild(frag);
    } else if (mat.dataset.satKey !== satKey) {
      mat.dataset.satKey = satKey;
      for (const tick of mat.children) {
        if (tick._pureRgb) tick.style.setProperty('--tick-rgb', desatObsidianRgb(tick._pureRgb, ribSat));
      }
    }
  }

  $$('#chart-range .seg-btn').forEach(b => b.classList.toggle('on', Number(b.dataset.limit) === getChartLimit()));
  syncStrandHighlight();
}
