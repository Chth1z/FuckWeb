/* ============================================================================
 * PRISM — View 03: Pure Square Emission Matrix, Oscilloscope & 21-Ch Telemetry
 * ============================================================================ */

import { S, spectralColor, fmtRateCompact } from '../state.js?v=5.6.5';
import { $, $$, el, renderSegMeter } from '../dom.js?v=5.6.5';
import { renderOscilloscope, setChartLimit, getChartLimit } from '../canvas/oscilloscope.js?v=5.6.5';

let hoverStrandId = null;

const fmtShortRate = (bps) => fmtRateCompact(bps, '0');

function getActiveStrandId() {
  return hoverStrandId != null ? hoverStrandId : S.pinnedStrandId;
}

function syncStrandHighlight() {
  const activeId = getActiveStrandId();

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

  const rows = $('#strands-tbody')?.children || [];
  for (const tr of rows) {
    const id = Number(tr.dataset.sid);
    tr.classList.toggle('pinned', S.pinnedStrandId != null && id === S.pinnedStrandId);
    tr.classList.toggle('hi', activeId != null && id === activeId);
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
      const lim = Number(btn.dataset.limit || 360);
      $$('#chart-range .seg-btn').forEach(b => b.classList.toggle('on', Number(b.dataset.limit) === lim));
      setChartLimit(lim);
    });
  });
}

