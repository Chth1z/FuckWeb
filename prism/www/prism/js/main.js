/* ============================================================================
 * PRISM 5.0 — Bootstrap, 4-Tab Router & Differential Polling Engine
 * ============================================================================ */

import { S, UI_VERSION, fmtRate, fmtClock } from './state.js?v=5.9.1';
import { $, $$, toast, setTxt, setCls, setTitle } from './dom.js?v=5.9.1';
import { callBatch, call, write, clearSession, openLoginModal, closeLoginModal, submitLogin, updateAuthButton, setAuthCallback } from './api.js?v=5.9.1';
import { initPrismCanvas, markPrismDirty, renderPrismNow } from './canvas/prism.js?v=5.9.1';
import { renderOverview } from './views/overview.js?v=5.9.1';
import { renderBlueprint, bindBlueprintEvents, startBlueprintAnim, stopBlueprintAnim } from './views/blueprint.js?v=5.9.1';
import { renderSpectrum, bindSpectrumEvents, startSpectrumAnim, stopSpectrumAnim } from './views/spectrum.js?v=5.9.1';
import { renderClients, bindClientsEvents } from './views/clients.js?v=5.9.1';

let fastTimer = null;
let slowTimer = null;
let fastSeq = 0;
let fastInFlight = false;
let slowInFlight = false;
let connInFlight = false;
let pendingFast = false;
let pendingSlow = false;
let pendingConn = false;
let connWarmupTimer = null;
let lastFastTab = '';
let booted = false;

const STALE_AFTER_SEC = 8;
const OFFLINE_AFTER_SEC = 20;

function computeHeartbeat() {
  const hb = S.heartbeat;
  const now = Date.now();
  const ageSec = hb.lastOkAt > 0 ? Math.max(0, Math.floor((now - hb.lastOkAt) / 1000)) : 0;
  const st = S.status;
  const dmSampled = st?.daemon?.sampled_ts || 0;
  const backendLagSec = (st?.ts && dmSampled) ? Math.max(0, st.ts - dmSampled) : 0;

  let state = 'live';
  if (hb.failCount >= 6 || (booted && hb.lastOkAt > 0 && ageSec >= OFFLINE_AFTER_SEC)) {
    state = 'offline';
  } else if (hb.failCount >= 3 || (booted && hb.lastOkAt > 0 && ageSec >= STALE_AFTER_SEC) || backendLagSec >= 15) {
    state = 'stale';
  }
  hb.state = state;
  return { state, ageSec, backendLagSec, failCount: hb.failCount, lastError: hb.lastError };
}

function renderHeartbeat() {
  const info = computeHeartbeat();
  const st = S.status;
  const dot = $('#link-dot');
  const ft = $('#ft-link');
  const pill = $('#health-pill');

  if (dot) {
    setCls(dot, info.state === 'live' ? 'pulse-dot-live' : `pulse-dot-live ${info.state}`);
  }
  if (ft) {
    if (info.state === 'offline') {
      setTxt(ft, `offline · ${info.ageSec}s`);
      setCls(ft, 'ft-link c-crimson t-strong');
      setTitle(ft, `路由器心跳中斷 ${info.ageSec}s（連續失敗 ${info.failCount} 次${info.lastError ? ' · ' + info.lastError : ''}）`);
    } else if (info.state === 'stale') {
      const lag = info.backendLagSec >= 15 && info.ageSec < STALE_AFTER_SEC ? `daemon ${info.backendLagSec}s` : `${info.ageSec}s`;
      setTxt(ft, `stale · ${lag}`);
      setCls(ft, 'ft-link c-amber t-strong');
      setTitle(ft, `心跳逾時 ${lag}（連續失敗 ${info.failCount} 次 · 上次同步 ${fmtClock(Math.floor(S.heartbeat.lastOkAt / 1000))}）`);
    } else {
      setTxt(ft, 'live');
      setCls(ft, 'ft-link c-mint');
      const recMs = st?.daemon?.reconcile_ms;
      setTitle(ft, `路由器心跳正常 · 上次同步 ${S.heartbeat.lastOkAt ? fmtClock(Math.floor(S.heartbeat.lastOkAt / 1000)) : '—'}${recMs != null ? ` · reconcile ${recMs}ms` : ''}`);
    }
  }

  if (pill) {
    if (info.state === 'offline') {
      setTxt(pill, `LINK · OFFLINE ${info.ageSec}s`);
      setCls(pill, 'st-badge depleted clickable');
      setTitle(pill, `無法連線路由器（${info.ageSec}s 未回應 · 失敗 ${info.failCount} 次），點擊前往折射頁`);
    } else if (info.state === 'stale') {
      const lag = info.backendLagSec >= 15 && info.ageSec < STALE_AFTER_SEC ? `${info.backendLagSec}s` : `${info.ageSec}s`;
      setTxt(pill, `LINK · STALE ${lag}`);
      setCls(pill, 'st-badge draining clickable');
      setTitle(pill, `心跳延遲 ${lag}，數據可能已過期`);
    } else if (st) {
      const ok = st.ok;
      const warn = (st.warn || []).length;
      setTxt(pill, ok
        ? (warn > 0 ? `DOCTOR · OK (${warn} WARN)` : 'DOCTOR · ALL OK')
        : `DOCTOR · ${st.fail?.length || 1} FAIL`);
      setCls(pill, 'st-badge ' + (ok ? (warn > 0 ? 'draining' : 'charged') : 'depleted') + ' clickable');
      setTitle(pill, '查看折射與體檢');
    }
  }
}

