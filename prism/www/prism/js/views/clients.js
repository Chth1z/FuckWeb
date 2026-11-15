/* ============================================================================
 * PRISM 5.0 — View 04: Terminals, TW-HOME Relay Cage & Active Flows
 * ============================================================================ */

import { S, fmtRate, fmtBytes } from '../state.js?v=503';
import { $, $$, el } from '../dom.js?v=503';
import { write } from '../api.js?v=503';

const POLICIES = [
  ['auto',   '自動'],
  ['game',   'VIP電競'],
  ['direct', '直連'],
  ['tunnel', '強制隧道'],
  ['block',  '禁網']
];

const RULE_LABELS = {
  'device-block': '設備禁網',
  'relay': '中繼直連',
  'quic': 'QUIC攔截',
  'device-direct': '設備直連',
  'device-tunnel': '設備隧道',
  'tunnel-range': '強制IP段',
  'tunnel-domain': 'SmartDNS釘選',
  'domestic': '國內直連',
  'tunnel-port': '海外UDP端口',
  'rest-tunnel': '其餘→TW-HOME',
  'rest-direct': '其餘直連'
};

export function bindClientsEvents() {
  $$('#conn-route-seg .seg-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      S.connFilter.route = btn.dataset.route;
      $$('#conn-route-seg .seg-btn').forEach(b => b.classList.toggle('on', b.dataset.route === S.connFilter.route));
      renderConnectionsTable();
    });
  });

  $('#conn-q')?.addEventListener('input', (e) => {
    S.connFilter.q = (e.target.value || '').trim().toLowerCase();
    renderConnectionsTable();
  });
}

function renderRelaysAndRules() {
  const tun = S.tunnel;
  const rg = $('#relays-grid');
  if (tun && rg) {
    $('#tunnel-summary').textContent = tun.reachable
      ? `策略組 ${tun.selected || 'TW-HOME'} · 活躍節點 ${tun.tw_home || tun.auto || '—'}`
      : 'Mihomo 未連接';
    const zLink = $('#zashboard-link');
    if (zLink && tun.dashboard) zLink.href = tun.dashboard;

    const relays = tun.relays || [];
    const sig = `${tun.selected}|${tun.tw_home}|` + relays.map(r => `${r.name}:${r.delay}`).join(',');
    if (rg.dataset.sig !== sig) {
      rg.dataset.sig = sig;
      const frag = document.createDocumentFragment();
      for (const r of relays) {
        const active = r.name === tun.selected;
        const delayTxt = r.delay > 0 ? `${r.delay}ms` : '—';
        frag.appendChild(el('button', {
          class: `relay-pill ${active ? 'active' : ''}`,
          onClick: () => write('select', { name: r.name }, `已切換出口為 ${r.name}`)
        },
          el('span', { class: active ? 'c-mint' : 'c-bright' }, r.name),
          el('span', { class: 'c-muted' }, delayTxt)
        ));
      }
      rg.innerHTML = '';
      rg.appendChild(frag);
    }
  }

  const rs = S.rules;
  const rf = $('#rules-flow');
  if (rs && rf) {
    const sz = rs.sizes || {};
    $('#rules-sizes').textContent = `domestic=${sz.domestic4 || 0} tunnel4=${sz.tunnel4 || 0} dns=${sz.tunnel4_dns || 0} relay=${sz.relay4 || 0}`;
    const sig = (rs.rules || []).map(r => `${r.tag}:${r.packets}`).join('|');
    if (rf.dataset.sig !== sig) {
      rf.dataset.sig = sig;
      const frag = document.createDocumentFragment();
      for (const r of rs.rules || []) {
        frag.appendChild(el('div', { class: 'rule-chip' },
          el('span', { class: 'c-sec' }, RULE_LABELS[r.tag] || r.tag),
          el('strong', { class: r.packets > 0 ? 'c-mint' : 'c-muted' }, `${r.packets} pkts`)
        ));
      }
      rf.innerHTML = '';
      rf.appendChild(frag);
    }
  }
}

