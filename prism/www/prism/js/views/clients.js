/* ============================================================================
 * PRISM — View 04: Left-Right Secondary Menu Device & Live Connections Explorer
 * ============================================================================ */

import { S, fmtRate, fmtBytes } from '../state.js?v=5.1.0';
import { $, $$, el } from '../dom.js?v=5.1.0';
import { write } from '../api.js?v=5.1.0';

const POLICIES = ['auto', 'game', 'direct', 'tunnel', 'block'];
const POLICY_META = {
  auto:   { label: '自動分類',     cls: 'c-sec' },
  game:   { label: '@vip_lane 專線', cls: 'c-blue' },
  direct: { label: '強制直連',     cls: 'c-mint' },
  tunnel: { label: '強制 TW-HOME', cls: 'c-violet' },
  block:  { label: '禁止聯網',     cls: 'c-crimson' }
};

function computeFlowDeltas() {
  const conns = S.connections?.connections || [];
  const now = performance.now();
  const dt = S.flowSnapshotTs ? (now - S.flowSnapshotTs) / 1000 : 0;
  const nextSnap = {};
  const byIp = {};
  const rows = [];

  for (const f of conns) {
    const prev = S.flowSnapshot[f.key];
    let rDown = 0, rUp = 0;
    if (prev && dt > 0.4 && f.down >= prev.down && f.up >= prev.up) {
      rDown = (f.down - prev.down) / dt;
      rUp = (f.up - prev.up) / dt;
    }
    nextSnap[f.key] = { down: f.down || 0, up: f.up || 0 };
    if (f.src) {
      if (!byIp[f.src]) byIp[f.src] = { down: 0, up: 0, count: 0 };
      byIp[f.src].down += rDown;
      byIp[f.src].up += rUp;
      byIp[f.src].count++;
    }
    rows.push({ ...f, rDown, rUp });
  }
  S.flowSnapshot = nextSnap;
  S.flowSnapshotTs = now;
  return { byIp, rows };
}

function selectDevice(mac) {
  S.selectedDeviceMac = mac || 'all';
  renderClients();
}

export function bindClientsEvents() {
  $('#dev-menu-q')?.addEventListener('input', (e) => {
    S.devMenuQuery = e.target.value.trim().toLowerCase();
    renderClients();
  });

  $('#dev-nav-all')?.addEventListener('click', () => selectDevice('all'));
  $('#btn-dev-back')?.addEventListener('click', () => selectDevice('all'));

  const saveSelectedAlias = () => {
    const devs = S.devices?.devices || [];
    const dev = devs.find(d => d.mac === S.selectedDeviceMac);
    const inp = $('#sel-dev-name');
    if (!dev || !inp) return;
    write('device', { mac: dev.mac, name: inp.value.trim(), policy: dev.policy || 'auto' }, '終端別名已儲存');
  };

  $('#btn-dev-save-name')?.addEventListener('click', saveSelectedAlias);
  $('#sel-dev-name')?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') saveSelectedAlias();
  });

  $$('#sel-dev-policy-seg .seg-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const devs = S.devices?.devices || [];
      const dev = devs.find(d => d.mac === S.selectedDeviceMac);
      if (!dev) return;
      const policy = btn.dataset.policy;
      write('device', { mac: dev.mac, name: dev.name || '', policy }, `${dev.name || dev.mac} 策略已設為 ${POLICY_META[policy]?.label || policy}`);
    });
  });

  $$('#conn-route-seg .seg-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      S.connFilter.route = btn.dataset.route;
      $$('#conn-route-seg .seg-btn').forEach(b => b.classList.toggle('on', b.dataset.route === S.connFilter.route));
      renderClients();
    });
  });

  $('#conn-q')?.addEventListener('input', (e) => {
    S.connFilter.q = e.target.value.trim().toLowerCase();
    renderClients();
  });
}