function noteHeartbeatOk(st) {
  const hb = S.heartbeat;
  const wasDegraded = hb.state !== 'live';
  hb.lastOkAt = Date.now();
  hb.failCount = 0;
  hb.serverTs = st?.ts || 0;
  hb.lastError = '';
  if (wasDegraded) {
    hb.state = 'live';
    toast('路由器心跳已恢復');
    pollSlow(true);
  }
}

function noteHeartbeatFail(err) {
  const hb = S.heartbeat;
  hb.failCount++;
  hb.lastError = err?.message || 'network error';
  renderHeartbeat();
}

function renderChrome() {
  renderHeartbeat();
  const st = S.status;
  if (!st) return;

  const ver = st.version || UI_VERSION;
  setTxt('#hdr-ip', st.lan_ip || location.hostname);
  setTxt('#hdr-ver', `v${ver}`);
  setTxt('#ov-ver', `PRISM v${ver} · DISPERSION FLUX`);
  setTxt('#modal-ver', `PRISM v${ver} · 系統管理認證`);
  const nextTitle = `PRISM v${ver} · Optical Spectrum & Privacy Router`;
  if (document.title !== nextTitle) document.title = nextTitle;

  setTxt('#n-strands', st.strand_count || (st.strands || []).length || 21);
  const devs = S.devices?.devices || [];
  setTxt('#n-devices', devs.filter(d => d.online).length);

  setTxt('#site-badge', st.site?.known
    ? `SITE · ${st.site.name}`
    : (st.site?.aggregate ? 'SITE · AGGREGATE' : 'SITE · SINGLE'));

  // Persistent CLI Footer
  const w = st.weave || {};
  const tun = S.tunnel;
  const vipS = (st.strands || []).find(s => s.vip);
  setTxt('#cli-policy', w.policy || 'harvest');
  setTxt('#cli-cage', (tun?.selected || tun?.tw_home || (st.tunnel?.on ? '活躍' : '直連')).slice(0, 22));
  setTxt('#cli-vip', w.vip_dev || 'auto');

  setTxt('#ft-strands', `[${st.healthy_count ?? 0}/${st.strand_count ?? 21}]`);
  setTxt('#ft-vip', vipS ? `[${vipS.dev} · ${vipS.ttfb_ms}ms]` : '[—]');
  const ftTunTxt = !st.tunnel?.on ? 'direct' : (!st.tunnel?.running ? 'down!' : (tun?.selected || tun?.tw_home || 'cage').slice(0, 18));
  setTxt('#ft-tunnel', `[${ftTunTxt}]`);
  setTxt('#ft-guard', st.tunnel?.fail_open ? '[fail_open]' : '[fail_closed]');
  setTxt('#ft-down', `↓ ${fmtRate(st.rate).full}`);
}

function renderActiveTab() {
  renderChrome();
  if (S.tab === 'overview') renderOverview();
  else if (S.tab === 'blueprint') renderBlueprint();
  else if (S.tab === 'spectrum') renderSpectrum();
  else if (S.tab === 'clients') renderClients();
}

