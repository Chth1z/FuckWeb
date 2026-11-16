/* ============================================================================
 * PRISM — View 04: Merged Wide Device Policy Matrix & Live Flows Explorer
 * ============================================================================ */

import { S, desatObsidianRgb, opticalLoad, fmtRate, fmtRateCompact, fmtBytes } from '../state.js?v=5.6.6';
import { $, $$, el } from '../dom.js?v=5.6.6';
import { write, openLoginModal } from '../api.js?v=5.6.6';

const POLICIES = ['auto', 'game', 'direct', 'tunnel', 'block'];
const POLICY_META = {
  auto:   { short: '自動', label: '自動分類',     rgb: '100, 174, 245' },
  game:   { short: 'VIP',  label: '@vip_lane 專線', rgb: '100, 174, 245' },
  direct: { short: '直連', label: '強制直連',     rgb: '87, 209, 146' },
  tunnel: { short: '隧道', label: '強制 TW-HOME', rgb: '170, 142, 240' },
  block:  { short: '禁網', label: '禁止聯網',     rgb: '230, 108, 120' }
};

function deviceTileVisual(policy, online, bps) {
  if (!online) {
    return {
      scRgb: '68, 76, 94',
      litRgb: '52, 58, 72',
      fill: '0.06',
      glow: '0.02'
    };
  }
  const baseRgb = policy === 'auto'
    ? (bps > 400 ? '100, 174, 245' : '87, 209, 146')
    : (POLICY_META[policy]?.rgb || '100, 174, 245');
  const k = opticalLoad(bps, 6, 0.10);
  const sat = 0.24 + 0.76 * Math.pow(k, 0.78);
  return {
    scRgb: baseRgb,
    litRgb: desatObsidianRgb(baseRgb, sat),
    fill: (0.09 + 0.18 * Math.pow(k, 0.85)).toFixed(3),
    glow: (0.05 + 0.14 * k).toFixed(3)
  };
}

let editingMac = null;
let pointerInsideDevList = false;
let forceReorder = false;

function ipToNum(ip) {
  if (!ip) return Infinity;
  const parts = String(ip).split('.');
  if (parts.length !== 4) return Infinity;
  let n = 0;
  for (let i = 0; i < 4; i++) {
    const v = Number(parts[i]);
    if (!Number.isInteger(v) || v < 0 || v > 255) return Infinity;
    n = (n * 256) + v;
  }
  return n;
}

function compareStableTie(a, b) {
  const ia = ipToNum(a.ip);
  const ib = ipToNum(b.ip);
  if (ia !== ib) return ia - ib;
  return String(a.mac || '').localeCompare(String(b.mac || ''));
}

function compareDevices(a, b, mode, byIp) {
  if (mode === 'ip') {
    return compareStableTie(a, b);
  }
  if (a.online !== b.online) return a.online ? -1 : 1;
  if (mode === 'rate') {
    const ra = (byIp[a.ip]?.down || 0) + (byIp[a.ip]?.up || 0);
    const rb = (byIp[b.ip]?.down || 0) + (byIp[b.ip]?.up || 0);
    if (rb !== ra) return rb - ra;
  } else if (mode === 'flows') {
    const fa = byIp[a.ip]?.count || 0;
    const fb = byIp[b.ip]?.count || 0;
    if (fb !== fa) return fb - fa;
  }
  return compareStableTie(a, b);
}

let lastFlowSrc = null;
let lastFlowResult = { byIp: {}, rows: [] };
let lastConnRender = null;

function computeFlowDeltas() {
  if (!S.session || !S.connections) {
    lastFlowSrc = S.connections;
    lastFlowResult = { byIp: {}, rows: [] };
    return lastFlowResult;
  }
  if (S.connections === lastFlowSrc)
    return lastFlowResult;

  const conns = S.connections.connections || [];
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
  lastFlowSrc = S.connections;
  lastFlowResult = { byIp, rows };
  return lastFlowResult;
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

  $$('#dev-sort-seg .seg-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      S.devSort = btn.dataset.sort || 'stable';
      $$('#dev-sort-seg .seg-btn').forEach(b => b.classList.toggle('on', b.dataset.sort === S.devSort));
      forceReorder = true;
      renderClients();
    });
  });

  const devList = $('#dev-menu-list');
  devList?.addEventListener('mouseenter', () => { pointerInsideDevList = true; });
  devList?.addEventListener('mouseleave', () => {
    pointerInsideDevList = false;
    renderClients();
  });

  $('#dev-nav-all')?.addEventListener('click', () => selectDevice('all'));
  $('#btn-conn-clear-dev')?.addEventListener('click', () => selectDevice('all'));

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

