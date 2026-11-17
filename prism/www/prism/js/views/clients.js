/* ============================================================================
 * PRISM — View 04: Merged Wide Device Policy Matrix & Live Flows Explorer
 * ============================================================================ */

import { S, desatObsidianRgb, opticalLoad, fmtRate, fmtRateCompact, fmtBytes } from '../state.js?v=5.6.6';
import { $, $$, el, setTxt, setCls, setTitle, setVar, setStyleProp } from '../dom.js?v=5.6.6';
import { write, openLoginModal } from '../api.js?v=5.6.6';

const POLICIES = ['auto', 'game', 'direct', 'tunnel', 'block'];
const POLICY_META = {
  auto:   { short: '自動', label: '自動分流',     rgb: '100, 174, 245' },
  game:   { short: '光道', label: '@vip_lane 極速光道', rgb: '100, 174, 245' },
  direct: { short: '直連', label: '強制直連',     rgb: '87, 209, 146' },
  tunnel: { short: '入籠', label: '強制歸入 TW-HOME', rgb: '170, 142, 240' },
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

function devEffectiveRates(d, flowByIp) {
  const f = (d?.ip && flowByIp[d.ip]) ? flowByIp[d.ip] : null;
  const down = Math.max(Number(d?.down) || 0, f?.down || 0);
  const up = Math.max(Number(d?.up) || 0, f?.up || 0);
  const count = f?.count || 0;
  return { down, up, count };
}

function compareDevices(a, b, mode, byIp) {
  if (mode === 'ip') {
    return compareStableTie(a, b);
  }
  if (a.online !== b.online) return a.online ? -1 : 1;
  if (mode === 'rate') {
    const ra = devEffectiveRates(a, byIp);
    const rb = devEffectiveRates(b, byIp);
    const ta = ra.down + ra.up;
    const tb = rb.down + rb.up;
    if (tb !== ta) return tb - ta;
  } else if (mode === 'flows') {
    const fa = byIp[a.ip]?.count || 0;
    const fb = byIp[b.ip]?.count || 0;
    if (fb !== fa) return fb - fa;
  }
  return compareStableTie(a, b);
}

let lastFlowSrc = null;
let lastFlowByteSig = '';
let lastFlowResult = { byIp: {}, rows: [] };
let lastConnRender = null;

function quickConnSig(conns) {
  const n = conns.length;
  if (!n) return '0';
  const a = conns[0];
  const b = conns[n - 1];
  return `${n}:${a.key || ''}:${a.down || 0}:${a.up || 0}:${b.key || ''}:${b.down || 0}:${b.up || 0}`;
}

function computeFlowDeltas() {
  if (!S.session || !S.connections) {
    lastFlowSrc = S.connections;
    lastFlowByteSig = '';
    lastFlowResult = { byIp: {}, rows: [] };
    return lastFlowResult;
  }
  const conns = S.connections.connections || [];
  const qSig = quickConnSig(conns);
  if (S.connections === lastFlowSrc && qSig === lastFlowByteSig)
    return lastFlowResult;

  const now = performance.now();
  const dt = S.flowSnapshotTs ? (now - S.flowSnapshotTs) / 1000 : 0;
  const nextSnap = {};
  const byIp = {};
  const rows = [];

  for (const f of conns) {
    const prev = S.flowSnapshot[f.key];
    let rDown = 0, rUp = 0;
    if (prev && dt > 0.35 && f.down >= prev.down && f.up >= prev.up) {
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
  lastFlowByteSig = qSig;
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

function createQuarantineCard(q, allDevs) {
  const hostTxt = q.host || q.mac.slice(-8);
  const topCand = q.candidates?.[0];
  const hint = topCand
    ? `疑似 ${topCand.alias || topCand.uid} (${topCand.score}分 · ${(topCand.reasons || []).join('+') || q.reason})`
    : `未通過交叉認證 (${q.reason || 'new_mac'})`;

  const sel = el('select', {
    class: 'bp-input',
    style: { fontSize: '10.5px', padding: '1px 4px', maxWidth: '112px' },
    title: '選擇要併入的現有設備組'
  });
  for (const d of allDevs) {
    if (!d.uid) continue;
    const opt = el('option', { value: d.uid }, d.name || d.host || d.mac.slice(-8));
    if (topCand && topCand.uid === d.uid) opt.selected = true;
    sel.appendChild(opt);
  }
  sel.addEventListener('click', (e) => e.stopPropagation());

  const btnNew = el('button', {
    type: 'button',
    class: 'policy-pill on tunnel',
    style: { padding: '2px 7px' },
    title: '認領並建立獨立 Zashboard 節點分組'
  }, '認領建組');
  btnNew.addEventListener('click', (e) => {
    e.stopPropagation();
    if (!S.session) { openLoginModal(); return; }
    write('claim', { mac: q.mac, action: 'new', alias: q.host || '' }, `已認領 ${hostTxt} 並建立專屬節點組`);
  });

  const btnMerge = el('button', {
    type: 'button',
    class: 'policy-pill on auto',
    style: { padding: '2px 7px' },
    title: '將此隨機/新 MAC 併入上方選中的現有設備'
  }, '併入');
  btnMerge.addEventListener('click', (e) => {
    e.stopPropagation();
    if (!S.session) { openLoginModal(); return; }
    const uid = sel.value;
    if (!uid) return;
    write('claim', { mac: q.mac, action: 'merge', target_uid: uid }, `已將 ${q.mac} 併入設備組 ${uid}`);
  });

  return el('div', {
    class: `dev-nav-item ${q.online ? 'online' : 'offline'}`,
    'data-qmac': q.mac,
    style: {
      '--dev-sc-rgb': '230, 108, 120',
      '--dev-rgb': '230, 108, 120',
      '--dev-fill': '0.13',
      '--dev-glow': '0.10'
    }
  },
    el('div', { class: 'dev-nav-top' },
      el('div', { class: 'dev-title-group' },
        el('span', { class: 'run-dot crimson' }),
        el('span', { class: 'dev-nav-name' }, `Mode A 攔截 · ${hostTxt}`)
      ),
      el('span', { class: 'c-crimson dev-flows-tag' }, '禁網待認領')
    ),
    el('div', { class: 'c-amber', style: { fontSize: '10.5px', lineHeight: '1.35' } }, `${q.mac}${q.ip ? ` · ${q.ip}` : ''} · ${hint}`),
    el('div', { class: 'dev-nav-sub', style: { justifyContent: 'flex-end', gap: '5px', flexWrap: 'wrap' } },
      btnNew,
      allDevs.some(d => d.uid) ? sel : null,
      allDevs.some(d => d.uid) ? btnMerge : null
    )
  );
}

function createDeviceCard(mac) {
  const dotEl = el('span', { class: 'run-dot' });
  const nameEl = el('span', { class: 'dev-nav-name' });
  const renameInput = el('input', {
    type: 'text',
    class: 'bp-input',
    style: { display: 'none', padding: '1px 6px', fontSize: '11.5px', width: '138px' },
    placeholder: '輸入終端別名...'
  });
  const renameBtn = el('button', {
    type: 'button',
    class: 'dev-rename-btn',
    title: '修改終端別名'
  }, '✎');

  const linkEl = el('span', { class: 'c-sec', style: { fontSize: '10.5px', flexShrink: '0' } });
  const flowsEl = el('span', { class: 'c-blue dev-flows-tag' });
  const ipRateEl = el('span', { class: 'c-muted', style: { fontSize: '10.5px', fontVariantNumeric: 'tabular-nums' } });

  const pillBtns = {};
  const pillBar = el('div', { class: 'policy-pill-bar' });
  for (const p of POLICIES) {
    const b = el('button', {
      type: 'button',
      class: `policy-pill ${p}`,
      'data-policy': p,
      title: p === 'tunnel' ? '強制全部流量經本設備 Zashboard 節點' : POLICY_META[p].label
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
      write('device', { mac: d.mac, name: d.name || '', policy: p }, `${d.name || d.mac} 分流律令已設為 ${POLICY_META[p].label}`);
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
  const label = d.name || d.host || d.mac.slice(-8);
  const policy = d.policy || 'auto';
  const totalBps = (dr?.down || 0) + (dr?.up || 0);
  const radio = d.signal ? ` ${d.signal}dBm` : '';
  const relayTag = d.relay ? ` · ${d.relay}` : '';
  const macCnt = (d.bound_macs?.length || 1) > 1 ? ` · ${d.bound_macs.length}MAC` : '';
  const linkTxt = `${d.link || 'wired'}${radio}`;
  const hasFlows = !!(S.session && dr.count > 0);
  const flowTxt = hasFlows ? `${dr.count} 流` : (d.online ? '在線' : '離線');
  const rateStr = totalBps > 50
    ? ` · ↓${fmtRateCompact(dr.down)} ↑${fmtRateCompact(dr.up)}`
    : relayTag;
  const ipRateTxt = `${d.ip || d.mac.slice(-8)}${rateStr}`;
  const editing = editingMac === d.mac;
  const sig = `${d.online ? 1 : 0}|${isSelected ? 1 : 0}|${policy}|${editing ? '' : label}|${linkTxt}|${flowTxt}|${ipRateTxt}|${d.group_name || ''}|${macCnt}|${Math.round(opticalLoad(totalBps, 6, 0.10) * 160)}`;
  if (card._renderSig === sig) return;
  card._renderSig = sig;

  const r = card._refs;
  const vis = deviceTileVisual(policy, !!d.online, totalBps);

  setCls(card, `dev-nav-item ${d.online ? 'online' : 'offline'} ${isSelected ? 'active' : ''}`);
  setVar(card, '--dev-sc-rgb', vis.scRgb);
  setVar(card, '--dev-rgb', vis.litRgb);
  setVar(card, '--dev-fill', vis.fill);
  setVar(card, '--dev-glow', vis.glow);
  setCls(r.dotEl, d.online ? 'run-dot mint' : 'run-dot off');

  if (!editing) {
    setTxt(r.nameEl, label);
    setTitle(r.nameEl, `${d.group_name || `${label} (${d.mac})`}${macCnt}${d.relay ? ` → ${d.relay}` : ''}`);
  }

  setTxt(r.linkEl, linkTxt);
  setCls(r.linkEl, d.online ? 'dev-meta-txt' : 'c-muted');
  setTxt(r.flowsEl, flowTxt);
  setCls(r.flowsEl, hasFlows ? 'c-blue dev-meta-strong dev-flows-tag' : (d.online ? 'c-mint dev-meta-strong dev-flows-tag' : 'c-muted dev-flows-tag'));

  setTxt(r.ipRateEl, ipRateTxt);
  setCls(r.ipRateEl, rateStr ? 'c-mint dev-meta-strong' : (d.online ? 'dev-meta-txt' : 'c-muted'));

  for (const p of POLICIES) {
    r.pillBtns[p].classList.toggle('on', p === policy);
  }
}

// Keyed in-place reconciliation: preserves DOM nodes & open inputs across 1s polls
function renderDeviceMenu(devs, quarantine, byIp, totalFlows) {
  const onlineCnt = devs.filter(d => d.online).length;
  const qCnt = (quarantine || []).length;
  setTxt('#clients-online-cnt', qCnt > 0 ? `${onlineCnt} 在線 / ${qCnt} 待認領` : `${onlineCnt} 在線 / ${devs.length} 台`);

  let flowDown = 0;
  let flowUp = 0;
  for (const ip of Object.keys(byIp)) {
    flowDown += byIp[ip].down;
    flowUp += byIp[ip].up;
  }
  let kernDown = 0;
  let kernUp = 0;
  for (const d of devs) {
    kernDown += Number(d.down) || 0;
    kernUp += Number(d.up) || 0;
  }
  const totDown = Math.max(kernDown, flowDown);
  const totUp = Math.max(kernUp, flowUp);
  setTxt('#dev-all-rate', fmtRate(totDown).full);
  setTxt('#dev-all-flows', S.session ? `${totalFlows} 條活躍流` : `${onlineCnt} 台在線`);

  const navAll = $('#dev-nav-all');
  if (navAll) {
    const wantAll = S.selectedDeviceMac === 'all';
    if (navAll.classList.contains('active') !== wantAll) navAll.classList.toggle('active', wantAll);
    const allVis = deviceTileVisual('game', onlineCnt > 0 || devs.length > 0, totDown + totUp);
    setVar(navAll, '--dev-sc-rgb', allVis.scRgb);
    setVar(navAll, '--dev-rgb', allVis.litRgb);
    setVar(navAll, '--dev-fill', allVis.fill);
    setVar(navAll, '--dev-glow', allVis.glow);
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
  $$('#dev-sort-seg .seg-btn').forEach(b => {
    const want = b.dataset.sort === sortMode;
    if (b.classList.contains('on') !== want) b.classList.toggle('on', want);
  });

  const sorted = [...filtered].sort((a, b) => compareDevices(a, b, sortMode, byIp));

  const existingByMac = new Map();
  const domOrder = [];
  const empties = [];
  const qCards = [];
  for (const child of Array.from(list.children)) {
    const m = child.dataset.mac;
    const qm = child.dataset.qmac;
    if (m) {
      existingByMac.set(m, child);
      domOrder.push(m);
    } else if (qm) {
      qCards.push(child);
    } else {
      empties.push(child);
    }
  }
  for (const emp of empties) emp.remove();

  const qSig = (quarantine || []).map(q => `${q.mac}:${q.ip}:${q.host}:${q.score}:${q.online}:${devs.length}`).join('|');
  if (list._qSig !== qSig) {
    list._qSig = qSig;
    for (const qc of qCards) qc.remove();
    const frag = document.createDocumentFragment();
    for (const q of (quarantine || []))
      frag.appendChild(createQuarantineCard(q, devs));
    if (frag.childNodes.length)
      list.insertBefore(frag, list.firstChild);
  }
  const qOffset = (quarantine || []).length;

  if (!sorted.length && !qOffset) {
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
    const dr = devEffectiveRates(d, byIp);
    let card = existingByMac.get(d.mac);
    if (!card) card = createDeviceCard(d.mac);
    syncDeviceCard(card, d, dr, S.selectedDeviceMac === d.mac);

    if (!freezeOrder || card.parentNode !== list) {
      const curAtIdx = list.children[qOffset + idx];
      if (curAtIdx !== card) {
        list.insertBefore(card, curAtIdx || null);
      }
    }
  });
  forceReorder = false;
}

function renderConnections(devs, selectedDev, rows) {
  setTxt('#conn-scope-badge', selectedDev ? `${selectedDev.name || selectedDev.host || selectedDev.ip}` : '全局連接');
  setStyleProp($('#btn-conn-clear-dev'), 'display', selectedDev ? 'inline-flex' : 'none');

  const empty = $('#conn-empty');
  const wrap = $('#conn-table-wrap');
  const ctb = $('#connections-tbody');
  if (!S.session) {
    lastConnRender = null;
    if (empty) {
      setTxt(empty, '請點擊右上角「管理登入」查看實時連接流表');
      setStyleProp(empty, 'display', 'block');
    }
    setStyleProp(wrap, 'display', 'none');
    setTxt('#conn-cap', '未認證');
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

  if (!ctb) return;
  const rowsByKey = ctb._rowsByKey || (ctb._rowsByKey = new Map());
  const top = filtered.slice(0, 140);
  const seenKeys = new Set();
  const orderedRows = [];

  for (let i = 0; i < top.length; i++) {
    const f = top[i];
    let key = f.key || `${f.src}|${f.dst}|${f.port}|${f.proto}`;
    if (seenKeys.has(key)) key = `${key}#${i}`;
    seenKeys.add(key);

    let badgeClass = f.route === 'tunnel' ? 'cooling' : 'charged';
    let routeText = f.route === 'tunnel' ? `TW-HOME · ${f.via || 'proxy'}` : `直連 · ${f.via || 'wan'}`;
    if (f.vip) {
      badgeClass = 'vip';
      routeText = `光道 · ${f.via || 'vip'}`;
    }

    const hostTxt = devNameByIp[f.src] || f.src;
    const srcTxt = f.src;
    const dstTxt = f.dst;
    const portTxt = `${f.port} / ${String(f.proto || '').toUpperCase()}`;
    const downTxt = f.rDown > 50 ? fmtRate(f.rDown).full : '—';
    const upTxt = f.rUp > 50 ? fmtRate(f.rUp).full : '—';
    const bytesTxt = fmtBytes((f.down || 0) + (f.up || 0));

    let tr = rowsByKey.get(key);
    if (!tr) {
      const hostEl = el('div', { class: 'c-bright', style: { overflow: 'hidden', textOverflow: 'ellipsis' } }, hostTxt);
      const srcEl = el('div', { class: 'c-muted', style: { fontSize: '10.5px' } }, srcTxt);
      const dstCell = el('td', { title: dstTxt }, dstTxt);
      const portCell = el('td', { class: 'c-sec' }, portTxt);
      const badgeEl = el('span', { class: `st-badge ${badgeClass}` }, routeText);
      const downCell = el('td', { class: 'num c-mint' }, downTxt);
      const upCell = el('td', { class: 'num c-blue' }, upTxt);
      const bytesCell = el('td', { class: 'num c-sec' }, bytesTxt);
      tr = el('tr', {},
        el('td', {}, hostEl, srcEl),
        dstCell,
        portCell,
        el('td', {}, badgeEl),
        downCell,
        upCell,
        bytesCell
      );
      tr._ui = { hostEl, srcEl, dstCell, portCell, badgeEl, downCell, upCell, bytesCell };
      rowsByKey.set(key, tr);
    } else {
      const u = tr._ui;
      if (u.hostEl.textContent !== hostTxt) u.hostEl.textContent = hostTxt;
      if (u.srcEl.textContent !== srcTxt) u.srcEl.textContent = srcTxt;
      if (u.dstCell.textContent !== dstTxt) {
        u.dstCell.textContent = dstTxt;
        u.dstCell.title = dstTxt;
      }
      if (u.portCell.textContent !== portTxt) u.portCell.textContent = portTxt;
      const bCls = `st-badge ${badgeClass}`;
      if (u.badgeEl.className !== bCls) u.badgeEl.className = bCls;
      if (u.badgeEl.textContent !== routeText) u.badgeEl.textContent = routeText;
      if (u.downCell.textContent !== downTxt) u.downCell.textContent = downTxt;
      if (u.upCell.textContent !== upTxt) u.upCell.textContent = upTxt;
      if (u.bytesCell.textContent !== bytesTxt) u.bytesCell.textContent = bytesTxt;
    }
    orderedRows.push(tr);
  }

  for (const [k, row] of rowsByKey.entries()) {
    if (!seenKeys.has(k)) {
      row.remove();
      rowsByKey.delete(k);
    }
  }
  for (let i = 0; i < orderedRows.length; i++) {
    const tr = orderedRows[i];
    if (ctb.children[i] !== tr) {
      ctb.insertBefore(tr, ctb.children[i] || null);
    }
  }
}

export function renderClients() {
  const devs = S.devices?.devices || [];
  const quarantine = S.devices?.quarantine || [];
  const selectedDev = S.selectedDeviceMac !== 'all'
    ? devs.find(d => d.mac === S.selectedDeviceMac)
    : null;
  if (S.selectedDeviceMac !== 'all' && !selectedDev) {
    S.selectedDeviceMac = 'all';
  }
  const { byIp, rows } = computeFlowDeltas();
  renderDeviceMenu(devs, quarantine, byIp, rows.length);
  renderConnections(devs, selectedDev, rows);
}