export function switchTab(tab, updateHash = true, refresh = true) {
  const valid = ['overview', 'spectrum', 'blueprint', 'clients'];
  if (!valid.includes(tab)) tab = 'overview';
  S.tab = tab;

  $$('.nav-tab').forEach(btn => btn.classList.toggle('active', btn.dataset.tab === tab));
  $$('.page').forEach(pg => pg.classList.toggle('active', pg.id === `page-${tab}`));

  if (updateHash && location.hash !== `#${tab}`) {
    history.replaceState(null, '', `#${tab}`);
  }

  renderActiveTab();
  if (refresh) {
    pollFast(true);
    if (tab === 'clients' && S.session) pollConnections(true);
    pollSlow(tab === 'blueprint' || tab === 'spectrum');
  }
  if (tab === 'overview') {
    renderPrismNow();
    markPrismDirty();
  }
  if (tab === 'blueprint') startBlueprintAnim();
  else stopBlueprintAnim();
  if (tab === 'spectrum') startSpectrumAnim();
  else stopSpectrumAnim();
}

function mergeSeriesDelta(delta) {
  if (!delta || !Array.isArray(delta.ts) || delta.ts.length === 0) return;
  const cur = S.series;
  if (!cur || !Array.isArray(cur.ts) || cur.ts.length < 2 || delta.ts.length > 60) {
    S.series = delta;
    return;
  }
  const lastTs = cur.ts[cur.ts.length - 1] || 0;
  const startIdx = delta.ts.findIndex(t => t > lastTs);
  if (startIdx < 0) return;
  const addCount = delta.ts.length - startIdx;
  cur.ts.push(...delta.ts.slice(startIdx));
  cur.total.push(...(delta.total || []).slice(startIdx));
  if (!cur.up) cur.up = new Array(cur.ts.length - addCount).fill(0);
  cur.up.push(...(delta.up || new Array(addCount).fill(0)).slice(startIdx));
  const mergeMap = (dstMap, srcMap) => {
    if (!srcMap) return;
    const targetLen = cur.ts.length;
    for (const [dev, arr] of Object.entries(srcMap)) {
      let dst = dstMap[dev];
      if (!dst) dst = dstMap[dev] = new Array(targetLen - addCount).fill(0);
      dst.push(...arr.slice(startIdx));
      if (dst.length > 720) dst.splice(0, dst.length - 720);
    }
    for (const dst of Object.values(dstMap)) {
      while (dst.length < targetLen) dst.push(0);
      if (dst.length > 720) dst.splice(0, dst.length - 720);
    }
  };
  mergeMap(cur.strands || (cur.strands = {}), delta.strands);
  mergeMap(cur.strands_up || (cur.strands_up = {}), delta.strands_up);
  if (cur.ts.length > 720) {
    const drop = cur.ts.length - 720;
    cur.ts.splice(0, drop);
    cur.total.splice(0, drop);
    cur.up.splice(0, drop);
  }
}

async function pollConnections(force = false, allowWarmup = true) {
  if (document.visibilityState === 'hidden' || S.tab !== 'clients' || !S.session) return;
  if (connInFlight) {
    if (force) pendingConn = true;
    return;
  }
  connInFlight = true;
  try {
    const cn = await call('connections');
    if (cn) {
      S.connections = cn;
      if (S.tab === 'clients') renderClients();
      // Cold/stale direct conntrack read triggers a ~140ms background task in prismd;
      // follow up once shortly after so fresh kernel flows render without waiting 4s.
      const dirTs = cn.sampled?.direct || 0;
      const tunTs = cn.sampled?.tunnel || 0;
      if (allowWarmup && (!dirTs || (tunTs > 0 && tunTs - dirTs > 5)) && !connWarmupTimer) {
        connWarmupTimer = setTimeout(() => {
          connWarmupTimer = null;
          pollConnections(false, false);
        }, 260);
      }
    }
  } catch (_) {
  } finally {
    connInFlight = false;
    if (pendingConn) {
      pendingConn = false;
      pollConnections(false, allowWarmup);
    }
  }
}

async function pollFast(force = false) {
  if (document.visibilityState === 'hidden') return;
  if (fastInFlight) {
    if (force) pendingFast = true;
    return;
  }
  fastInFlight = true;
  const seq = ++fastSeq;
  const tabChanged = (lastFastTab !== S.tab);
  lastFastTab = S.tab;
  const runHeavy = tabChanged || force || (seq === 1 || seq % 2 === 0);
  try {
    const needFullSeries = S.tab === 'spectrum' && (!S.series?.ts || S.series.ts.length < 2);
    const jobs = [
      { method: 'status' },
      S.tab === 'overview' || S.tab === 'clients' ? { method: 'devices' } : null,
      S.tab === 'spectrum' ? { method: 'series', args: { limit: needFullSeries ? 720 : 8 } } : null,
      runHeavy && S.tab === 'blueprint' ? { method: 'rules' } : null
    ];

    const [st, dv, ser, rl] = await callBatch(jobs);
    if (st) {
      S.status = st;
      noteHeartbeatOk(st);
    } else {
      noteHeartbeatFail(new Error('empty status'));
    }
    if (dv) S.devices = dv;
    if (ser) mergeSeriesDelta(ser);
    if (rl) S.rules = rl;
    renderActiveTab();
    if (st) saveBootSnapshot();
  } catch (e) {
    noteHeartbeatFail(e);
  } finally {
    fastInFlight = false;
    if (pendingFast) {
      pendingFast = false;
      pollFast(false);
    }
  }
}

