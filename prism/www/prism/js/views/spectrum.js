/* ============================================================================
 * PRISM — View 03: Borderless Square Heatmap, Focused Inspector & Oscilloscope
 * ============================================================================ */

import { S, spectralColor } from '../state.js?v=5.3.0';
import { $, $$, el } from '../dom.js?v=5.3.0';
import { renderOscilloscope, setChartLimit, getChartLimit } from '../canvas/oscilloscope.js?v=5.3.0';

let hoverStrandId = null;

function fmtBitrate(bytesPerSec) {
  const b = (bytesPerSec || 0) * 8;
  if (b <= 50) return '0 bps';
  if (b >= 1e9) return `${(b / 1e9).toFixed(2)} Gbps`;
  if (b >= 1e6) return `${(b / 1e6).toFixed(b >= 100e6 ? 0 : 1)} Mbps`;
  if (b >= 1e3) return `${Math.round(b / 1e3)} Kbps`;
  return `${Math.round(b)} bps`;
}

function getActiveStrandId() {
  return hoverStrandId != null ? hoverStrandId : S.pinnedStrandId;
}

function syncTileAndTickHighlight() {
  const activeId = getActiveStrandId();
  const tiles = $('#spectrum-heatmap')?.children || [];
  for (const tile of tiles) {
    const id = Number(tile.dataset.sid);
    const isPinned = S.pinnedStrandId != null && id === S.pinnedStrandId;
    tile.classList.toggle('pinned', isPinned);
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
}

function renderInspector(st) {
  const strands = st?.strands || [];
  const w = st?.weave || {};
  const pat = w.pattern || [];
  const totalSlots = pat.length || w.slots || 126;
  const targetId = getActiveStrandId();

  const swatch = $('#insp-swatch');
  const titleEl = $('#insp-title');
  const badgeEl = $('#insp-badge');
  const ipEl = $('#insp-ip');
  const unpinBtn = $('#insp-unpin');
  const rateEl = $('#insp-rate');
  const peakEl = $('#insp-peak');
  const rttEl = $('#insp-rtt');
  const tokEl = $('#insp-tok');
  if (!titleEl) return;

  if (unpinBtn) {
    unpinBtn.style.display = S.pinnedStrandId != null ? '' : 'none';
  }

  const idx = targetId != null ? strands.findIndex(s => s.id === targetId) : -1;
  if (idx >= 0) {
    const s = strands[idx];
    const col = spectralColor(idx, Math.max(1, strands.length));
    const bucketMap = {
      charged: ['CHARGED', 'charged'],
      draining: ['DRAINING', 'draining'],
      cooling: ['COOLING', 'cooling'],
      depleted: ['DEPLETED', 'depleted']
    };
    const [bText, bClass] = !s.healthy
      ? [s.parked ? 'PARK' : 'DOWN', 'depleted']
      : (s.vip ? ['VIP*', 'vip'] : (bucketMap[s.bucket] || ['CHARGED', 'charged']));

    const pct = s.healthy ? Math.round(s.tokens_pct ?? 100) : 0;
    const cd = s.cooldown_rem > 0 ? ` (${s.cooldown_rem}s)` : '';
    const slotTxt = s.vip ? 'VIP 專線' : `${s.slots ?? 0}/${totalSlots} 槽`;

    if (swatch) {
      swatch.style.background = col.css;
      swatch.style.boxShadow = `0 0 12px ${col.css}`;
    }
    titleEl.textContent = `${s.dev} · λ=${col.lambda}nm${S.pinnedStrandId === s.id ? ' [已鎖定]' : ''}`;
    if (badgeEl) {
      badgeEl.className = `st-badge ${bClass}`;
      badgeEl.textContent = bText;
    }
    if (ipEl) ipEl.textContent = s.ip || '無租約';
    if (rateEl) rateEl.textContent = `↓ ${fmtBitrate(s.now ?? s.rate)} / ↑ ${fmtBitrate(s.up_now ?? s.up)}`;
    if (peakEl) peakEl.textContent = fmtBitrate(s.peak);
    if (rttEl) rttEl.textContent = `${s.ttfb_ms > 0 ? s.ttfb_ms + ' ms' : '—'} · 丟包 ${s.loss_pct ?? 0}%`;
    if (tokEl) tokEl.textContent = `${pct}%${cd} · ${slotTxt}`;
    return;
  }

  // Aggregate mode when no tile is hovered or pinned
  let downSum = 0;
  let upSum = 0;
  let peakSum = 0;
  let rttSum = 0;
  let rttCnt = 0;
  let healthy = 0;
  strands.forEach(s => {
    downSum += (s.now ?? s.rate ?? 0);
    upSum += (s.up_now ?? s.up ?? 0);
    peakSum += (s.peak ?? 0);
    if (s.healthy) {
      healthy++;
      if ((s.ttfb_ms || 0) > 0) {
        rttSum += s.ttfb_ms;
        rttCnt++;
      }
    }
  });
  const activeHot = (w.draining_count || 0) > 0 || (downSum + upSum) * 8 > 50000;

  if (swatch) {
    swatch.style.background = activeHot ? 'var(--c-amber)' : 'var(--c-mint)';
    swatch.style.boxShadow = `0 0 10px ${activeHot ? 'var(--c-amber)' : 'var(--c-mint)'}`;
  }
  titleEl.textContent = `全光譜 ${healthy}/${strands.length} 鏈路聚合`;
  if (badgeEl) {
    badgeEl.className = `st-badge ${activeHot ? 'draining' : 'charged'}`;
    badgeEl.textContent = activeHot ? 'ACTIVE' : 'READY';
  }
  if (ipEl) ipEl.textContent = '懸停或點擊色塊查看單路細節';
  if (rateEl) rateEl.textContent = `↓ ${fmtBitrate(downSum)} / ↑ ${fmtBitrate(upSum)}`;
  if (peakEl) peakEl.textContent = fmtBitrate(peakSum);
  if (rttEl) rttEl.textContent = rttCnt > 0 ? `均值 ${Math.round(rttSum / rttCnt)} ms` : '—';
  if (tokEl) tokEl.textContent = `${w.charged_count ?? 0}/${healthy} 滿桶 · ${totalSlots} 槽`;
}

function setHoverStrand(strandId) {
  hoverStrandId = strandId;
  syncTileAndTickHighlight();
  renderInspector(S.status);
}

function togglePinStrand(strandId) {
  S.pinnedStrandId = (S.pinnedStrandId === strandId) ? null : strandId;
  syncTileAndTickHighlight();
  renderInspector(S.status);
}

export function bindSpectrumEvents() {
  $$('#chart-range .seg-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const lim = Number(btn.dataset.limit || 360);
      $$('#chart-range .seg-btn').forEach(b => b.classList.toggle('on', Number(b.dataset.limit) === lim));
      setChartLimit(lim);
    });
  });

  $('#insp-unpin')?.addEventListener('click', () => {
    S.pinnedStrandId = null;
    syncTileAndTickHighlight();
    renderInspector(S.status);
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

    // Pure solid contrast: clean dark base when idle/cooling, bright pure color & halo when active
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

    tile.title = `${s.dev} (λ=${col.lambda}nm) · ${s.ip || '無租約'} · ${rateTotal > 50 ? fmtBitrate(rateTotal) : 'idle'} · τ=${s.ttfb_ms || '—'}ms · tokens ${Math.round(pct)}%`;

    const subFlag = tile.children[1];
    if (subFlag) {
      if (!s.healthy) {
        subFlag.textContent = s.parked ? 'PARK' : 'OFF';
        subFlag.style.color = 'var(--c-crimson)';
      } else if (rateTotal * 8 > 500) {
        const b = rateTotal * 8;
        subFlag.textContent = b >= 1e6 ? `${(b / 1e6).toFixed(1)}M` : `${Math.round(b / 1e3)}K`;
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

  // 1. Borderless Square Emission Matrix + Live Focused Inspector
  const capEl = $('#weave-cap');
  if (capEl) capEl.textContent = `${w.slots || pat.length || 126} slots · VIP=${w.vip_dev || '—'} · ${w.interval || 2}s`;
  updateHeatmap(strands);
  renderInspector(st);

  // 2. Slim 126-Slot Kernel Timeline Ribbon
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
  syncTileAndTickHighlight();

  // 3. Full-Height Dual-Channel Oscilloscope + Bucket State Footer Strip
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
}
