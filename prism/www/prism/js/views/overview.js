/* ============================================================================
 * PRISM 5.0 — View 01: Standalone Dark Side of the Moon Optical Overview
 * ============================================================================ */

import { S, spectralColor, desatObsidianRgb, fmtRate, fmtBytes } from '../state.js?v=5.6.6';
import { $, el } from '../dom.js?v=5.6.6';
import { markPrismDirty } from '../canvas/prism.js?v=5.6.6';

function paintCornerHud(sel, baseRgb, k) {
  const node = $(sel);
  if (!node) return;
  const clamped = Math.max(0.06, Math.min(1, k));
  const sat = 0.24 + 0.76 * Math.pow(clamped, 0.78);
  node.style.setProperty('--hud-rgb', desatObsidianRgb(baseRgb, sat));
  node.style.setProperty('--hud-fill', (0.07 + 0.13 * Math.pow(clamped, 0.85)).toFixed(3));
  node.style.setProperty('--hud-blur', `${Math.round(10 + 14 * clamped)}px`);
  node.style.setProperty('--hud-glow', (0.05 + 0.15 * clamped).toFixed(3));
}

function renderOvMiniSpectrum(strands) {
  const bar = $('#ov-mini-spectrum');
  if (!bar) return;
  const list = strands.length ? strands : Array.from({ length: 21 }, (_, i) => ({ id: i + 1, healthy: true, tokens_pct: 100 }));
  if (bar.children.length !== list.length) {
    bar.innerHTML = '';
    for (let i = 0; i < list.length; i++) {
      bar.appendChild(el('span', { class: 'ov-sp-cell' }));
    }
  }
  const n = list.length;
  for (let i = 0; i < n; i++) {
    const s = list[i];
    const cell = bar.children[i];
    if (!cell) continue;
    const col = spectralColor(i, n);
    if (!s.healthy) {
      cell.style.backgroundColor = 'rgba(230, 108, 120, 0.34)';
      cell.style.boxShadow = 'none';
      cell.style.opacity = '0.44';
    } else {
      const rateBps = (s.now ?? s.rate ?? 0) + (s.up_now ?? s.up ?? 0);
      const mbps = (rateBps * 8) / 1e6;
      const k = rateBps > 400 ? Math.min(1, Math.max(0.24, Math.log10(1 + mbps * 5) / 1.45)) : 0.18;
      const sat = 0.34 + 0.66 * Math.pow(k, 0.78);
      const lit = desatObsidianRgb(col.rgb, sat);
      const pct = (s.tokens_pct ?? 100) / 100;
      cell.style.backgroundColor = `rgb(${lit})`;
      cell.style.opacity = (0.42 + pct * 0.58).toFixed(2);
      cell.style.boxShadow = rateBps > 2000 ? `0 0 7px rgba(${lit}, 0.72)` : 'none';
    }
  }
}

export function renderOverview() {
  const st = S.status;
  if (!st) return;

  const downF = fmtRate(st.rate);
  const upF = fmtRate(st.rate_up);
  const strands = st.strands || [];
  let peakBps = 0;
  for (const x of strands) {
    if ((x.peak || 0) > peakBps) peakBps = x.peak;
  }
  const totalRate = (st.rate || 0) + (st.rate_up || 0);
  const totalMbps = (totalRate * 8) / 1e6;
  const loadK = totalRate > 64 ? Math.min(1, Math.max(0.14, Math.log10(1 + totalMbps * 6) / 1.45)) : 0.10;

  $('#ov-down').textContent = downF.full;
  $('#ov-up').textContent = '↑ ' + upF.full;
  $('#ov-peak').textContent = fmtRate(Math.max(st.rate || 0, peakBps)).full;
  $('#ov-conntrack').textContent = st.sys?.conntrack?.count ?? 0;

  $('#ov-healthy').textContent = `${st.healthy_count ?? 0} / ${st.strand_count ?? 0}`;
  $('#ov-charged').textContent = st.weave?.charged_count ?? 0;
  renderOvMiniSpectrum(strands);

  const vipStrand = strands.find(s => s.vip);
  $('#ov-vip').textContent = st.weave?.vip_dev
    ? `${st.weave.vip_dev} (${vipStrand?.ttfb_ms || '—'}ms)`
    : '—';

  const guardEl = $('#ov-guard');
  if (guardEl) {
    const isStrict = !st.tunnel?.fail_open;
    guardEl.textContent = isStrict ? 'FAIL-CLOSED 0x20000000' : 'FAIL-OPEN WARN';
    guardEl.className = isStrict ? 'c-violet' : 'c-amber';
  }

  const devs = S.devices?.devices || [];
  const onlineCount = devs.filter(d => d.online).length;
  $('#ov-devs').textContent = `${onlineCount} 台`;
  $('#ov-site-name').textContent = st.site?.known
    ? `${st.site.name}${st.site.aggregate ? ' · 聚匯中' : ' · 單線'}`
    : (st.site?.aggregate ? '未知站點 · 強制聚匯' : '未知站點 · 單線');

  $('#ov-total-down').textContent = fmtBytes(st.down_bytes);
  $('#ov-total-up').textContent = fmtBytes(st.up_bytes);

  const tun = S.tunnel;
  const relayName = tun?.tw_home || tun?.selected || 'TW-HOME';
  $('#ov-relay').textContent = relayName;
  const canaryEl = $('#ov-canary');
  const ms = st.tunnel?.canary_ms ?? 0;
  canaryEl.textContent = ms > 0 ? `${ms} ms` : (st.tunnel?.on ? '活躍' : '離線');
  canaryEl.className = ms > 0 ? 'c-mint' : (st.tunnel?.on ? 'c-amber' : 'c-crimson');

  $('#ov-slots').textContent = st.weave?.slots ?? 126;

  // Drive corner obsidian HUD chromatic glow to unify with Spectrum / Blueprint / Terminal
  const healthRatio = (st.healthy_count ?? 0) / Math.max(1, st.strand_count || 21);
  paintCornerHud('#ov-hud-tl', '100, 174, 245', loadK);
  paintCornerHud('#ov-hud-tr', st.ok ? '87, 209, 146' : '230, 108, 120', st.ok ? Math.max(0.20, healthRatio * 0.62 + loadK * 0.25) : 0.88);
  paintCornerHud('#ov-hud-bl', '140, 198, 255', Math.min(1, 0.14 + onlineCount * 0.07 + loadK * 0.35));
  paintCornerHud('#ov-hud-br', ms > 0 ? '170, 142, 240' : (st.tunnel?.on ? '235, 154, 94' : '230, 108, 120'), ms > 0 ? Math.max(0.20, 0.16 + loadK * 0.65) : 0.45);

  // Notify canvas engine to smoothly animate width/brightness changes
  markPrismDirty();
}
