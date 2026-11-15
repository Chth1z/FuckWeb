/* ============================================================================
 * PRISM 5.0 — View 01: Standalone Dark Side of the Moon Optical Overview
 * ============================================================================ */

import { S, fmtRate, fmtBytes } from '../state.js?v=5.6.2';
import { $ } from '../dom.js?v=5.6.2';
import { markPrismDirty } from '../canvas/prism.js?v=5.6.2';

export function renderOverview() {
  const st = S.status;
  if (!st) return;

  const downF = fmtRate(st.rate);
  const upF = fmtRate(st.rate_up);
  let peakBps = 0;
  for (const x of st.strands || []) {
    if ((x.peak || 0) > peakBps) peakBps = x.peak;
  }

  $('#ov-down').textContent = downF.full;
  $('#ov-up').textContent = '↑ ' + upF.full;
  $('#ov-peak').textContent = fmtRate(Math.max(st.rate || 0, peakBps)).full;
  $('#ov-conntrack').textContent = st.sys?.conntrack?.count ?? 0;

  $('#ov-healthy').textContent = `${st.healthy_count ?? 0} / ${st.strand_count ?? 0}`;
  $('#ov-charged').textContent = st.weave?.charged_count ?? 0;

  const vipStrand = (st.strands || []).find(s => s.vip);
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

  // Notify canvas engine to smoothly animate width/brightness changes
  markPrismDirty();
}
