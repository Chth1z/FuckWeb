/* ============================================================================
 * PRISM 5.0 — OpenWrt ubus JSON-RPC 2.0 Client & Session Auth
 * ============================================================================ */

import { S } from './state.js?v=5.8.1';
import { $, toast } from './dom.js?v=5.8.1';

const ANON_TOKEN = '00000000000000000000000000000000';
let rpcSeq = 1;
let pendingAction = null;
let onAuthSuccessCallback = null;

export function setAuthCallback(fn) {
  onAuthSuccessCallback = fn;
}

function parseUbusResult(data) {
  if (!data) throw new Error('Empty RPC response');
  if (data.error) {
    const err = new Error(data.error.message || 'RPC Error');
    err.code = data.error.code;
    throw err;
  }
  const [status, payload] = data.result || [0, null];
  if (status !== 0) {
    const err = new Error('ubus status ' + status);
    err.ubus = status;
    throw err;
  }
  return payload;
}

export async function ubusCall(object, method, args = {}, token = S.session || ANON_TOKEN) {
  const res = await fetch('/ubus', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: rpcSeq++,
      method: 'call',
      params: [token, object, method, args]
    })
  });
  if (!res.ok) throw new Error('HTTP ' + res.status);
  return parseUbusResult(await res.json());
}

export async function call(method, args = {}) {
  try {
    return await ubusCall('prism', method, args);
  } catch (e) {
    if ((e.ubus === 6 || e.code === -32002) && S.session) {
      clearSession();
      return await ubusCall('prism', method, args, ANON_TOKEN);
    }
    throw e;
  }
}

async function rawBatch(items, token) {
  const res = await fetch('/ubus', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(items.map(it => ({
      jsonrpc: '2.0',
      id: it.id,
      method: 'call',
      params: [token, 'prism', it.method, it.args || {}]
    })))
  });
  if (!res.ok) throw new Error('HTTP ' + res.status);
  const data = await res.json();
  const arr = Array.isArray(data) ? data : [data];
  const byId = new Map();
  for (const r of arr) {
    if (r && r.id != null) byId.set(r.id, r);
  }
  return byId;
}

export async function callBatch(requests) {
  const out = new Array(requests.length).fill(null);
  const active = [];
  for (let i = 0; i < requests.length; i++) {
    const req = requests[i];
    if (!req) continue;
    const item = typeof req === 'string' ? { method: req, args: {} } : req;
    active.push({ idx: i, id: rpcSeq++, method: item.method, args: item.args || {} });
  }
  if (!active.length) return out;

  const usedSession = !!S.session;
  const byId = await rawBatch(active, S.session || ANON_TOKEN);
  const authRetry = [];
  for (const it of active) {
    try {
      out[it.idx] = parseUbusResult(byId.get(it.id));
    } catch (e) {
      if ((e.ubus === 6 || e.code === -32002) && usedSession) {
        authRetry.push(it);
      }
    }
  }
  if (authRetry.length && usedSession) {
    clearSession();
    const retryById = await rawBatch(authRetry, ANON_TOKEN);
    for (const it of authRetry) {
      try {
        out[it.idx] = parseUbusResult(retryById.get(it.id));
      } catch (_) {
        out[it.idx] = null;
      }
    }
  }
  return out;
}

export async function write(method, args = {}, successMsg = '已套用') {
  if (!S.session) {
    openLoginModal(() => write(method, args, successMsg));
    return null;
  }
  try {
    const res = await ubusCall('prism', method, args, S.session);
    if (res && res.ok === false) {
      toast(res.error || '操作失敗', true);
      return null;
    }
    if (successMsg) toast(successMsg);
    if (onAuthSuccessCallback) onAuthSuccessCallback();
    return res;
  } catch (e) {
    if (e.ubus === 6 || e.code === -32002) {
      clearSession();
      openLoginModal(() => write(method, args, successMsg));
      return null;
    }
    toast(e.message || '請求失敗', true);
    return null;
  }
}

export function clearSession() {
  S.session = '';
  S.user = '';
  localStorage.removeItem('prism_session');
  localStorage.removeItem('prism_user');
  updateAuthButton();
}

export function updateAuthButton() {
  const btn = $('#btn-auth');
  if (!btn) return;
  const nextTxt = S.session ? `${S.user || 'root'} · 登出` : '管理登入';
  if (btn.textContent !== nextTxt) btn.textContent = nextTxt;
  btn.classList.toggle('mint', !!S.session);
}

export function openLoginModal(afterFn = null) {
  pendingAction = afterFn;
  const scrim = $('#scrim');
  if (!scrim) return;
  scrim.classList.add('open');
  $('#login-err').textContent = '';
  $('#pass').value = '';
  setTimeout(() => $('#pass')?.focus(), 40);
}

export function closeLoginModal() {
  $('#scrim')?.classList.remove('open');
  pendingAction = null;
}

export async function submitLogin(e) {
  if (e) e.preventDefault();
  const username = ($('#user')?.value || 'root').trim();
  const password = $('#pass')?.value || '';
  const errEl = $('#login-err');
  const goBtn = $('#login-go');
  if (!password) {
    errEl.textContent = '請輸入密碼';
    return;
  }
  goBtn.disabled = true;
  errEl.textContent = '';
  try {
    const res = await ubusCall('session', 'login', { username, password }, ANON_TOKEN);
    if (!res || !res.ubus_rpc_session) throw new Error('帳號或密碼錯誤');
    S.session = res.ubus_rpc_session;
    S.user = username;
    localStorage.setItem('prism_session', S.session);
    localStorage.setItem('prism_user', S.user);
    updateAuthButton();
    const fn = pendingAction;
    closeLoginModal();
    toast('管理會話已解鎖');
    if (fn) await fn();
    else if (onAuthSuccessCallback) onAuthSuccessCallback();
  } catch (err) {
    errEl.textContent = '登入失敗：請確認路由器管理密碼';
  } finally {
    goBtn.disabled = false;
  }
}
