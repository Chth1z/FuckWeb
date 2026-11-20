/* ============================================================================
 * PRISM 5.0 — DOM Builders, Segmented Block Meters & Log Renderers
 * ============================================================================ */

import { fmtClock, spectralColor, desatObsidianRgb, opticalLoad } from './state.js?v=5.8.1';

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

const resolveNode = (target) => (typeof target === 'string' ? $(target) : target);

export function setTxt(target, val) {
  const n = resolveNode(target);
  if (!n) return null;
  const s = String(val);
  if (n.textContent !== s) n.textContent = s;
  return n;
}

export function setCls(target, cls) {
  const n = resolveNode(target);
  if (!n) return null;
  if (n.className !== cls) n.className = cls;
  return n;
}

export function setTitle(target, val) {
  const n = resolveNode(target);
  if (!n) return null;
  const s = String(val);
  if (n.title !== s) n.title = s;
  return n;
}

export function setVar(node, name, val) {
  if (!node?.style?.setProperty) return;
  const s = String(val);
  const vars = node._cssVars || (node._cssVars = new Map());
  if (vars.get(name) === s) return;
  vars.set(name, s);
  node.style.setProperty(name, s);
}

export function setStyleProp(node, prop, val) {
  if (!node?.style) return;
  const s = String(val);
  if (node.style[prop] !== s) node.style[prop] = s;
}

export function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') node.className = v;
    else if (k === 'style' && typeof v === 'object') {
      for (const [sk, sv] of Object.entries(v)) {
        if (sk.startsWith('--')) node.style.setProperty(sk, sv);
        else node.style[sk] = sv;
      }
    }
    else if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2).toLowerCase(), v);
    else node.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat()) {
    if (c == null || c === false) continue;
    node.appendChild(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return node;
}

export function svgEl(tag, attrs = {}, ...children) {
  const node = document.createElementNS('http://www.w3.org/2000/svg', tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v != null) node.setAttribute(k, v);
  }
  for (const c of children.flat()) {
    if (c) node.appendChild(c);
  }
  return node;
}

export function ensureSegCells(container, count) {
  if (!container) return 0;
  if (!container.classList.contains('seg-meter')) container.classList.add('seg-meter');
  if (container.children.length !== count) {
    container.innerHTML = '';
    for (let i = 0; i < count; i++) container.appendChild(el('span', { class: 'seg-cell' }));
  }
  return count;
}

export function spectralCellGlow(rgb, active = true) {
  return active
    ? `0 0 7px rgba(${rgb}, 0.62)`
    : `0 0 5px rgba(${rgb}, 0.36)`;
}

export function renderSegMeter(container, ratio, count = 16, colorClass = 'mint') {
  if (!container) return;
  const active = Math.round(Math.max(0, Math.min(1, ratio)) * count);
  const sig = `${active}/${count}/${colorClass}`;
  if (container.dataset.sig === sig) return;
  container.dataset.sig = sig;
  setVar(container, '--seg-count', String(count));
  ensureSegCells(container, count);

  const isSpec = colorClass === 'spectrum';
  for (let i = 0; i < count; i++) {
    const cell = container.children[i];
    const isOn = i < active;
    if (isOn && isSpec) {
      const col = spectralColor(i, count);
      setCls(cell, 'seg-cell on');
      setStyleProp(cell, 'background', col.css);
      setStyleProp(cell, 'boxShadow', spectralCellGlow(col.rgb, true));
    } else {
      setCls(cell, `seg-cell ${isOn ? 'on ' + colorClass : ''}`);
      if (cell.style.background) setStyleProp(cell, 'background', '');
      if (cell.style.boxShadow) setStyleProp(cell, 'boxShadow', '');
    }
  }
}

