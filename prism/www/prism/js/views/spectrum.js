/* ============================================================================
 * PRISM 5.0 — View 03: 21 Wavelengths, 126-Slot ISWRR Matrix & Oscilloscope
 * ============================================================================ */

import { S, spectralColor, fmtRate } from '../state.js';
import { $, $$, el, renderSegMeter } from '../dom.js';
import { renderOscilloscope, setChartLimit, getChartLimit } from '../canvas/oscilloscope.js';

let highlightedStrandId = null;

export function bindSpectrumEvents() {
  $$('#chart-range .seg-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const lim = Number(btn.dataset.limit || 360);
      $$('#chart-range .seg-btn').forEach(b => b.classList.toggle('on', Number(b.dataset.limit) === lim));
      setChartLimit(lim);
    });
  });
}

function highlightMatrix(strandId) {
  highlightedStrandId = strandId;
  const cells = $('#pattern')?.children || [];
  for (const cell of cells) {
    const id = Number(cell.dataset.sid);
    if (strandId == null) {
      cell.classList.remove('dim', 'hi');
    } else {
      cell.classList.toggle('hi', id === strandId);
      cell.classList.toggle('dim', id !== strandId);
    }
  }
}

export function renderSpectrum() {
  const st = S.status;
  if (!st) return;

  const strands = st.strands || [];
  const pat = st.weave?.pattern || [];
  const colorById = {};
  strands.forEach((s, idx) => {
    colorById[s.id] = spectralColor(idx, Math.max(1, strands.length));
  });

  // 1. 126-Slot ISWRR Matrix
  $('#weave-cap').textContent = `${st.weave?.slots || pat.length || 0} slots · VIP=${st.weave?.vip_dev || '—'} · ${st.weave?.interval || 2}s sweep`;
  const mat = $('#pattern');
  if (mat) {
    const sig = pat.join(',');
    if (mat.dataset.sig !== sig) {
      mat.dataset.sig = sig;
      const frag = document.createDocumentFragment();
      for (let i = 0; i < pat.length; i++) {
        const sid = pat[i];
        const col = colorById[sid] || { css: '#68a3dc', lambda: 520 };
        const cell = el('div', {
          class: 'slot-cell',
          'data-sid': sid,
          title: `slot #${i} -> strand ${sid} (λ=${col.lambda}nm)`,
          style: { backgroundColor: col.css, color: col.css }
        });
        cell.addEventListener('mouseenter', () => highlightMatrix(sid));
        cell.addEventListener('mouseleave', () => highlightMatrix(null));
        frag.appendChild(cell);
      }
      mat.innerHTML = '';
      mat.appendChild(frag);
      if (highlightedStrandId != null) highlightMatrix(highlightedStrandId);
    }
  }

  // 2. Oscilloscope
  renderOscilloscope();
  $$('#chart-range .seg-btn').forEach(b => b.classList.toggle('on', Number(b.dataset.limit) === getChartLimit()));

  // 3. 21-Strand Token Bucket Table (in-place smooth update where rows match)
  const tbody = $('#strands-tbody');
  if (!tbody) return;

  const bucketLabels = {
    charged: ['CHARGED 滿桶', 'charged'],
    draining: ['DRAINING 釋放', 'draining'],
    cooling: ['COOLING 回血', 'cooling'],
    depleted: ['DEPLETED 退避', 'depleted']
  };

  const frag = document.createDocumentFragment();
  strands.forEach((s, idx) => {
    const col = spectralColor(idx, Math.max(1, strands.length));
    const [bText, bClass] = s.vip ? ['VIP* 專線', 'vip'] : (bucketLabels[s.bucket] || [s.bucket || 'CHARGED', 'charged']);
    const meterColor = s.vip ? 'blue' : (s.bucket === 'charged' ? 'mint' : (s.bucket === 'cooling' ? 'violet' : 'amber'));
    const meterWrap = el('div', { style: { display: 'flex', alignItems: 'center', gap: '8px' } });
    const seg = el('span', { class: 'seg-meter' });
    renderSegMeter(seg, (s.tokens_pct ?? 100) / 100, 10, meterColor);
    const kbTxt = s.cooldown_rem > 0
      ? `${Math.round((s.tokens || 0) / 1000)} KB (${s.cooldown_rem}s)`
      : `${Math.round((s.tokens || 0) / 1000)} KB`;
    meterWrap.append(seg, el('span', { class: 'c-sec', style: { fontSize: '11px' } }, kbTxt));

    const tr = el('tr', {
      style: { cursor: 'default' },
      onMouseenter: () => highlightMatrix(s.id),
      onMouseleave: () => highlightMatrix(null)
    },
      el('td', {},
        el('div', { style: { display: 'flex', alignItems: 'center', gap: '8px' } },
          el('span', { style: { display: 'inline-block', width: '9px', height: '9px', background: col.css } }),
          el('strong', { class: 'c-bright' }, `${s.dev}`),
          el('span', { class: 'c-muted', style: { fontSize: '11px' } }, `${col.lambda}nm · #${s.id}`)
        ),
        el('div', { class: 'c-muted', style: { fontSize: '11px', marginLeft: '17px' } }, s.ip || 'no lease')
      ),
      el('td', {},
        s.healthy
          ? el('span', { class: `st-badge ${bClass}` }, bText)
          : el('span', { class: 'st-badge depleted' }, s.parked ? 'PARKED' : 'DOWN')
      ),
      el('td', { class: 'num' }, s.ttfb_ms > 0 ? `${s.ttfb_ms} ms` : '—'),
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