function renderDeviceMenu(devs, byIp, totalFlows) {
  const onlineCnt = devs.filter(d => d.online).length;
  if ($('#clients-online-cnt')) $('#clients-online-cnt').textContent = `${onlineCnt} 在線 / ${devs.length} 台`;

  let totDown = 0;
  for (const ip of Object.keys(byIp)) totDown += byIp[ip].down;
  if ($('#dev-all-rate')) $('#dev-all-rate').textContent = S.session ? fmtRate(totDown).full : `${onlineCnt} 台`;
  if ($('#dev-all-flows')) $('#dev-all-flows').textContent = S.session ? `${totalFlows} 條活躍流` : '全局檢視';

  const navAll = $('#dev-nav-all');
  if (navAll) navAll.classList.toggle('active', S.selectedDeviceMac === 'all');

  const list = $('#dev-menu-list');
  if (!list) return;

  const q = S.devMenuQuery || '';
  const filtered = devs.filter(d => {
    if (!q) return true;
    const text = `${d.name || ''} ${d.host || ''} ${d.ip || ''} ${d.mac || ''}`.toLowerCase();
    return text.includes(q);
  });

  const sorted = [...filtered].sort((a, b) => {
    if (a.online !== b.online) return a.online ? -1 : 1;
    const ra = (byIp[a.ip]?.down || 0) + (byIp[a.ip]?.up || 0);
    const rb = (byIp[b.ip]?.down || 0) + (byIp[b.ip]?.up || 0);
    if (rb !== ra) return rb - ra;
    return (a.name || a.host || a.mac).localeCompare(b.name || b.host || b.mac);
  });

  const frag = document.createDocumentFragment();
  if (!sorted.length) {
    frag.appendChild(el('div', { class: 'c-muted', style: { padding: '14px', textAlign: 'center', fontSize: '11.5px' } }, '無匹配終端'));
  } else {
    for (const d of sorted) {
      const dr = byIp[d.ip] || { down: 0, up: 0, count: 0 };
      const pm = POLICY_META[d.policy || 'auto'] || POLICY_META.auto;
      const isSelected = S.selectedDeviceMac === d.mac;
      const label = d.name || d.host || d.mac.slice(-8);
      const rightStat = S.session && dr.down + dr.up > 50
        ? fmtRate(dr.down).full
        : (d.policy && d.policy !== 'auto' ? pm.label : (d.online ? '在線' : '離線'));
      const rightCls = S.session && dr.down + dr.up > 50 ? 'c-mint' : (d.policy && d.policy !== 'auto' ? pm.cls : (d.online ? 'c-mint' : 'c-muted'));

      const item = el('button', {
        type: 'button',
        class: `dev-nav-item ${d.online ? 'online' : 'offline'} ${isSelected ? 'active' : ''}`,
        onClick: () => selectDevice(d.mac)
      },
        el('div', { class: 'dev-nav-top' },
          el('span', { class: 'dev-nav-name', title: `${label} (${d.mac})` }, label),
          el('span', { class: rightCls, style: { fontSize: '10.5px', fontWeight: '600', flexShrink: '0' } }, rightStat)
        ),
        el('div', { class: 'dev-nav-sub' },
          el('span', {}, `${d.ip || d.mac.slice(-8)} · ${d.link || 'wired'}`),
          el('span', { class: 'c-muted' }, S.session && dr.count > 0 ? `${dr.count} 流` : (d.policy || 'auto'))
        )
      );
      frag.appendChild(item);
    }
  }
  list.innerHTML = '';
  list.appendChild(frag);
}