function buildHeatmapTiles(grid, strands) {
  const frag = document.createDocumentFragment();
  const total = Math.max(1, strands.length);
  strands.forEach((s, idx) => {
    const col = spectralColor(idx, total);
    const shortName = s.dev === 'wan' ? 'wan' : String(s.dev || idx).replace(/^vwan/, 'v');
    const tile = el('div', {
      class: 'heat-tile',
      role: 'gridcell',
      tabindex: '0',
      'data-sid': s.id,
      'aria-label': `${s.dev} 波長 ${col.lambda}nm`,
      style: { '--sc-rgb': col.rgb },
      onMouseenter: () => setHoverStrand(s.id),
      onMouseleave: () => setHoverStrand(null),
      onClick: () => togglePinStrand(s.id),
      onKeydown: (e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          togglePinStrand(s.id);
        }
      }
    },
      el('span', { class: 'heat-name' }, shortName),
      el('span', { class: 'heat-sub-flag' }, '')
    );
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
  const mbpsList = strands.map(s => {
    const m = ((s.now ?? s.rate ?? 0) + (s.up_now ?? s.up ?? 0)) * 8 / 1e6;
    if (m > maxMbps) maxMbps = m;
    return m;
  });

  const tiles = grid.children;
  for (let i = 0; i < strands.length; i++) {
    const s = strands[i];
    const tile = tiles[i];
    if (!tile) continue;

    const col = spectralColor(i, total);
    const pct = s.healthy ? Math.max(0, Math.min(100, s.tokens_pct ?? 100)) : 0;
    const rateTotal = (s.now ?? s.rate ?? 0) + (s.up_now ?? s.up ?? 0);
    const mbps = mbpsList[i];
    const rel = maxMbps > 0.12 ? mbps / maxMbps : 0;
    const absPulse = Math.min(1, Math.log10(1 + mbps * 6) / 1.45);
    const activeIntensity = Math.max(absPulse, rel * 0.90);

    // Pure solid contrast: clean obsidian low-wash at rest/cool, bright pure color & halo under pulse
    const baseContrast = !s.healthy ? 0.06
      : (s.bucket === 'depleted' ? 0.07
        : (s.bucket === 'cooling' ? 0.09 : (0.11 + (pct / 100) * 0.05)));
    const heat = s.healthy ? Math.min(1, activeIntensity * 0.88 + (s.vip ? 0.12 : 0)) : 0;
    const fillAlpha = !s.healthy ? 0.08 : Math.min(0.96, baseContrast + activeIntensity * 0.80);

    tile.classList.toggle('vip', !!s.vip);
    tile.classList.toggle('down', !s.healthy);

    tile.style.setProperty('--heat-fill', fillAlpha.toFixed(2));
    tile.style.setProperty('--heat-halo', (heat > 0.08 ? 0.10 + heat * 0.72 : 0.03).toFixed(2));
    tile.style.setProperty('--heat-outer', (heat > 0.12 ? 0.04 + heat * 0.36 : 0.00).toFixed(2));
    tile.style.setProperty('--heat-crest', (0.02 + heat * 0.24).toFixed(2));
    tile.style.setProperty('--heat-blur', `${Math.round(10 + heat * 18)}px`);
    tile.style.setProperty('--heat-bloom', `${Math.round(18 + heat * 28)}px`);
    tile.style.setProperty('--heat-label-op', (!s.healthy ? 0.34 : (0.48 + heat * 0.50)).toFixed(2));

    tile.title = `${s.dev} (λ=${col.lambda}nm) · ${s.ip || '無租約'} · ${rateTotal > 50 ? fmtShortRate(rateTotal) + 'bps' : 'idle'} · τ=${s.ttfb_ms || '—'}ms · loss ${s.loss_pct ?? 0}% · tokens ${Math.round(pct)}% · slots ${s.slots ?? 0}`;

    const subFlag = tile.children[1];
    if (subFlag) {
      if (!s.healthy) {
        subFlag.textContent = s.parked ? 'PARK' : 'OFF';
        subFlag.style.color = 'var(--c-crimson)';
      } else if (rateTotal * 8 > 500) {
        subFlag.textContent = fmtShortRate(rateTotal);
        subFlag.style.color = 'rgba(255, 255, 255, 0.94)';
      } else if (s.cooldown_rem > 0) {
        subFlag.textContent = `${s.cooldown_rem}s`;
        subFlag.style.color = 'rgba(255, 255, 255, 0.72)';
      } else {
        subFlag.textContent = '';
      }
    }
  }
}

export function renderSpectrum() {
  const st = S.status;
  if (!st) return;

  const strands = st.strands || [];
  const w = st.weave || {};
  const pat = w.pattern || [];
  const colorById = {};
  strands.forEach((s, idx) => {
    colorById[s.id] = spectralColor(idx, Math.max(1, strands.length));
  });

  if (S.pinnedStrandId != null && !strands.some(s => s.id === S.pinnedStrandId)) {
    S.pinnedStrandId = null;
  }

  // 1. Borderless Square Emission Matrix
  const capEl = $('#weave-cap');
  if (capEl) capEl.textContent = `${w.slots || pat.length || 126} slots · VIP=${w.vip_dev || '—'} · ${w.interval || 2}s`;
  updateHeatmap(strands);

  // 2. Slim Single-Row 126-Slot Kernel Timeline Ribbon
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

  // 3. Left-Bottom Dual-Channel Optical Flux Oscilloscope + Bucket State Strip
  renderOscilloscope();
  $$('#chart-range .seg-btn').forEach(b => b.classList.toggle('on', Number(b.dataset.limit) === getChartLimit()));

  const sb = $('#scope-buckets');
  if (sb) {
    const vipS = strands.find(s => s.vip);
    sb.innerHTML = '';
    sb.append(
      el('div', { class: 'bucket-stat-cell' },
        el('span', { class: 'k' }, 'charged 滿桶'),
        el('span', { class: 'v c-mint' }, `${w.charged_count ?? 0}/${st.healthy_count ?? strands.length}`)
      ),
      el('div', { class: 'bucket-stat-cell' },
        el('span', { class: 'k' }, 'draining / cool'),
        el('span', { class: 'v c-amber' }, `${w.draining_count ?? 0} / ${(w.cooling_count || 0) + (w.depleted_count || 0)}`)
      ),
      el('div', { class: 'bucket-stat-cell' },
        el('span', { class: 'k' }, '@vip_lane'),
        el('span', { class: 'v c-blue' }, vipS ? `${vipS.dev}` : '—')
      ),
      el('div', { class: 'bucket-stat-cell' },
        el('span', { class: 'k' }, 'slots 總槽位'),
        el('span', { class: 'v c-bright' }, `${pat.length || w.slots || 126}`)
      )
    );
  }

  // 4. Right Full-Height 21-Strand Telemetry Module (Redundant Status Badge Column Removed)
  const tbody = $('#strands-tbody');
  if (!tbody) return;

  const frag = document.createDocumentFragment();
  strands.forEach((s, idx) => {
    const col = spectralColor(idx, Math.max(1, strands.length));
    const meterColor = s.vip ? 'blue' : (s.bucket === 'charged' ? 'mint' : (s.bucket === 'cooling' ? 'violet' : 'amber'));
    const meterWrap = el('div', { class: 'bp-meter-row', style: { gap: '6px' } });
    const seg = el('span', { class: 'seg-meter compact' });
    renderSegMeter(seg, (s.tokens_pct ?? 100) / 100, 6, meterColor, true);
    const kbTxt = s.cooldown_rem > 0
      ? `${s.tokens_pct ?? 100}%(${s.cooldown_rem}s)`
      : `${s.tokens_pct ?? 100}%`;
    meterWrap.append(seg, el('span', { class: 'c-sec', style: { fontSize: '10.5px', whiteSpace: 'nowrap', flexShrink: '0' } }, kbTxt));

    const rttNode = s.loss_pct > 0
      ? el('span', { class: s.loss_pct >= 15 ? 'c-amber' : 'c-sec', title: `packet loss ${s.loss_pct}%` }, `${s.ttfb_ms > 0 ? s.ttfb_ms + 'm' : '—'}·${s.loss_pct}%`)
      : el('span', {}, s.ttfb_ms > 0 ? `${s.ttfb_ms}m` : '—');

    const flagEl = !s.healthy
      ? el('span', { class: 'c-crimson', style: { fontSize: '9.5px', fontWeight: '700' } }, s.parked ? 'PARK' : 'OFF')
      : (s.vip ? el('span', { class: 'c-blue', style: { fontSize: '9.5px', fontWeight: '700' } }, 'VIP') : null);

    const tr = el('tr', {
      'data-sid': s.id,
      style: { cursor: 'pointer' },
      onMouseenter: () => setHoverStrand(s.id),
      onMouseleave: () => setHoverStrand(null),
      onClick: () => togglePinStrand(s.id)
    },
      el('td', {},
        el('div', { style: { display: 'flex', alignItems: 'center', gap: '6px' } },
          el('span', { style: { display: 'inline-block', width: '7px', height: '7px', background: col.css, boxShadow: `0 0 6px ${col.css}` } }),
          el('strong', { class: !s.healthy ? 'c-muted' : 'c-bright' }, `${s.dev}`),
          el('span', { class: 'c-muted', style: { fontSize: '10px' } }, `${col.lambda}`),
          flagEl
        )
      ),
      el('td', { class: 'num' }, rttNode),
      el('td', { class: 'num c-mint' }, fmtShortRate(s.now ?? s.rate)),
      el('td', { class: 'num c-blue' }, fmtShortRate(s.up_now ?? s.up)),
      el('td', { class: 'num c-sec' }, fmtShortRate(s.peak)),
      el('td', {}, meterWrap),
      el('td', { class: 'num' }, s.vip
        ? el('span', { class: 'c-blue', style: { fontWeight: '700' } }, 'VIP')
        : el('span', { class: 'c-bright' }, `${s.slots ?? 0}`))
    );
    frag.appendChild(tr);
  });

  tbody.innerHTML = '';
  tbody.appendChild(frag);
  syncStrandHighlight();
}