function renderDevicesTable() {
  const tbody = $('#devices-tbody');
  if (!tbody) return;
  // Never stomp active inline text editing
  if (document.activeElement?.dataset?.deviceInput === '1') return;

  const list = [...(S.devices?.devices || [])].sort((a, b) => {
    if (a.online !== b.online) return b.online - a.online;
    return (b.down + b.up) - (a.down + a.up);
  });

  const frag = document.createDocumentFragment();
  for (const d of list) {
    const inp = el('input', {
      class: 'bp-input',
      value: d.named ? d.name : (d.name || d.host || ''),
      placeholder: d.host || d.mac,
      'data-device-input': '1',
      style: { width: '165px', opacity: d.online ? '1' : '0.65' }
    });
    const commitAlias = () => {
      const val = inp.value.trim();
      const orig = d.named ? d.name : (d.name || d.host || '');
      if (val !== orig) {
        write('device', { mac: d.mac, name: val, policy: d.policy || 'auto' }, `終端 ${val || d.mac} 名稱已儲存`);
      }
    };
    inp.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); inp.blur(); } });
    inp.addEventListener('blur', commitAlias);

    const seg = el('div', { class: 'seg-group' });
    for (const [pol, label] of POLICIES) {
      const btn = el('button', {
        class: `seg-btn ${(d.policy || 'auto') === pol ? 'on' : ''}`,
        onClick: () => write('device', { mac: d.mac, name: d.named ? d.name : '', policy: pol }, `已設 ${d.name || d.mac} → ${label}`)
      }, label);
      seg.appendChild(btn);
    }

    const linkBadge = d.link === 'wired'
      ? el('span', { class: 'c-blue' }, 'Wired')
      : el('span', { class: 'c-mint' }, `${d.link} ${d.signal ? d.signal + 'dBm' : ''}`);

    frag.appendChild(el('tr', {},
      el('td', {},
        inp,
        el('div', { class: 'c-muted', style: { fontSize: '11px', marginTop: '2px' } }, `${d.online ? '● ' : '○ '}${d.mac}`)
      ),
      el('td', {}, linkBadge),
      el('td', { class: 'c-bright' }, d.ip || '—'),
      el('td', { class: 'num c-mint' }, d.down > 0 ? fmtRate(d.down).full : '—'),
      el('td', { class: 'num c-blue' }, d.up > 0 ? fmtRate(d.up).full : '—'),
      el('td', {}, seg)
    ));
  }

  tbody.innerHTML = '';
  tbody.appendChild(frag);
}

export function renderConnectionsTable() {
  const empty = $('#conn-empty');
  const wrap = $('#conn-table-wrap');
  const tbody = $('#connections-tbody');
  if (!tbody) return;

  if (!S.session) {
    empty.style.display = 'block';
    wrap.style.display = 'none';
    $('#conn-cap').textContent = '需要管理驗證';
    return;
  }

  empty.style.display = 'none';
  wrap.style.display = 'block';

  const now = performance.now();
  const prev = S.flowSnapshot || {};
  const dt = S.flowSnapshotTs > 0 ? Math.max(0.5, (now - S.flowSnapshotTs) / 1000) : 0;
  const list = S.connections?.connections || [];

  const ipNames = {};
  for (const d of S.devices?.devices || []) {
    if (d.ip) ipNames[d.ip] = d.name || d.host || d.ip;
  }

  const nextSnap = {};
  const enriched = [];
  for (const c of list) {
    nextSnap[c.key] = { down: c.down, up: c.up };
    const old = prev[c.key];
    const rDown = (old && dt > 0 && c.down >= old.down) ? (c.down - old.down) / dt : 0;
    const rUp = (old && dt > 0 && c.up >= old.up) ? (c.up - old.up) / dt : 0;
    enriched.push({ ...c, rDown, rUp, srcName: ipNames[c.src] || c.src });
  }
  S.flowSnapshot = nextSnap;
  S.flowSnapshotTs = now;

  const { route, q } = S.connFilter;
  const filtered = enriched.filter(c => {
    if (route === 'direct' && c.route !== 'direct') return false;
    if (route === 'tunnel' && c.route !== 'tunnel') return false;
    if (route === 'vip' && !c.vip) return false;
    if (q) {
      const hay = `${c.src} ${c.srcName} ${c.dst} ${c.port} ${c.via}`.toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  }).sort((a, b) => (b.rDown + b.rUp) - (a.rDown + a.rUp) || (b.down + b.up) - (a.down + a.up));

  $('#conn-cap').textContent = `顯示 ${Math.min(120, filtered.length)} / 共 ${list.length} 條流`;

  const frag = document.createDocumentFragment();
  for (const c of filtered.slice(0, 120)) {
    const viaBadge = c.vip
      ? el('span', { class: 'st-badge vip' }, `VIP · ${c.via}`)
      : (c.route === 'tunnel'
        ? el('span', { class: 'st-badge cooling' }, c.via || 'TW-HOME')
        : el('span', { class: 'st-badge charged' }, c.via || 'direct'));

    frag.appendChild(el('tr', {},
      el('td', {}, el('span', { class: 'c-bright' }, c.srcName), el('div', { class: 'c-muted', style: { fontSize: '10.5px' } }, c.src)),
      el('td', { style: { maxWidth: '240px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, c.dst),
      el('td', {}, `${c.proto?.toUpperCase()} :${c.port}`),
      el('td', {}, viaBadge),
      el('td', { class: 'num c-mint' }, c.rDown > 100 ? fmtRate(c.rDown).full : '—'),
      el('td', { class: 'num c-blue' }, c.rUp > 100 ? fmtRate(c.rUp).full : '—'),
      el('td', { class: 'num c-sec' }, fmtBytes((c.down || 0) + (c.up || 0)))
    ));
  }

  tbody.innerHTML = '';
  tbody.appendChild(frag);
}

export function renderClients() {
  renderRelaysAndRules();
  renderDevicesTable();
  renderConnectionsTable();
}
