/* ============================================================================
 * PRISM — View 03: Full-Page Gapless 21-Ch Pure Color Matrix & Slot Bars
 * ============================================================================ */

import { S, SPECTRUM_STOPS, spectralColor, mixWhiteRgb, desatObsidianRgb, fmtRateCompact } from '../state.js?v=5.7.0';
import { $, $$, el, svgEl, setTxt, setCls, setTitle, setVar, setStyleProp } from '../dom.js?v=5.7.0';
import { renderOscilloscope, setChartLimit, getChartLimit } from '../canvas/oscilloscope.js?v=5.7.0';

let hoverStrandId = null;
const strandMetaById = new Map();
let specRafId = null;
let lastSpecTs = 0;
let lastSpecPaintTs = 0;
const tileSmooth = new Map();
let ribSmooth = { cur: null, target: 0.06 };

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

function ensureSparkPaths(svg, dev) {
  if (svg._sparkPaths) return svg._sparkPaths;
  const gId = `sp-grad-${String(dev).replace(/[^a-zA-Z0-9_-]/g, '')}`;
  svg.innerHTML = '';
  svg.appendChild(
    svgEl('defs', {},
      svgEl('linearGradient', { id: gId, x1: '0', y1: '0', x2: '0', y2: '1' },
        svgEl('stop', { offset: '0%', 'stop-color': 'rgba(255, 255, 255, 0.13)' }),
        svgEl('stop', { offset: '68%', 'stop-color': 'rgba(255, 255, 255, 0.04)' }),
        svgEl('stop', { offset: '100%', 'stop-color': 'rgba(255, 255, 255, 0)' })
      )
    )
  );
  const area = svgEl('path', { d: '', fill: `url(#${gId})` });
  const up = svgEl('path', { d: '', fill: 'none', stroke: 'rgba(255, 255, 255, 0.22)', 'stroke-width': '0.85', visibility: 'hidden' });
  const down = svgEl('path', { d: '', fill: 'none', stroke: 'rgba(255, 255, 255, 0.40)', 'stroke-width': '1.1' });
  svg.appendChild(area);
  svg.appendChild(up);
  svg.appendChild(down);
  svg._sparkPaths = { area, up, down };
  return svg._sparkPaths;
}