function createDeviceCard(mac) {
  const dotEl = el('span', { class: 'run-dot' });
  const nameEl = el('span', { class: 'dev-nav-name' });
  const renameInput = el('input', {
    type: 'text',
    class: 'bp-input',
    style: { display: 'none', padding: '1px 6px', fontSize: '11.5px', width: '138px' },
    placeholder: '輸入設備別名...'
  });
  const renameBtn = el('button', {
    type: 'button',
    class: 'dev-rename-btn',
    title: '修改終端別名'
  }, '✎');

  const linkEl = el('span', { class: 'c-sec', style: { fontSize: '10.5px', flexShrink: '0' } });
  const flowsEl = el('span', { class: 'c-blue', style: { fontSize: '10.5px', fontWeight: '600', flexShrink: '0' } });
  const ipRateEl = el('span', { class: 'c-muted', style: { fontSize: '10.5px', fontVariantNumeric: 'tabular-nums' } });

  const pillBtns = {};
  const pillBar = el('div', { class: 'policy-pill-bar' });
  for (const p of POLICIES) {
    const b = el('button', {
      type: 'button',
      class: `policy-pill ${p}`,
      'data-policy': p,
      title: POLICY_META[p].label
    }, POLICY_META[p].short);
    b.addEventListener('click', (e) => {
      e.stopPropagation();
      const d = card._dev;
      if (!d) return;
      if (!S.session) {
        openLoginModal();
        return;
      }
      if ((d.policy || 'auto') === p) return;
      d.policy = p; // optimistic UI state
      syncDeviceCard(card, d, card._dr, S.selectedDeviceMac === mac);
      write('device', { mac: d.mac, name: d.name || '', policy: p }, `${d.name || d.mac} 策略已設為 ${POLICY_META[p].label}`);
    });
    pillBtns[p] = b;
    pillBar.appendChild(b);
  }

  const card = el('div', {
    class: 'dev-nav-item',
    'data-mac': mac,
    role: 'button',
    tabindex: '0'
  },
    el('div', { class: 'dev-nav-top' },
      el('div', { class: 'dev-title-group' }, dotEl, nameEl, renameInput, renameBtn),
      el('div', { style: { display: 'flex', alignItems: 'center', gap: '8px', flexShrink: '0' } }, linkEl, flowsEl)
    ),
    el('div', { class: 'dev-nav-sub' }, ipRateEl, pillBar)
  );

  card.addEventListener('click', () => {
    if (editingMac === mac) return;
    selectDevice(mac);
  });
  card.addEventListener('keydown', (e) => {
    if (e.target !== card) return;
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      if (editingMac !== mac) selectDevice(mac);
    }
  });

  renameBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    if (!S.session) {
      openLoginModal();
      return;
    }
    const d = card._dev;
    if (!d) return;
    editingMac = mac;
    nameEl.style.display = 'none';
    renameBtn.style.display = 'none';
    renameInput.style.display = 'inline-block';
    renameInput.value = d.name || '';
    renameInput.placeholder = d.host || d.mac;
    renameInput.focus();
    renameInput.select();
  });

  renameInput.addEventListener('click', (e) => e.stopPropagation());
  const finishRename = (commit) => {
    if (editingMac !== mac) return;
    editingMac = null;
    nameEl.style.display = '';
    renameBtn.style.display = '';
    renameInput.style.display = 'none';
    const d = card._dev;
    if (commit && d) {
      const nextName = renameInput.value.trim();
      if (nextName !== (d.name || '')) {
        d.name = nextName;
        nameEl.textContent = nextName || d.host || d.mac.slice(-8);
        write('device', { mac: d.mac, name: nextName, policy: d.policy || 'auto' }, '終端別名已儲存');
      }
    }
  };
  renameInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); finishRename(true); }
    if (e.key === 'Escape') { e.preventDefault(); finishRename(false); }
  });
  renameInput.addEventListener('blur', () => finishRename(true));

  card._refs = { dotEl, nameEl, renameInput, renameBtn, linkEl, flowsEl, ipRateEl, pillBtns };
  return card;
}

