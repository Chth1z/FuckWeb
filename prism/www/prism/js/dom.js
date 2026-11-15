/* ============================================================================
 * PRISM 5.0 — DOM Builders, Segmented Block Meters & Log Renderers
 * ============================================================================ */

import { fmtClock, spectralColor } from './state.js?v=5.6.1';

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

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

export function renderSegMeter(container, ratio, count = 12, colorClass = 'mint', compact = false) {
  if (!container) return;
  const active = Math.round(Math.max(0, Math.min(1, ratio)) * count);
  const sig = `${active}/${count}/${colorClass}/${compact ? 1 : 0}`;
  if (container.dataset.sig === sig) return;
  container.dataset.sig = sig;
  container.style.setProperty('--seg-count', String(count));
  container.classList.toggle('compact', !!compact);
  container.innerHTML = '';
  for (let i = 0; i < count; i++) {
    const isOn = i < active;
    if (isOn && colorClass === 'spectrum') {
      const col = spectralColor(i, count);
      container.appendChild(el('span', {
        class: 'seg-cell on',
        style: {
          background: col.css,
          boxShadow: `0 0 8px rgba(${col.rgb}, 0.65), 0 0 14px rgba(${col.rgb}, 0.25)`,
        },
      }));
    } else {
      container.appendChild(el('span', { class: `seg-cell ${isOn ? 'on ' + colorClass : ''}` }));
    }
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
    let meta = 'status -> ok';
    if (tag.includes('weave') || tag.includes('strand') || tag.includes('site')) {
      colorClass = 'c-mint';
      meta = 'spectrum -> active';
    } else if (tag.includes('guard') || tag.includes('doctor')) {
      colorClass = 'c-violet';
      meta = 'guard -> verified';
    } else if (tag.includes('config') || tag.includes('device') || tag.includes('tunnel')) {
      colorClass = 'c-gold';
      meta = 'uci -> committed';
    }
    container.appendChild(el('div', { class: 'log-row' },
      el('span', { class: 'log-ts' }, fmtClock(ev.ts)),
      el('span', { class: `log-tag ${colorClass}` }, tag),
      el('span', { class: 'log-msg', title: body }, body)
    ));
  }
}