function renderTileSpark(tile, dev) {
  const svg = tile._ui?.spark;
  if (!svg) return;
  const ser = S.series;
  const limit = getChartLimit();
  const len = ser?.ts?.length || 0;
  const lastTs = len ? ser.ts[len - 1] : 0;
  const key = `${dev}:${limit}:${len}:${lastTs}`;
  if (tile._sparkKey === key) return;
  tile._sparkKey = key;

  const paths = ensureSparkPaths(svg, dev);
  const rawDown = ser?.strands?.[dev];
  if (!Array.isArray(rawDown) || rawDown.length < 2) {
    paths.area.setAttribute('d', '');
    paths.down.setAttribute('d', '');
    paths.up.setAttribute('visibility', 'hidden');
    return;
  }

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

  const dDown = sparkPathCoords(slDown, scaleMax);
  paths.area.setAttribute('d', `${dDown} L100.0,32.0 L0.0,32.0 Z`);
  paths.down.setAttribute('d', dDown);

  if (slUp.length === slDown.length && slUp.some(v => v > 0)) {
    paths.up.setAttribute('d', sparkPathCoords(slUp, scaleMax));
    paths.up.setAttribute('visibility', 'visible');
  } else {
    paths.up.setAttribute('visibility', 'hidden');
  }
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

let lastHighlightKey = '';

function syncStrandHighlight(force = false) {
  const activeId = getActiveStrandId();
  const activeMeta = activeId != null ? (strandMetaById.get(activeId) || null) : null;
  const hlKey = `${activeId ?? ''}:${S.pinnedStrandId ?? ''}:${strandMetaById.size}`;
  if (force || hlKey !== lastHighlightKey) {
    lastHighlightKey = hlKey;
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
        setTxt(activeTag, `${modeLabel} · ${activeMeta.dev} (λ=${activeMeta.lambda}nm)`);
        setStyleProp(activeTag, 'color', activeMeta.css);
      } else {
        setTxt(activeTag, '');
        setStyleProp(activeTag, 'color', '');
      }
    }

    setTxt('#spec-pin-hint', S.pinnedStrandId != null
      ? `已鎖定 ${strandMetaById.get(S.pinnedStrandId)?.dev || ''} · 再按一次或 Esc 解除`
      : '懸停／點擊鎖定單路 · Esc 解除');
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

function applyTileVisual(tile, meta, k) {
  const { col, healthy, bucket, pct } = meta;
  const vKey = `${col.rgb}:${healthy ? 1 : 0}:${bucket}:${Math.round(pct)}:${Math.round(k * 200)}`;
  if (tile._visKey === vKey) return;
  tile._visKey = vKey;

  const sat = !healthy ? 0.22 : (0.26 + 0.74 * Math.pow(k, 0.72));
  const litRgb = desatObsidianRgb(col.rgb, sat);
  const kAct = !healthy ? 0 : Math.max(0, (k - 0.12) / 0.88);
  const rimRgb = kAct > 0.05 ? mixWhiteRgb(col.rgb, 0.36 + 0.24 * kAct) : litRgb;

  const baseFill = !healthy ? 0.10
    : (bucket === 'depleted' ? 0.16
      : (bucket === 'cooling' ? 0.18 : (0.20 + (pct / 100) * 0.04)));
  const fillAlpha = !healthy ? 0.10 : Math.min(0.82, baseFill + Math.pow(k, 0.84) * 0.58);

  setVar(tile, '--sc-rgb', col.rgb);
  setVar(tile, '--lit-rgb', litRgb);
  setVar(tile, '--rim-rgb', rimRgb);
  setVar(tile, '--heat-fill', fillAlpha.toFixed(2));
  setVar(tile, '--heat-rim', (kAct > 0.05 ? 0.10 + 0.28 * Math.pow(kAct, 0.95) : 0).toFixed(3));
  setVar(tile, '--heat-halo', (kAct > 0.05 ? 0.14 + 0.44 * Math.pow(kAct, 0.90) : 0).toFixed(3));
  setVar(tile, '--heat-blur', `${Math.round(10 + 8 * kAct)}px`);
  setVar(tile, '--heat-spark-op', (0.44 + 0.34 * kAct).toFixed(2));
  setVar(tile, '--heat-label-op', (!healthy ? 0.48 : (0.80 + k * 0.20)).toFixed(2));
}

function applyRibbonVisual(ribK) {
  const ribSat = 0.24 + 0.50 * Math.pow(ribK, 0.88);
  const ribFill = (0.20 + 0.26 * Math.pow(ribK, 0.90)).toFixed(2);
  const ribScope = $('#spec-ribbon-scope');
  const rk = Math.round(ribK * 180);
  if (ribScope && ribScope._lastRibKey !== rk) {
    ribScope._lastRibKey = rk;
    const rLit = desatObsidianRgb(SPECTRUM_STOPS[0], ribSat);
    const gLit = desatObsidianRgb(SPECTRUM_STOPS[3], ribSat);
    const bLit = desatObsidianRgb(SPECTRUM_STOPS[5], ribSat);
    const vLit = desatObsidianRgb(SPECTRUM_STOPS[6], ribSat);
    const sA = (0.02 + 0.10 * Math.pow(ribK, 1.15)).toFixed(3);
    const vA = (0.015 + 0.07 * Math.pow(ribK, 1.20)).toFixed(3);
    const blur1 = Math.round(5 + 4 * ribK);
    const blur2 = Math.round(8 + 4 * ribK);
    setVar(ribScope, '--ribbon-fill', ribFill);
    setVar(ribScope, '--ribbon-shadow',
      `-4px 0 ${blur1}px rgba(${rLit}, ${sA}), ` +
      `0 0 ${blur1}px rgba(${gLit}, ${sA}), ` +
      `4px 0 ${blur1}px rgba(${bLit}, ${sA}), ` +
      `6px 0 ${blur2}px rgba(${vLit}, ${vA}), ` +
      `inset 0 0 0 0.5px rgba(0, 0, 0, 0.45)`
    );
  }
  const mat = $('#pattern');
  if (mat && mat.children.length > 0) {
    const satKey = String(Math.round(ribSat * 60));
    if (mat.dataset.satKey !== satKey) {
      mat.dataset.satKey = satKey;
      for (const tick of mat.children) {
        if (tick._pureRgb) setVar(tick, '--tick-rgb', desatObsidianRgb(tick._pureRgb, ribSat));
      }
    }
  }
  return ribSat;
}

function stepSpectrumAnim(now) {
  specRafId = null;
  if (S.tab !== 'spectrum' || document.visibilityState === 'hidden') {
    lastSpecTs = 0;
    return;
  }
  const dt = lastSpecTs ? Math.min(0.1, Math.max(0.004, (now - lastSpecTs) / 1000)) : 0.016;
  lastSpecTs = now;
  const kEase = Math.min(1, 1 - Math.exp(-dt * 4.2));
  let dirty = false;

  const shouldPaint = (now - lastSpecPaintTs >= 33) || lastSpecPaintTs === 0;
  const grid = $('#spectrum-heatmap');
  const tiles = grid ? grid.children : [];

  for (const tile of tiles) {
    const meta = tile._specMeta;
    if (!meta) continue;
    const sm = tileSmooth.get(meta.id);
    if (!sm) continue;
    const d = sm.target - sm.cur;
    if (Math.abs(d) > 0.002) {
      sm.cur += d * kEase;
      dirty = true;
    } else {
      sm.cur = sm.target;
    }
    if (shouldPaint) applyTileVisual(tile, meta, sm.cur);
  }

  if (ribSmooth.cur != null) {
    const dr = ribSmooth.target - ribSmooth.cur;
    if (Math.abs(dr) > 0.002) {
      ribSmooth.cur += dr * kEase;
      dirty = true;
    } else {
      ribSmooth.cur = ribSmooth.target;
    }
    if (shouldPaint) applyRibbonVisual(ribSmooth.cur);
  }

  if (shouldPaint) lastSpecPaintTs = now;
  if (dirty) {
    specRafId = requestAnimationFrame(stepSpectrumAnim);
  } else {
    lastSpecTs = 0;
  }
}

export function startSpectrumAnim() {
  if (S.tab !== 'spectrum' || typeof requestAnimationFrame !== 'function') return;
  if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return;
  if (!specRafId) {
    lastSpecTs = 0;
    specRafId = requestAnimationFrame(stepSpectrumAnim);
  }
}

export function stopSpectrumAnim() {
  if (specRafId && typeof cancelAnimationFrame === 'function') {
    cancelAnimationFrame(specRafId);
  }
  specRafId = null;
  lastSpecTs = 0;
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
    const raw = (s.now ?? s.rate ?? 0) + (s.up_now ?? s.up ?? 0);
    const ewma = (s.rate ?? s.now ?? 0) + (s.up ?? s.up_now ?? 0);
    const m = ((raw * 0.45 + ewma * 0.55) * 8) / 1e6;
    if (m > maxMbps) maxMbps = m;
    if ((s.slots || 0) > maxSlots) maxSlots = s.slots;
    return m;
  });
  const slotCols = Math.min(18, Math.max(6, maxSlots));
  const hasRaf = typeof globalThis.requestAnimationFrame === 'function';

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
    const absPulse = Math.min(1, Math.log10(1 + mbps * 6.5) / 1.48);
    const targetK = !s.healthy ? 0.04 : Math.max(0.08, Math.min(1, Math.max(absPulse * 0.92, rel * 0.85) + (s.vip ? 0.08 : 0)));

    tile.classList.toggle('vip', !!s.vip);
    tile.classList.toggle('down', !s.healthy);

    const meta = { id: s.id, col, healthy: !!s.healthy, bucket: s.bucket, pct };
    tile._specMeta = meta;
    let sm = tileSmooth.get(s.id);
    if (!sm) {
      sm = { cur: targetK, target: targetK };
      tileSmooth.set(s.id, sm);
      applyTileVisual(tile, meta, targetK);
    } else {
      sm.target = targetK;
      if (!hasRaf) {
        sm.cur = targetK;
        applyTileVisual(tile, meta, targetK);
      }
    }

    setTitle(tile, `${s.dev} (λ=${col.lambda}nm) · ${s.ip || '無租約'} · ↓${fmtShortRate(downBps)} ↑${fmtShortRate(upBps)} · pk ${fmtShortRate(s.peak)} · τ=${s.ttfb_ms || '—'}ms · loss ${s.loss_pct ?? 0}% · tokens ${Math.round(pct)}% · slots ${s.slots ?? 0}`);

    const ui = tile._ui;

    // Subtle contour sparkline at tile lower background
    renderTileSpark(tile, s.dev);

    // Top-right corner: RTT/loss + status flag
    const lossPct = s.loss_pct ?? 0;
    const rttTxt = s.ttfb_ms > 0 ? `${s.ttfb_ms}ms` : '—';
    setTxt(ui.rttEl, lossPct > 0 ? `${rttTxt}·${lossPct}%` : rttTxt);
    setStyleProp(ui.rttEl, 'color', lossPct >= 15 ? 'var(--c-amber)' : '');

    if (!s.healthy) {
      setCls(ui.flagEl, 'heat-flag down');
      setTxt(ui.flagEl, s.parked ? 'PARK' : 'OFF');
      setStyleProp(ui.flagEl, 'display', '');
    } else if (s.vip) {
      setCls(ui.flagEl, 'heat-flag vip');
      setTxt(ui.flagEl, 'VIP');
      setStyleProp(ui.flagEl, 'display', '');
    } else if (s.cooldown_rem > 0) {
      setCls(ui.flagEl, 'heat-flag cool');
      setTxt(ui.flagEl, `${s.cooldown_rem}s`);
      setStyleProp(ui.flagEl, 'display', '');
    } else {
      setStyleProp(ui.flagEl, 'display', 'none');
    }

    // Bottom-left corner: speed + upload/peak compact inline
    const hasDown = downBps * 8 > 500;
    const hasUp = upBps * 8 > 500;
    setTxt(ui.downEl, hasDown ? `↓${fmtShortRate(downBps)}` : (rateTotal > 0 ? '↓0' : 'idle'));
    setCls(ui.downEl, `heat-rate-down${hasDown ? '' : ' idle'}`);
    setTxt(ui.subEl, hasUp ? `↑${fmtShortRate(upBps)}·pk${fmtShortRate(s.peak)}` : `pk${fmtShortRate(s.peak)}`);

    // Bottom-right corner: token % + slots count
    const tokLabel = `${Math.round(pct)}%`;
    const slotLabel = s.vip ? ((s.slots || 0) > 0 ? `VIP·${s.slots}槽` : 'VIP') : `${s.slots ?? 0}槽`;
    setTxt(ui.brEl, `${tokLabel} · ${slotLabel}`);

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
  setTxt('#weave-cap', `VIP=${w.vip_dev || '—'} · ${w.interval || 2}s`);
  const downNow = st.rate || 0;
  const upNow = st.rate_up || 0;
  const totBps = downNow + upNow;

  // 2. Full-Page Gapless 21-Wavelength Matrix (unified obsidian saturation & glow)
  const gridBefore = $('#spectrum-heatmap')?.dataset?.count;
  updateHeatmap(strands);
  const gridRebuilt = $('#spectrum-heatmap')?.dataset?.count !== gridBefore;

  // 3. Modulate rainbow bar fill, obsidian saturation & 4-stop prism bloom smoothly with EWMA blend + high ceiling
  const ewmaTot = (st.rate_ewma ?? downNow) + (st.rate_up_ewma ?? upNow);
  const totMbps = ((totBps * 0.45 + ewmaTot * 0.55) * 8) / 1e6;
  const targetRibK = totMbps > 0.05 ? Math.min(1, Math.max(0.06, Math.log10(1 + totMbps * 0.45) / 1.85)) : 0.06;
  const hasRaf = typeof globalThis.requestAnimationFrame === 'function';
  ribSmooth.target = targetRibK;
  if (ribSmooth.cur == null || !hasRaf) {
    ribSmooth.cur = targetRibK;
  }
  const ribSat = applyRibbonVisual(ribSmooth.cur);

  const ribDownEl = $('#ribbon-rate-down');
  if (ribDownEl) {
    const hasDown = downNow * 8 > 500;
    setTxt(ribDownEl, hasDown ? `↓${fmtShortRate(downNow)}` : (totBps > 0 ? '↓0' : 'idle'));
    setCls(ribDownEl, `heat-rate-down${hasDown ? '' : ' idle'}`);
  }
  if (!S.series || !S.series.ts || S.series.ts.length < 2) {
    setTxt('#ribbon-rate-sub', `↑${fmtShortRate(upNow)}`);
  }
  setTxt('#ribbon-slots-meta', `${w.slots ?? pat.length ?? 0} slots`);
  setTxt('#ribbon-health-meta', `${st.healthy_count ?? strands.length}/${strands.length || 21} UP · ${w.charged_count ?? 0} 滿桶`);

  // 4. Full-Width 126-Slot Kernel Timeline Ribbon with shared obsidian desaturation
  const mat = $('#pattern');
  let patRebuilt = false;
  if (mat) {
    const sig = pat.join(',');
    const satKey = String(Math.round(ribSat * 60));
    if (mat.dataset.sig !== sig) {
      patRebuilt = true;
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
  syncStrandHighlight(gridRebuilt || patRebuilt);
  startSpectrumAnim();
}