function syncDeviceCard(card, d, dr, isSelected) {
  card._dev = d;
  card._dr = dr;
  const r = card._refs;
  const label = d.name || d.host || d.mac.slice(-8);
  const policy = d.policy || 'auto';
  const totalBps = (dr?.down || 0) + (dr?.up || 0);
  const vis = deviceTileVisual(policy, !!d.online, totalBps);

  card.className = `dev-nav-item ${d.online ? 'online' : 'offline'} ${isSelected ? 'active' : ''}`;
  card.style.setProperty('--dev-sc-rgb', vis.scRgb);
  card.style.setProperty('--dev-rgb', vis.litRgb);
  card.style.setProperty('--dev-fill', vis.fill);
  card.style.setProperty('--dev-glow', vis.glow);
  r.dotEl.className = d.online ? 'run-dot mint' : 'run-dot off';

  if (editingMac !== d.mac) {
    r.nameEl.textContent = label;
    r.nameEl.title = `${label} (${d.mac})`;
  }

  const radio = d.signal ? ` ${d.signal}dBm` : '';
  r.linkEl.textContent = `${d.link || 'wired'}${radio}`;
  r.linkEl.className = d.online ? 'dev-meta-txt' : 'c-muted';
  r.flowsEl.textContent = S.session && dr.count > 0 ? `${dr.count} 流` : (d.online ? '在線' : '離線');
  r.flowsEl.className = S.session && dr.count > 0 ? 'c-blue dev-meta-strong' : (d.online ? 'c-mint dev-meta-strong' : 'c-muted');

  const rateStr = S.session && (totalBps > 50)
    ? ` · ↓${fmtRateCompact(dr.down)} ↑${fmtRateCompact(dr.up)}`
    : '';
  r.ipRateEl.textContent = `${d.ip || d.mac.slice(-8)}${rateStr}`;
  r.ipRateEl.className = rateStr ? 'c-mint dev-meta-strong' : (d.online ? 'dev-meta-txt' : 'c-muted');

  for (const p of POLICIES) {
    r.pillBtns[p].classList.toggle('on', p === policy);
  }
}

// Keyed in-place reconciliation: preserves DOM nodes & open inputs across 2s polls (Fixes 圖8)
function renderDeviceMenu(devs, byIp, totalFlows) {
  const onlineCnt = devs.filter(d => d.online).length;
  if ($('#clients-online-cnt')) $('#clients-online-cnt').textContent = `${onlineCnt} 在線 / ${devs.length} 台`;

  let totDown = 0;
  let totUp = 0;
  for (const ip of Object.keys(byIp)) {
    totDown += byIp[ip].down;
    totUp += byIp[ip].up;
  }
  if ($('#dev-all-rate')) $('#dev-all-rate').textContent = S.session ? fmtRate(totDown).full : `${onlineCnt} 台`;
  if ($('#dev-all-flows')) $('#dev-all-flows').textContent = S.session ? `${totalFlows} 條活躍流` : '全局檢視';

  const navAll = $('#dev-nav-all');
  if (navAll) {
    navAll.classList.toggle('active', S.selectedDeviceMac === 'all');
    const allVis = deviceTileVisual('game', onlineCnt > 0 || devs.length > 0, totDown + totUp);
    navAll.style.setProperty('--dev-sc-rgb', allVis.scRgb);
    navAll.style.setProperty('--dev-rgb', allVis.litRgb);
    navAll.style.setProperty('--dev-fill', allVis.fill);
    navAll.style.setProperty('--dev-glow', allVis.glow);
  }

  const list = $('#dev-menu-list');
  if (!list) return;

  const q = S.devMenuQuery || '';
  const filtered = devs.filter(d => {
    if (!q) return true;
    const text = `${d.name || ''} ${d.host || ''} ${d.ip || ''} ${d.mac || ''}`.toLowerCase();
    return text.includes(q);
  });

  const sortMode = S.devSort || 'stable';
  $$('#dev-sort-seg .seg-btn').forEach(b => b.classList.toggle('on', b.dataset.sort === sortMode));

  const sorted = [...filtered].sort((a, b) => compareDevices(a, b, sortMode, byIp));

  const existingByMac = new Map();
  const domOrder = [];
  const empties = [];
  for (const child of Array.from(list.children)) {
    const m = child.dataset.mac;
    if (m) {
      existingByMac.set(m, child);
      domOrder.push(m);
    } else {
      empties.push(child);
    }
  }
  for (const emp of empties) emp.remove();

  if (!sorted.length) {
    existingByMac.forEach(node => node.remove());
    list.appendChild(el('div', { class: 'c-muted', style: { padding: '14px', textAlign: 'center', fontSize: '11.5px' } }, '無匹配終端'));
    forceReorder = false;
    return;
  }

  const wantedMacs = new Set(sorted.map(d => d.mac));
  existingByMac.forEach((node, mac) => {
    if (!wantedMacs.has(mac)) node.remove();
  });

  // Freeze permutation while pointer hovers or user edits an alias so rows never shift mid-click
  const freezeOrder = !forceReorder && (pointerInsideDevList || !!editingMac) && domOrder.length > 0;
  let ordered = sorted;
  if (freezeOrder) {
    const byMac = new Map(sorted.map(d => [d.mac, d]));
    const kept = [];
    const seen = new Set();
    for (const m of domOrder) {
      if (byMac.has(m)) {
        kept.push(byMac.get(m));
        seen.add(m);
      }
    }
    for (const d of sorted) {
      if (!seen.has(d.mac)) kept.push(d);
    }
    ordered = kept;
  }

  ordered.forEach((d, idx) => {
    const dr = byIp[d.ip] || { down: 0, up: 0, count: 0 };
    let card = existingByMac.get(d.mac);
    if (!card) card = createDeviceCard(d.mac);
    syncDeviceCard(card, d, dr, S.selectedDeviceMac === d.mac);

    if (!freezeOrder || card.parentNode !== list) {
      const curAtIdx = list.children[idx];
      if (curAtIdx !== card) {
        list.insertBefore(card, curAtIdx || null);
      }
    }
  });
  forceReorder = false;
}