async function pollSlow(force = false) {
  if (document.visibilityState === 'hidden') return;
  if (slowInFlight) {
    if (force) pendingSlow = true;
    return;
  }
  slowInFlight = true;
  try {
    const reqs = [
      { method: 'tunnel' },
      S.tab === 'blueprint' ? { method: 'events', args: { limit: 80 } } : null,
      S.tab === 'blueprint' ? { method: 'doctor' } : null,
      S.tab === 'blueprint' ? { method: 'diagnostics' } : null,
      S.tab === 'blueprint' && S.session ? { method: 'config' } : null,
      S.tab !== 'overview' && S.tab !== 'clients' ? { method: 'devices' } : null
    ];

    const [tun, ev, doc, diag, cfg, dv] = await callBatch(reqs);
    if (tun) S.tunnel = tun;
    if (ev) S.events = ev;
    if (doc) S.doctor = doc;
    if (diag) S.diagnostics = diag;
    if (cfg) S.config = cfg;
    if (dv) S.devices = dv;
    renderActiveTab();
    saveBootSnapshot();
  } catch (_) {
  } finally {
    slowInFlight = false;
    if (pendingSlow) {
      pendingSlow = false;
      pollSlow(false);
    }
  }
}

function bindGlobalEvents() {
  $$('.nav-tab').forEach(btn => {
    btn.addEventListener('click', () => switchTab(btn.dataset.tab));
  });

  const healthPill = $('#health-pill');
  healthPill?.addEventListener('click', () => switchTab('blueprint'));
  healthPill?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      switchTab('blueprint');
    }
  });

  $('#btn-auth')?.addEventListener('click', () => {
    if (S.session) {
      clearSession();
      S.connections = null;
      S.config = null;
      toast('已退出管理會話');
      renderActiveTab();
    } else {
      openLoginModal();
    }
  });

  $('#login-form')?.addEventListener('submit', submitLogin);
  $('#login-cancel')?.addEventListener('click', closeLoginModal);
  $('#scrim')?.addEventListener('click', (e) => {
    if (e.target.id === 'scrim') closeLoginModal();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closeLoginModal();
  });

  $('#btn-reconcile')?.addEventListener('click', () => write('reconcile', {}, '已觸發即時調諧'));
  $('#btn-relogin')?.addEventListener('click', () => write('relogin', {}, '已派發全線路 Portal 重登'));

  window.addEventListener('hashchange', () => {
    const h = location.hash.replace('#', '');
    if (h) switchTab(h, false);
  });

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') {
      if (S.heartbeat.state === 'live' && S.heartbeat.lastOkAt > 0) {
        S.heartbeat.lastOkAt = Date.now();
      }
      pollFast(true);
      if (S.tab === 'clients' && S.session) pollConnections(true);
      pollSlow(true);
      if (S.tab === 'overview') markPrismDirty();
      if (S.tab === 'blueprint') startBlueprintAnim();
      if (S.tab === 'spectrum') startSpectrumAnim();
    } else {
      stopBlueprintAnim();
      stopSpectrumAnim();
    }
  });

  setAuthCallback(() => {
    pollFast(true);
    if (S.tab === 'clients' && S.session) pollConnections(true);
    pollSlow(true);
  });
}

const SNAPSHOT_KEY = 'prism_snap_v1';
let lastSnapSavedAt = 0;

function trimSeriesForSnap(ser) {
  if (!ser || !Array.isArray(ser.ts) || ser.ts.length < 2) return null;
  const maxKeep = 240;
  const start = Math.max(0, ser.ts.length - maxKeep);
  const sliceMap = (m) => {
    if (!m) return undefined;
    const out = {};
    for (const [k, v] of Object.entries(m)) {
      if (Array.isArray(v)) out[k] = v.slice(start);
    }
    return out;
  };
  return {
    ts: ser.ts.slice(start),
    total: (ser.total || []).slice(start),
    up: (ser.up || []).slice(start),
    strands: sliceMap(ser.strands),
    strands_up: sliceMap(ser.strands_up)
  };
}