function renderRightWorkspace(devs, byIp) {
  const allPanel = $('#clients-all-panel');
  const devPanel = $('#clients-dev-panel');
  const selected = S.selectedDeviceMac !== 'all'
    ? devs.find(d => d.mac === S.selectedDeviceMac)
    : null;

  if (S.selectedDeviceMac !== 'all' && !selected) {
    S.selectedDeviceMac = 'all';
  }

  if (!selected) {
    if (allPanel) allPanel.style.display = 'block';
    if (devPanel) devPanel.style.display = 'none';
    renderAllDevicesMatrix(devs, byIp);
    return null;
  }

  if (allPanel) allPanel.style.display = 'none';
  if (devPanel) devPanel.style.display = 'flex';

  const dr = byIp[selected.ip] || { down: 0, up: 0, count: 0 };
  const nameInp = $('#sel-dev-name');
  if (nameInp && document.activeElement !== nameInp && nameInp.dataset.mac !== selected.mac) {
    nameInp.value = selected.name || '';
    nameInp.placeholder = selected.host || selected.mac;
    nameInp.dataset.mac = selected.mac;
  }
  const rateEl = $('#sel-dev-rate');
  if (rateEl) {
    rateEl.textContent = S.session
      ? `↓ ${fmtRate(dr.down).full} · ↑ ${fmtRate(dr.up).full}`
      : (selected.online ? '在線' : '離線');
  }
  const metaEl = $('#sel-dev-meta');
  if (metaEl) {
    const radio = selected.signal ? ` (${selected.signal} dBm)` : '';
    metaEl.textContent = `MAC ${selected.mac} · IP ${selected.ip || '無租約'} · ${selected.link || 'wired'}${radio}`;
  }
  $$('#sel-dev-policy-seg .seg-btn').forEach(btn => {
    btn.classList.toggle('on', btn.dataset.policy === (selected.policy || 'auto'));
  });
  return selected;
}

function renderAllDevicesMatrix(devs, byIp) {
  const dtb = $('#devices-tbody');
  if (!dtb) return;
  const frag = document.createDocumentFragment();

  const sorted = [...devs].sort((a, b) => {
    if (a.online !== b.online) return a.online ? -1 : 1;
    const ra = (byIp[a.ip]?.down || 0) + (byIp[a.ip]?.up || 0);
    const rb = (byIp[b.ip]?.down || 0) + (byIp[b.ip]?.up || 0);
    if (rb !== ra) return rb - ra;
    return (a.name || a.host || a.mac).localeCompare(b.name || b.host || b.mac);
  });

  if (!sorted.length) {
    frag.appendChild(el('tr', {}, el('td', { colspan: 6, class: 'c-muted', style: { textAlign: 'center', padding: '16px' } }, '暫無局域網終端記錄')));
  } else {
    for (const d of sorted) {
      const dr = byIp[d.ip] || { down: 0, up: 0 };
      const dot = el('span', { class: d.online ? 'run-dot mint' : '' });
      if (!d.online) Object.assign(dot.style, { display: 'inline-block', width: '6px', height: '6px', background: '#4b556b' });

      const nameBtn = el('button', {
        type: 'button',
        class: 'btn-cmd',
        style: { padding: '2px 7px', fontSize: '11px', borderColor: 'transparent', background: 'transparent' },
        title: `點擊查看 ${d.name || d.host || d.mac} 的連接`,
        onClick: () => selectDevice(d.mac)
      }, d.name || d.host || d.mac.slice(-8), el('span', { class: 'c-blue', style: { marginLeft: '4px' } }, '→'));

      const sel = el('select', {
        class: 'bp-input',
        style: { fontSize: '11px', padding: '2px 6px' },
        onChange: (e) => {
          write('device', { mac: d.mac, name: d.name || '', policy: e.target.value }, `${d.name || d.mac} 策略已設為 ${e.target.value}`);
        }
      }, ...POLICIES.map(p => {
        const opt = el('option', { value: p }, POLICY_META[p]?.label || p);
        if ((d.policy || 'auto') === p) opt.selected = true;
        return opt;
      }));

      frag.appendChild(el('tr', { style: d.online ? {} : { opacity: '0.55' } },
        el('td', {}, el('div', { style: { display: 'flex', alignItems: 'center', gap: '6px' } }, dot, nameBtn)),
        el('td', {}, el('span', { class: 'c-sec' }, d.link || 'wired'), d.signal ? el('span', { class: 'c-muted', style: { marginLeft: '4px', fontSize: '10.5px' } }, `${d.signal}dBm`) : null),
        el('td', { class: 'c-sec' }, d.ip || '—'),
        el('td', { class: 'num c-mint' }, S.session ? fmtRate(dr.down).full : '—'),
        el('td', { class: 'num c-blue' }, S.session ? fmtRate(dr.up).full : '—'),
        el('td', {}, sel)
      ));
    }
  }
  dtb.innerHTML = '';
  dtb.appendChild(frag);
}