function renderConnections(devs, selectedDev, rows) {
  const scopeBadge = $('#conn-scope-badge');
  const clearBtn = $('#btn-conn-clear-dev');
  if (scopeBadge) {
    scopeBadge.textContent = selectedDev ? `${selectedDev.name || selectedDev.host || selectedDev.ip}` : '全局連接';
  }
  if (clearBtn) {
    clearBtn.style.display = selectedDev ? 'inline-flex' : 'none';
  }

  const empty = $('#conn-empty');
  const wrap = $('#conn-table-wrap');
  const ctb = $('#connections-tbody');
  if (!S.session) {
    lastConnRender = null;
    if (empty) {
      empty.textContent = '請點擊右上角「管理登入」查看實時連接流表';
      empty.style.display = 'block';
    }
    if (wrap) wrap.style.display = 'none';
    if ($('#conn-cap')) $('#conn-cap').textContent = '未認證';
    return;
  }

  const devNameByIp = {};
  let devsSig = '';
  for (const d of devs) {
    if (d.ip) {
      const label = d.name || d.host || d.ip;
      devNameByIp[d.ip] = label;
      devsSig += `${d.ip}=${label};`;
    }
  }

  const selIp = selectedDev?.ip || '';
  const curKey = { rows, selIp, route: S.connFilter.route, q: S.connFilter.q, devsSig };
  if (lastConnRender &&
      lastConnRender.rows === curKey.rows &&
      lastConnRender.selIp === curKey.selIp &&
      lastConnRender.route === curKey.route &&
      lastConnRender.q === curKey.q &&
      lastConnRender.devsSig === curKey.devsSig) {
    return;
  }
  lastConnRender = curKey;

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
  for (const f of filtered.slice(0, 140)) {
    let badgeClass = f.route === 'tunnel' ? 'cooling' : 'charged';
    let routeText = f.route === 'tunnel' ? `TW-HOME · ${f.via || 'proxy'}` : `直連 · ${f.via || 'wan'}`;
    if (f.vip) {
      badgeClass = 'vip';
      routeText = `VIP專線 · ${f.via || 'vip'}`;
    }

    frag.appendChild(el('tr', {},
      el('td', {}, el('div', { class: 'c-bright' }, devNameByIp[f.src] || f.src), el('div', { class: 'c-muted', style: { fontSize: '10.5px' } }, f.src)),
      el('td', { style: { maxWidth: '300px', wordBreak: 'break-all' } }, f.dst),
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
  const selectedDev = S.selectedDeviceMac !== 'all'
    ? devs.find(d => d.mac === S.selectedDeviceMac)
    : null;
  if (S.selectedDeviceMac !== 'all' && !selectedDev) {
    S.selectedDeviceMac = 'all';
  }
  const { byIp, rows } = computeFlowDeltas();
  renderDeviceMenu(devs, byIp, rows.length);
  renderConnections(devs, selectedDev, rows);
}