export function renderStrandSpectrumBar(container, strands, opts = {}) {
  if (!container) return;
  const desat = !!opts.desat;
  const list = (strands && strands.length)
    ? strands
    : (opts.fallbackCount ? Array.from({ length: opts.fallbackCount }, (_, i) => ({ id: i + 1, healthy: true, tokens_pct: 100 })) : []);
  if (!list.length) return;
  ensureSegCells(container, list.length);

  const n = list.length;
  for (let i = 0; i < n; i++) {
    const s = list[i];
    const cell = container.children[i];
    if (!cell) continue;
    const col = spectralColor(i, n);
    if (!s.healthy) {
      if (cell._spSig === 'down') continue;
      cell._spSig = 'down';
      setCls(cell, 'seg-cell on');
      setStyleProp(cell, 'backgroundColor', 'rgba(230, 108, 120, 0.35)');
      setStyleProp(cell, 'boxShadow', 'none');
      setStyleProp(cell, 'opacity', '0.45');
      if (opts.tooltip) setTitle(cell, `${s.dev} (#${s.id}) · fault`);
      continue;
    }

    const downUp = (s.now ?? s.rate ?? 0) + (s.up_now ?? s.up ?? 0);
    const active = (desat ? downUp : (s.now ?? s.rate ?? 0)) > 2000;
    const pct = (s.tokens_pct ?? 100) / 100;
    const rateTxt = opts.tooltip ? opts.fmtRate(downUp) : '';
    const loadK = desat ? opticalLoad(downUp, 6, 0.18) : 1;
    const litRgb = desat ? desatObsidianRgb(col.rgb, 0.34 + 0.66 * Math.pow(loadK, 0.78)) : col.rgb;
    const sig = `${Math.round(loadK * 100)}:${Math.round(pct * 50)}:${active ? 1 : 0}:${rateTxt}:${s.ttfb_ms ?? ''}`;
    if (cell._spSig === sig) continue;
    cell._spSig = sig;
    if (opts.tooltip) {
      setTitle(cell, `${s.dev} (#${s.id}) · ${rateTxt} · τ=${s.ttfb_ms ?? '—'}ms · ${s.tokens_pct ?? 100}%`);
    }
    setCls(cell, 'seg-cell on');
    setStyleProp(cell, 'backgroundColor', `rgb(${litRgb})`);
    setStyleProp(cell, 'opacity', (0.38 + pct * 0.62).toFixed(2));
    setStyleProp(cell, 'boxShadow', spectralCellGlow(litRgb, active));
  }
}

export function renderSlotMeter(container, slotsCount, slotCols, maxSlots, healthy) {
  if (!container) return;
  const lit = !healthy ? 0
    : (maxSlots > slotCols
      ? Math.min(slotCols, Math.round((slotsCount / maxSlots) * slotCols))
      : Math.min(slotCols, Math.max(0, slotsCount)));
  const sig = `${slotCols}:${lit}`;
  if (container.dataset.sig === sig) return;
  container.dataset.sig = sig;
  setVar(container, '--slot-cols', String(slotCols));
  ensureSegCells(container, slotCols);
  for (let i = 0; i < slotCols; i++) {
    setCls(container.children[i], i < lit ? 'seg-cell on slot-on' : 'seg-cell');
  }
}

let toastTimer = null;
export function toast(msg, bad = false) {
  const t = $('#toast');
  if (!t) return;
  t.textContent = msg;
  t.className = 'toast-bar show' + (bad ? ' bad' : '');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), 2800);
}

export function renderSessionLog(container, events, limit = 6) {
  if (!container) return;
  const slice = (events || []).slice(0, limit);
  const sig = slice.map(e => `${e.ts}:${e.msg}`).join('|');
  if (container.dataset.sig === sig) return;
  container.dataset.sig = sig;
  container.innerHTML = '';
  if (!slice.length) {
    container.appendChild(el('div', { class: 'c-muted' }, '等待狀態轉換事件...'));
    return;
  }
  for (const ev of slice) {
    const raw = ev.msg || '';
    const spaceIdx = raw.indexOf(' ');
    const tag = spaceIdx > 0 ? raw.slice(0, spaceIdx).toLowerCase() : 'prism';
    const body = spaceIdx > 0 ? raw.slice(spaceIdx + 1) : raw;
    let colorClass = 'c-blue';
    if ((tag === 'doctor' && body.startsWith('fail')) || (tag === 'portal' && body.includes('still down'))) {
      colorClass = 'c-crimson';
    } else if (tag === 'portal' || tag === 'wifi') {
      colorClass = 'c-amber';
    } else if (tag.includes('weave') || tag.includes('strand') || tag.includes('site') || tag === 'mptcp') {
      colorClass = 'c-mint';
    } else if (tag.includes('guard') || tag.includes('doctor') || tag === 'identity') {
      colorClass = 'c-violet';
    } else if (tag.includes('config') || tag.includes('device') || tag.includes('tunnel')) {
      colorClass = 'c-gold';
    }
    container.appendChild(el('div', { class: 'log-row' },
      el('span', { class: 'log-ts' }, fmtClock(ev.ts)),
      el('span', { class: `log-tag ${colorClass}` }, tag),
      el('span', { class: 'log-msg', title: body }, body)
    ));
  }
}