function renderConnections(devs, selectedDev, rows) {
  const scopeBadge = $('#conn-scope-badge');
  if (scopeBadge) {
    scopeBadge.textContent = selectedDev ? `${selectedDev.name || selectedDev.host || selectedDev.ip}` : '全局連接';
  }

  const empty = $('#conn-empty');
  const wrap = $('#conn-table-wrap');
  const ctb = $('#connections-tbody');
  if (!S.session) {
    if (empty) {
      empty.textContent = '請點擊右上角「管理登入」查看實時連接流表';
      empty.style.display = 'block';
    }
    if (wrap) wrap.style.display = 'none';
    if ($('#conn-cap')) $('#conn-cap').textContent = '未認證';
    return;
  }

  const devNameByIp = {};
  for (const d of devs) {
    if (d.ip) devNameByIp[d.ip] = d.name || d.host || d.ip;
  }

  const q = S.connFilter.q;
  const filtered = rows.filter(f => {
    if (selectedDev && (!selectedDev.ip || f.src !== selectedDev.ip)) return false;
    if (S.connFilter.route === 'direct' && (f.route !== 'direct' || f.vip)) return false;
    if (S.connFilter.route === 'tunnel' && f.route !== 'tunnel') return false;
    if (S.connFilter.route === 'vip' && !f.vip) return false;
    if (q) {
      const hay = `${f.src} ${devNameByIp[f.src] || ''} ${f.dst} ${f.port} ${f.via} ${f.proto}`.toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  }).sort((a, b) => (b.rDown + b.rUp) - (a.rDown + a.rUp) || (b.down + b.up) - (a.down + a.up));

  if ($('#conn-cap')) $('#conn-cap').textContent = `${filtered.length} 條活躍流`;

  if (!filtered.length) {
    if (empty) {
      empty.textContent = selectedDev ? `${selectedDev.name || selectedDev.ip} 暫無匹配連接` : '暫無匹配的活躍連接';
      empty.style.display = 'block';
    }
    if (wrap) wrap.style.display = 'none';
    return;
  }

  if (empty) empty.style.display = 'none';
  if (wrap) wrap.style.display = 'block';

  const frag = document.createDocumentFragment();
  for (const f of filtered.slice(0, 120)) {
    let badgeClass = f.route === 'tunnel' ? 'cooling' : 'charged';
    let routeText = f.route === 'tunnel' ? `TW-HOME · ${f.via || 'proxy'}` : `直連 · ${f.via || 'wan'}`;
    if (f.vip) {
      badgeClass = 'vip';
      routeText = `VIP專線 · ${f.via || 'vip'}`;
    }

    frag.appendChild(el('tr', {},
      el('td', {}, el('div', { class: 'c-bright' }, devNameByIp[f.src] || f.src), el('div', { class: 'c-muted', style: { fontSize: '10.5px' } }, f.src)),
      el('td', { style: { maxWidth: '280px', wordBreak: 'break-all' } }, f.dst),
      el('td', { class: 'c-sec' }, `${f.port} / ${String(f.proto || '').toUpperCase()}`),
      el('td', {}, el('span', { class: `st-badge ${badgeClass}` }, routeText)),
      el('td', { class: 'num c-mint' }, f.rDown > 50 ? fmtRate(f.rDown).full : '—'),
      el('td', { class: 'num c-blue' }, f.rUp > 50 ? fmtRate(f.rUp).full : '—'),
      el('td', { class: 'num c-sec' }, fmtBytes((f.down || 0) + (f.up || 0)))
    ));
  }
  if (ctb) {
    ctb.innerHTML = '';
    ctb.appendChild(frag);
  }
}

export function renderClients() {
  const devs = S.devices?.devices || [];
  const { byIp, rows } = computeFlowDeltas();
  renderDeviceMenu(devs, byIp, rows.length);
  const selectedDev = renderRightWorkspace(devs, byIp);
  renderConnections(devs, selectedDev, rows);
}