function saveBootSnapshot(force = false) {
  if (typeof sessionStorage === 'undefined' || !S.status) return;
  const now = Date.now();
  if (!force && (now - lastSnapSavedAt) < 900) return;
  lastSnapSavedAt = now;
  try {
    sessionStorage.setItem(SNAPSHOT_KEY, JSON.stringify({
      savedAt: now,
      status: S.status,
      devices: S.devices,
      tunnel: S.tunnel,
      rules: S.rules,
      events: S.events,
      doctor: S.doctor,
      series: trimSeriesForSnap(S.series)
    }));
  } catch (_) {}
}

function loadBootSnapshot() {
  if (typeof sessionStorage === 'undefined') return false;
  try {
    const raw = sessionStorage.getItem(SNAPSHOT_KEY);
    if (!raw) return false;
    const snap = JSON.parse(raw);
    if (!snap || !snap.status || (Date.now() - (snap.savedAt || 0)) > 180000) return false;
    S.status = snap.status;
    if (snap.devices) S.devices = snap.devices;
    if (snap.tunnel) S.tunnel = snap.tunnel;
    if (snap.rules) S.rules = snap.rules;
    if (snap.events) S.events = snap.events;
    if (snap.doctor) S.doctor = snap.doctor;
    if (snap.series) mergeSeriesDelta(snap.series);
    return true;
  } catch (_) {
    return false;
  }
}

function releaseBootClasses() {
  const root = document.documentElement;
  if (!root) return;
  root.classList.remove('prism-cold');
  if (typeof requestAnimationFrame === 'function') {
    requestAnimationFrame(() => requestAnimationFrame(() => root.classList.remove('prism-booting')));
  } else {
    root.classList.remove('prism-booting');
  }
}

async function init() {
  updateAuthButton();
  bindGlobalEvents();
  bindBlueprintEvents();
  bindSpectrumEvents();
  bindClientsEvents();
  initPrismCanvas();

  const hasWarmSnap = loadBootSnapshot();
  const initialTab = (location.hash || '#overview').replace('#', '');
  switchTab(initialTab, false, false);
  if (hasWarmSnap) {
    releaseBootClasses();
  }

  if (typeof window !== 'undefined' && window.addEventListener) {
    window.addEventListener('pagehide', () => saveBootSnapshot(true));
  }

  if (S.tab === 'clients' && S.session) pollConnections(true);

  try {
    const [st, dv, tun, ser, rul, ev, doc, diag, cfg] = await callBatch([
      { method: 'status' },
      { method: 'devices' },
      { method: 'tunnel' },
      S.tab === 'spectrum' ? { method: 'series', args: { limit: 720 } } : null,
      { method: 'rules' },
      { method: 'events', args: { limit: 80 } },
      { method: 'doctor' },
      S.tab === 'blueprint' ? { method: 'diagnostics' } : null,
      S.tab === 'blueprint' && S.session ? { method: 'config' } : null
    ]);
    if (st) {
      S.status = st;
      noteHeartbeatOk(st);
    }
    if (dv) S.devices = dv;
    if (tun) S.tunnel = tun;
    if (ser) mergeSeriesDelta(ser);
    if (rul) S.rules = rul;
    if (ev) S.events = ev;
    if (doc) S.doctor = doc;
    if (diag) S.diagnostics = diag;
    if (cfg) S.config = cfg;
    booted = true;
    renderActiveTab();
    if (S.tab === 'overview') renderPrismNow();
    saveBootSnapshot(true);
  } catch (e) {
    booted = true;
    noteHeartbeatFail(e);
  } finally {
    releaseBootClasses();
  }

  // Silently preload series once after initial reveal so switching to Spectrum is instant
  if (!S.series?.ts || S.series.ts.length < 2) {
    setTimeout(async () => {
      try {
        const [ser] = await callBatch([{ method: 'series', args: { limit: 720 } }]);
        if (ser) {
          mergeSeriesDelta(ser);
          saveBootSnapshot(true);
          if (S.tab === 'spectrum') renderSpectrum();
        }
      } catch (_) {}
    }, 240);
  }

  fastTimer = setInterval(() => {
    renderHeartbeat();
    pollFast();
  }, 1000);
  slowTimer = setInterval(() => {
    pollSlow();
    if (S.tab === 'clients' && S.session) pollConnections();
  }, 4000);
}

init();
