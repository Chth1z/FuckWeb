/* ============================================================================
 * PRISM 5.0 — View 03: 21-Wavelength Optical Spectrometer, Timeline & Scope
 * ============================================================================ */

import { S, spectralColor, fmtRate } from '../state.js?v=503';
import { $, $$, el, renderSegMeter } from '../dom.js?v=503';
import { renderOscilloscope, setChartLimit, getChartLimit } from '../canvas/oscilloscope.js?v=503';

let highlightedStrandId = null;

function fmtShortRate(bps) {
  const b = (bps || 0) * 8;
  if (b <= 50) return '—';
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

  const eqCols = $('#spectrum-eq')?.children || [];
  for (const col of eqCols) {
    const id = Number(col.dataset.sid);
    if (strandId == null) col.classList.remove('dim', 'hi');
    else {
      col.classList.toggle('hi', id === strandId);
      col.classList.toggle('dim', id !== strandId);
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

function buildEqualizerColumns(eq, strands) {
  const frag = document.createDocumentFragment();
  const total = Math.max(1, strands.length);
  strands.forEach((s, idx) => {
    const col = spectralColor(idx, total);
    const shortName = s.dev === 'wan' ? 'wan' : String(s.dev || idx).replace(/^vwan/, 'v');
    const stack = el('div', { class: 'spec-stack' });
    for (let c = 0; c < 10; c++) {
      stack.appendChild(el('div', { class: 'spec-cell' }));
    }

    const colEl = el('div', {
      class: 'spec-col',
      'data-sid': s.id,
      style: { '--sc-rgb': col.rgb, '--sc-css': col.css },
      onMouseenter: () => highlightStrand(s.id),
      onMouseleave: () => highlightStrand(null)
    },
      el('div', { class: 'spec-slots' }, '0s'),
      stack,
      el('div', { class: 'spec-name' }, shortName),
      el('div', { class: 'spec-rtt' }, '—'),
      el('div', { class: 'spec-rate' }, '—')
    );
    frag.appendChild(colEl);
  });
  eq.innerHTML = '';
  eq.appendChild(frag);
  eq.dataset.count = String(strands.length);
}

function updateEqualizer(strands) {
  const eq = $('#spectrum-eq');
  if (!eq || !strands.length) return;
  if (Number(eq.dataset.count) !== strands.length) {
    buildEqualizerColumns(eq, strands);
  }

  const total = Math.max(1, strands.length);
  const cols = eq.children;
  for (let i = 0; i < strands.length; i++) {
    const s = strands[i];
    const colEl = cols[i];
    if (!colEl) continue;
    const col = spectralColor(i, total);
    const pct = s.healthy ? Math.max(0, Math.min(100, s.tokens_pct ?? 100)) : 0;
    const litCount = s.healthy ? Math.round(pct / 10) : 0;
    const rateTotal = (s.now ?? s.rate ?? 0) + (s.up_now ?? s.up ?? 0);

    colEl.classList.toggle('vip', !!s.vip);
    colEl.title = `${s.dev} (${col.lambda}nm) · ${s.ip || 'no lease'} · τ=${s.ttfb_ms || '—'}ms · tokens ${Math.round(pct)}%`;

    const slotEl = colEl.children[0];
    const stackEl = colEl.children[1];
    const rttEl = colEl.children[3];
    const rateEl = colEl.children[4];

    slotEl.textContent = s.vip ? 'VIP*' : `${s.slots ?? 0}s`;
    rttEl.textContent = s.ttfb_ms > 0 ? `${s.ttfb_ms}m` : '—';
    rateEl.textContent = fmtShortRate(rateTotal);
    rateEl.style.color = rateTotal > 1000 ? col.css : 'var(--text-muted)';

    const cells = stackEl.children;
    const bucketDim = s.bucket === 'cooling' ? 0.58 : (s.bucket === 'draining' ? 0.85 : 1.0);
    for (let c = 0; c < 10; c++) {
      const cell = cells[c];
      if (!s.healthy) {
        cell.className = c === 0 ? 'spec-cell down' : 'spec-cell';
        cell.style.opacity = '';
      } else if (c < litCount) {
        cell.className = 'spec-cell lit';
        cell.style.opacity = String(bucketDim);
      } else {
        cell.className = 'spec-cell';
        cell.style.opacity = '';
      }
    }
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

  // 1. 21-Column Optical Spectrometer Equalizer
  $('#weave-cap').textContent = `${w.slots || pat.length || 0} slots · VIP=${w.vip_dev || '—'} · ${w.interval || 2}s sweep`;
  updateEqualizer(strands);

  // 2. Slim Single-Row 126-Slot Kernel Timeline Ribbon
  const mat = $('#pattern');
  if (mat) {
    const sig = pat.join(',');
    if (mat.dataset.sig !== sig) {
      mat.dataset.sig = sig;
      const frag = document.createDocumentFragment();
      for (let i = 0; i < pat.length; i++) {
        const sid = pat[i];
        const col = colorById[sid] || { css: '#64a8ef', lambda: 520 };
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

  // 4. Compact 21-Strand Token Capacitor Table
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
    const meterWrap = el('div', { style: { display: 'flex', alignItems: 'center', gap: '6px' } });
    const seg = el('span', { class: 'seg-meter' });
    renderSegMeter(seg, (s.tokens_pct ?? 100) / 100, 8, meterColor);
    const kbTxt = s.cooldown_rem > 0
      ? `${Math.round((s.tokens || 0) / 1000)}K (${s.cooldown_rem}s)`
      : `${Math.round((s.tokens || 0) / 1000)}K`;
    meterWrap.append(seg, el('span', { class: 'c-sec', style: { fontSize: '10.5px' } }, kbTxt));

    const tr = el('tr', {
      'data-sid': s.id,
      class: highlightedStrandId === s.id ? 'hi' : '',
      style: { cursor: 'default' },
      onMouseenter: () => highlightStrand(s.id),
      onMouseleave: () => highlightStrand(null)
    },
      el('td', {},
        el('div', { style: { display: 'flex', alignItems: 'center', gap: '6px' } },
          el('span', { style: { display: 'inline-block', width: '8px', height: '8px', borderRadius: '1px', background: col.css, boxShadow: `0 0 6px ${col.css}` } }),
          el('strong', { class: 'c-bright' }, `${s.dev}`),
          el('span', { class: 'c-muted', style: { fontSize: '10.5px' } }, `${col.lambda}nm`)
        )
      ),
      el('td', {},
        s.healthy
          ? el('span', { class: `st-badge ${bClass}` }, bText)
          : el('span', { class: 'st-badge depleted' }, s.parked ? 'PARKED' : 'DOWN')
      ),
      el('td', { class: 'num' }, s.ttfb_ms > 0 ? `${s.ttfb_ms}ms` : '—'),
      el('td', { class: 'num c-mint' }, fmtRate(s.now ?? s.rate).full),
      el('td', { class: 'num c-blue' }, fmtRate(s.up_now ?? s.up).full),
      el('td', { class: 'num c-sec' }, fmtRate(s.peak).full),
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
