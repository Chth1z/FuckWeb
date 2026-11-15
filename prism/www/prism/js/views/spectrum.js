/* ============================================================================
 * PRISM — View 03: Optical Emission Heatmap, Oscilloscope & 21-Ch Telemetry
 * ============================================================================ */

import { S, spectralColor } from '../state.js?v=5.1.0';
import { $, $$, el, renderSegMeter } from '../dom.js?v=5.1.0';
import { renderOscilloscope, setChartLimit, getChartLimit } from '../canvas/oscilloscope.js?v=5.1.0';

let highlightedStrandId = null;

function fmtShortRate(bps) {
  const b = (bps || 0) * 8;
  if (b <= 50) return '0';
  if (b >= 1e9) return `${(b / 1e9).toFixed(1)}G`;
  if (b >= 1e6) return `${(b / 1e6).toFixed(b >= 10e6 ? 0 : 1)}M`;
  if (b >= 1e3) return `${Math.round(b / 1e3)}K`;
  return `${Math.round(b)}b`;
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

function highlightStrand(strandId) {
  highlightedStrandId = strandId;

  const tiles = $('#spectrum-heatmap')?.children || [];
  for (const tile of tiles) {
    const id = Number(tile.dataset.sid);
    if (strandId == null) tile.classList.remove('dim', 'hi');
    else {
      tile.classList.toggle('hi', id === strandId);
      tile.classList.toggle('dim', id !== strandId);
    }
  }

  const ticks = $('#pattern')?.children || [];
  for (const t of ticks) {
    const id = Number(t.dataset.sid);
    if (strandId == null) t.classList.remove('dim', 'hi');
    else {
      t.classList.toggle('hi', id === strandId);
      t.classList.toggle('dim', id !== strandId);
    }
  }

  const rows = $('#strands-tbody')?.children || [];
  for (const tr of rows) {
    const id = Number(tr.dataset.sid);
    tr.classList.toggle('hi', strandId != null && id === strandId);
  }
}

function buildHeatmapTiles(grid, strands) {
  const frag = document.createDocumentFragment();
  const total = Math.max(1, strands.length);
  strands.forEach((s, idx) => {
    const col = spectralColor(idx, total);
    const shortName = s.dev === 'wan' ? 'wan' : String(s.dev || idx).replace(/^vwan/, 'v');
    const tile = el('div', {
      class: 'heat-tile',
      'data-sid': s.id,
      style: { '--sc-rgb': col.rgb },
      onMouseenter: () => highlightStrand(s.id),
      onMouseleave: () => highlightStrand(null)
    },
      el('div', { class: 'heat-top' },
        el('span', { class: 'heat-name' }, shortName),
        el('span', { class: 'heat-slot' }, '0s')
      ),
      el('div', { class: 'heat-rate' }, '0 bps'),
      el('div', { class: 'heat-foot' },
        el('span', {}, '—'),
        el('span', {}, '100%')
      )
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
    const rel = maxMbps > 0.1 ? mbps / maxMbps : 0;
    const absPulse = Math.min(1, Math.log10(1 + mbps * 5) / 1.7);
    const bucketFloor = s.bucket === 'cooling' ? 0.06 : (s.bucket === 'depleted' ? 0.04 : 0.12);
    const heat = s.healthy ? Math.min(1, bucketFloor * (pct / 100) + Math.max(absPulse, rel * 0.85) * 0.88) : 0;

    tile.classList.toggle('vip', !!s.vip);
    tile.classList.toggle('down', !s.healthy);
    tile.style.setProperty('--heat-core', (0.06 + heat * 0.56).toFixed(2));
    tile.style.setProperty('--heat-halo', (0.04 + heat * 0.44).toFixed(2));
    tile.style.setProperty('--heat-inner', (0.04 + heat * 0.24).toFixed(2));
    tile.style.setProperty('--heat-blur', `${Math.round(8 + heat * 18)}px`);
    tile.style.borderColor = !s.healthy
      ? 'rgba(230, 108, 120, 0.55)'
      : (s.vip ? 'var(--c-blue)' : `rgba(${col.rgb}, ${(0.28 + heat * 0.70).toFixed(2)})`);
    tile.title = `${s.dev} (${col.lambda}nm) · ${s.ip || 'no lease'} · τ=${s.ttfb_ms || '—'}ms · loss ${s.loss_pct ?? 0}% · tokens ${Math.round(pct)}%`;

    const slotEl = tile.children[0].children[1];
    const rateEl = tile.children[1];
    const footL = tile.children[2].children[0];
    const footR = tile.children[2].children[1];

    slotEl.textContent = !s.healthy ? 'DOWN' : (s.vip ? 'VIP*' : `${s.slots ?? 0}s`);
    rateEl.textContent = s.healthy ? (rateTotal > 50 ? fmtShortRate(rateTotal) : 'idle') : (s.parked ? 'PARK' : 'OFF');
    rateEl.style.color = !s.healthy
      ? 'var(--c-crimson)'
      : (rateTotal > 2000 ? '#ffffff' : 'var(--text-secondary)');
    footL.textContent = s.ttfb_ms > 0 ? `${s.ttfb_ms}m` : '—';
    footL.style.color = s.loss_pct >= 15 ? 'var(--c-amber)' : 'var(--text-muted)';
    footR.textContent = `${Math.round(pct)}%`;
  }
}

export function renderSpectrum() {
  const st = S.status;
  if (!st) return;

  const strands = st.strands || [];
  const pat = st.weave?.pattern || [];
  const w = st.weave || {};
  const colorById = {};
  strands.forEach((s, idx) => {
    colorById[s.id] = spectralColor(idx, Math.max(1, strands.length));
  });

  // 1. Optical Emission Heatmap
  $('#weave-cap').textContent = `${w.slots || pat.length || 0} slots · VIP=${w.vip_dev || '—'} · ${w.interval || 2}s`;
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
        tick.addEventListener('mouseenter', () => highlightStrand(sid));
        tick.addEventListener('mouseleave', () => highlightStrand(null));
        frag.appendChild(tick);
      }
      mat.innerHTML = '';
      mat.appendChild(frag);
      if (highlightedStrandId != null) highlightStrand(highlightedStrandId);
    }
  }

  // 3. Dual-Channel Oscilloscope + Bucket State Summary Strip
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

  // 4. Right Full-Height 21-Strand Token Capacitor Telemetry Table
  const tbody = $('#strands-tbody');
  if (!tbody) return;

  const bucketLabels = {
    charged: ['CHARGED', 'charged'],
    draining: ['DRAINING', 'draining'],
    cooling: ['COOLING', 'cooling'],
    depleted: ['DEPLETED', 'depleted']
  };

  const frag = document.createDocumentFragment();
  strands.forEach((s, idx) => {
    const col = spectralColor(idx, Math.max(1, strands.length));
    const [bText, bClass] = s.vip ? ['VIP*', 'vip'] : (bucketLabels[s.bucket] || [s.bucket || 'CHARGED', 'charged']);
    const meterColor = s.vip ? 'blue' : (s.bucket === 'charged' ? 'mint' : (s.bucket === 'cooling' ? 'violet' : 'amber'));
    const meterWrap = el('div', { style: { display: 'flex', alignItems: 'center', gap: '5px' } });
    const seg = el('span', { class: 'seg-meter' });
    renderSegMeter(seg, (s.tokens_pct ?? 100) / 100, 6, meterColor);
    const kbTxt = s.cooldown_rem > 0
      ? `${s.tokens_pct ?? 100}%(${s.cooldown_rem}s)`
      : `${s.tokens_pct ?? 100}%`;
    meterWrap.append(seg, el('span', { class: 'c-sec', style: { fontSize: '10px' } }, kbTxt));

    const rttNode = s.loss_pct > 0
      ? el('span', { class: s.loss_pct >= 15 ? 'c-amber' : 'c-sec', title: `packet loss ${s.loss_pct}%` }, `${s.ttfb_ms > 0 ? s.ttfb_ms + 'm' : '—'}·${s.loss_pct}%`)
      : el('span', {}, s.ttfb_ms > 0 ? `${s.ttfb_ms}m` : '—');

    const tr = el('tr', {
      'data-sid': s.id,
      class: highlightedStrandId === s.id ? 'hi' : '',
      style: { cursor: 'pointer' },
      onMouseenter: () => highlightStrand(s.id),
      onMouseleave: () => highlightStrand(null)
    },
      el('td', {},
        el('div', { style: { display: 'flex', alignItems: 'center', gap: '5px' } },
          el('span', { style: { display: 'inline-block', width: '7px', height: '7px', background: col.css, boxShadow: `0 0 6px ${col.css}` } }),
          el('strong', { class: 'c-bright' }, `${s.dev}`),
          el('span', { class: 'c-muted', style: { fontSize: '10px' } }, `${col.lambda}`)
        )
      ),
      el('td', {},
        s.healthy
          ? el('span', { class: `st-badge ${bClass}` }, bText)
          : el('span', { class: 'st-badge depleted' }, s.parked ? 'PARK' : 'DOWN')
      ),
      el('td', { class: 'num' }, rttNode),
      el('td', { class: 'num c-mint' }, fmtShortRate(s.now ?? s.rate)),
      el('td', { class: 'num c-blue' }, fmtShortRate(s.up_now ?? s.up)),
      el('td', { class: 'num c-sec' }, fmtShortRate(s.peak)),
      el('td', {}, meterWrap),
      el('td', { class: 'num' },
        s.vip ? el('span', { class: 'c-blue' }, 'VIP') : el('strong', { class: s.slots > 0 ? 'c-bright' : 'c-muted' }, `${s.slots ?? 0}`)
      )
    );
    frag.appendChild(tr);
  });

  tbody.innerHTML = '';
  tbody.appendChild(frag);
}
