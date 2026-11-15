/* ============================================================================
 * PRISM 5.0 — Bootstrap, 4-Tab Router & Differential Polling Engine
 * ============================================================================ */

import { S, UI_VERSION, fmtRate } from './state.js?v=5.3.0';
import { $, $$, toast } from './dom.js?v=5.3.0';
import { call, write, clearSession, openLoginModal, closeLoginModal, submitLogin, updateAuthButton, setAuthCallback } from './api.js?v=5.3.0';
import { initPrismCanvas, markPrismDirty } from './canvas/prism.js?v=5.3.0';
import { renderOverview } from './views/overview.js?v=5.3.0';
import { renderBlueprint, bindBlueprintEvents, startBlueprintAnim, stopBlueprintAnim } from './views/blueprint.js?v=5.3.0';
import { renderSpectrum, bindSpectrumEvents } from './views/spectrum.js?v=5.3.0';
import { renderClients, bindClientsEvents } from './views/clients.js?v=5.3.0';

let fastTimer = null;
let slowTimer = null;

function renderChrome() {
  const st = S.status;
  if (!st) return;

  const ver = st.version || UI_VERSION;
  $('#hdr-ip').textContent = st.lan_ip || location.hostname;
  $('#hdr-ver').textContent = `v${ver}`;
  if ($('#ov-ver')) $('#ov-ver').textContent = `PRISM v${ver} · DISPERSION FLUX`;
  if ($('#modal-ver')) $('#modal-ver').textContent = `PRISM v${ver} · 路由器管理驗證`;
  document.title = `PRISM v${ver} · Optical Spectrum & Privacy Router`;

  $('#n-strands').textContent = st.strand_count || (st.strands || []).length || 21;
  const devs = S.devices?.devices || [];
  $('#n-devices').textContent = devs.filter(d => d.online).length;

  $('#site-badge').textContent = st.site?.known
    ? `SITE · ${st.site.name}`
    : (st.site?.aggregate ? 'SITE · AGGREGATE' : 'SITE · SINGLE');

  const pill = $('#health-pill');
  if (pill) {
    const ok = st.ok;
    const warn = (st.warn || []).length;
    pill.textContent = ok
      ? (warn > 0 ? `DOCTOR · OK (${warn} WARN)` : 'DOCTOR · ALL OK')
      : `DOCTOR · ${st.fail?.length || 1} FAIL`;
    pill.className = 'st-badge ' + (ok ? (warn > 0 ? 'draining' : 'charged') : 'depleted');
  }

  // Persistent CLI Footer
  const w = st.weave || {};
  const tun = S.tunnel;
  const vipS = (st.strands || []).find(s => s.vip);
  $('#cli-policy').textContent = w.policy || 'harvest';
  $('#cli-cage').textContent = (tun?.tw_home || tun?.selected || 'tw-home').slice(0, 22);
  $('#cli-vip').textContent = w.vip_dev || 'auto';

  $('#ft-strands').textContent = `[${st.healthy_count ?? 0}/${st.strand_count ?? 21}]`;
  $('#ft-vip').textContent = vipS ? `[${vipS.dev} · ${vipS.ttfb_ms}ms]` : '[—]';
  $('#ft-tunnel').textContent = `[${st.tunnel?.on ? 'tw-home' : 'direct'}]`;
  $('#ft-guard').textContent = st.tunnel?.fail_open ? '[fail_open]' : '[fail_closed]';
  $('#ft-down').textContent = fmtRate(st.rate).full;
}

function renderActiveTab() {
  renderChrome();
  if (S.tab === 'overview') renderOverview();
  else if (S.tab === 'blueprint') renderBlueprint();
  else if (S.tab === 'spectrum') renderSpectrum();
  else if (S.tab === 'clients') renderClients();
}

export function switchTab(tab, updateHash = true) {
  const valid = ['overview', 'blueprint', 'spectrum', 'clients'];
  if (!valid.includes(tab)) tab = 'overview';
  S.tab = tab;

  $$('.nav-tab').forEach(btn => btn.classList.toggle('active', btn.dataset.tab === tab));
  $$('.page').forEach(pg => pg.classList.toggle('active', pg.id === `page-${tab}`));

  if (updateHash && location.hash !== `#${tab}`) {
    history.replaceState(null, '', `#${tab}`);
  }

  renderActiveTab();
  pollFast();
  pollSlow();
  if (tab === 'overview') markPrismDirty();
  if (tab === 'blueprint') startBlueprintAnim();
  else stopBlueprintAnim();
}

async function pollFast() {
  if (document.visibilityState === 'hidden') return;
  try {
    const jobs = [
      call('status'),
      S.tab === 'overview' || S.tab === 'clients' ? call('devices') : null,
      S.tab === 'clients' && S.session ? call('connections') : null,
      S.tab === 'blueprint' ? call('rules') : null
    ];

    const [st, dv, cn, rl] = await Promise.all(jobs);
    if (st) S.status = st;
    if (dv) S.devices = dv;
    if (cn) S.connections = cn;
    if (rl) S.rules = rl;
    renderActiveTab();
  } catch (e) {
    // Keep last snapshot cleanly without UI glitch
  }
}

async function pollSlow() {
  if (document.visibilityState === 'hidden') return;
  try {
    const reqs = [];
    reqs.push(S.tab === 'overview' || S.tab === 'blueprint' ? call('tunnel') : null);
    reqs.push(S.tab === 'blueprint' ? call('rules') : null);
    reqs.push(S.tab === 'blueprint' ? call('events', { limit: 40 }) : null);
    reqs.push(S.tab === 'blueprint' ? call('doctor') : null);
    reqs.push(S.tab === 'spectrum' ? call('series', { limit: 720 }) : null);
    reqs.push(S.tab === 'blueprint' && S.session ? call('config') : null);

    const [tun, rul, ev, doc, ser, cfg] = await Promise.all(reqs);
    if (tun) S.tunnel = tun;
    if (rul) S.rules = rul;
    if (ev) S.events = ev;
    if (doc) S.doctor = doc;
    if (ser) S.series = ser;
    if (cfg) S.config = cfg;
    renderActiveTab();
  } catch (_) {}
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
      pollFast();
      pollSlow();
      if (S.tab === 'overview') markPrismDirty();
      if (S.tab === 'blueprint') startBlueprintAnim();
    } else {
      stopBlueprintAnim();
    }
  });

  setAuthCallback(() => {
    pollFast();
    pollSlow();
  });
}

async function init() {
  updateAuthButton();
  bindGlobalEvents();
  bindBlueprintEvents();
  bindSpectrumEvents();
  bindClientsEvents();
  initPrismCanvas();

  const initialTab = (location.hash || '#overview').replace('#', '');
  switchTab(initialTab, false);

  try {
    const [st, dv, tun] = await Promise.all([call('status'), call('devices'), call('tunnel')]);
    S.status = st;
    S.devices = dv;
    S.tunnel = tun;
    renderActiveTab();
  } catch (_) {}

  pollSlow();
  fastTimer = setInterval(pollFast, 2000);
  slowTimer = setInterval(pollSlow, 6000);
}

init();
