/* ============================================================================
 * PRISM 5.0 — View 01: Standalone Dark Side of the Moon Optical Overview
 * ============================================================================ */

import { S, parseRgb, opticalLoad, fmtRate, fmtBytes } from '../state.js?v=5.8.1';
import { $, setTxt, setCls, renderStrandSpectrumBar } from '../dom.js?v=5.8.1';
import { markPrismDirty } from '../canvas/prism.js?v=5.8.1';

// Drive typography color, obsidian saturation, and optical text glow directly from load intensity (0..1)
function paintOpticalText(nodeOrSel, baseRgb, k, baseWhite = 0) {
  const node = typeof nodeOrSel === 'string' ? $(nodeOrSel) : nodeOrSel;
  if (!node) return;
  const clamped = Math.max(0.05, Math.min(1, k));
  const q = Math.round(clamped * 160);
  const sig = `${baseRgb}:${baseWhite}:${q}`;
  if (node._optSig === sig) return;
  node._optSig = sig;
  const sat = 0.28 + 0.72 * Math.pow(clamped, 0.78);
  const [r, g, b] = parseRgb(baseRgb);
  const mix = (c, base) => Math.round(base + (c - base) * sat);
  let rr = mix(r, 148);
  let gg = mix(g, 160);
  let bb = mix(b, 182);
  const lift = baseWhite + (clamped > 0.45 ? (clamped - 0.45) * 0.65 : 0);
  if (lift > 0) {
    const w = Math.min(0.88, lift);
    rr = Math.round(rr + (255 - rr) * w);
    gg = Math.round(gg + (255 - gg) * w);
    bb = Math.round(bb + (255 - bb) * w);
  }
  const g1A = (0.08 + 0.44 * Math.pow(clamped, 0.95)).toFixed(3);
  const g2A = (0.02 + 0.22 * Math.pow(clamped, 1.15)).toFixed(3);
  const blur1 = Math.round(6 + 12 * clamped);
  const blur2 = Math.round(14 + 22 * clamped);
  node.style.color = `rgb(${rr}, ${gg}, ${bb})`;
  node.style.textShadow =
    `0 0 ${blur1}px rgba(${r}, ${g}, ${b}, ${g1A}), ` +
    `0 0 ${blur2}px rgba(${r}, ${g}, ${b}, ${g2A}), ` +
    `0 1px 2px rgba(0, 0, 0, 0.96)`;
}

export function renderOverview() {
  const st = S.status;
  if (!st) return;

  const downF = fmtRate(st.rate);
  const upF = fmtRate(st.rate_up);
  const strands = st.strands || [];
  const rateScale = (bps) => opticalLoad(bps, 6, 0.10);
  const downK = rateScale(st.rate || 0);
  const upK = rateScale(st.rate_up || 0);
  const loadK = rateScale((st.rate || 0) + (st.rate_up || 0));
  const peakRate = Math.max(st.rate || 0, st.rate_peak || 0);
  const peakK = rateScale(peakRate);
  const ctCount = st.sys?.conntrack?.count ?? 0;

  setTxt('#ov-down', downF.full);
  setTxt('#ov-up', '↑ ' + upF.full);
  setTxt('#ov-peak', fmtRate(peakRate).full);
  setTxt('#ov-conntrack', ctCount);

  paintOpticalText('#ov-down', '140, 198, 255', downK, 0.52);
  paintOpticalText('#ov-up', '100, 174, 245', upK, 0.10);
  paintOpticalText('#ov-peak', '195, 220, 250', peakK, 0.34);
  paintOpticalText('#ov-conntrack', '175, 206, 245', Math.min(1, 0.14 + Math.log10(1 + ctCount) * 0.16), 0.30);

  setTxt('#ov-healthy', `${st.healthy_count ?? 0} / ${st.strand_count ?? 0}`);
  setTxt('#ov-charged', st.weave?.charged_count ?? 0);
  renderStrandSpectrumBar($('#ov-mini-spectrum'), strands, { desat: true, fallbackCount: 21 });

  const healthRatio = (st.healthy_count ?? 0) / Math.max(1, st.strand_count || 21);
  const healthK = st.ok ? Math.max(0.20, healthRatio * 0.65 + loadK * 0.25) : 0.88;
  const specRgb = st.ok ? '87, 209, 146' : '230, 108, 120';
  paintOpticalText('#ov-healthy', specRgb, healthK, 0.12);
  paintOpticalText('#ov-charged', specRgb, healthK, 0.12);

  const vipStrand = strands.find(s => s.vip);
  setTxt('#ov-vip', st.weave?.vip_dev
    ? `${st.weave.vip_dev} (${vipStrand?.ttfb_ms || '—'}ms)`
    : '—');
  const vipBps = st.telemetry?.branches?.vip?.bps ?? 0;
  paintOpticalText('#ov-vip', '100, 174, 245', rateScale(vipBps), 0.12);

  const guardEl = $('#ov-guard');
  if (guardEl) {
    const isOk = st.ok !== false;
    const isStrict = !st.tunnel?.fail_open;
    const txt = !isOk ? 'GUARD FAIL' : (isStrict ? 'FAIL-CLOSED 0x20000000' : 'FAIL-OPEN WARN');
    const cls = !isOk ? 'c-crimson' : (isStrict ? 'c-violet' : 'c-amber');
    const rgb = !isOk ? '230, 108, 120' : (isStrict ? '170, 142, 240' : '235, 154, 94');
    const k = !isOk ? 0.90 : (isStrict ? Math.max(0.24, 0.20 + loadK * 0.55) : 0.82);
    setTxt(guardEl, txt);
    setCls(guardEl, cls);
    paintOpticalText(guardEl, rgb, k, 0.10);
  }

  const devs = S.devices?.devices || [];
  const onlineCount = devs.filter(d => d.online).length;
  const devK = Math.min(1, 0.14 + onlineCount * 0.08 + loadK * 0.35);
  setTxt('#ov-devs', `${onlineCount} 台`);
  paintOpticalText('#ov-devs', '140, 198, 255', devK, 0.42);
  setTxt('#ov-site-name', st.site?.known
    ? `${st.site.name}${st.site.aggregate ? ' · 聚匯中' : ' · 單線'}`
    : (st.site?.aggregate ? '未知站點 · 強制聚匯' : '未知站點 · 單線'));

  setTxt('#ov-total-down', fmtBytes(st.down_bytes));
  setTxt('#ov-total-up', fmtBytes(st.up_bytes));
  paintOpticalText('#ov-total-down', '175, 208, 245', Math.max(0.16, downK * 0.72), 0.34);
  paintOpticalText('#ov-total-up', '140, 190, 242', Math.max(0.14, upK * 0.72), 0.24);

  const tun = S.tunnel;
  const relayName = tun?.selected || tun?.tw_home || (st.tunnel?.on ? '活躍中' : '旁路直連');
  setTxt('#ov-relay', relayName);
  const canaryEl = $('#ov-canary');
  const ms = st.tunnel?.canary_ms ?? 0;
  const tunStatusTxt = !st.tunnel?.on ? '直連' : (!st.tunnel?.running ? '未運行' : (ms > 0 ? `${ms} ms` : '探測中'));
  const tunCls = !st.tunnel?.on ? 'c-sec' : (!st.tunnel?.running ? 'c-crimson' : (ms > 0 ? 'c-mint' : 'c-amber'));
  const tunRgb = !st.tunnel?.on ? '148, 160, 182' : (!st.tunnel?.running ? '230, 108, 120' : (ms > 0 ? '87, 209, 146' : '235, 154, 94'));
  setTxt(canaryEl, tunStatusTxt);
  setCls(canaryEl, tunCls);
  const tunK = (st.tunnel?.running && ms > 0) ? Math.max(0.22, 0.20 + loadK * 0.62) : 0.55;
  paintOpticalText('#ov-relay', '196, 218, 250', tunK, 0.38);
  paintOpticalText(canaryEl, tunRgb, tunK, 0.12);

  setTxt('#ov-slots', st.weave?.slots ?? 126);

  // Notify canvas engine to smoothly animate width/brightness changes
  markPrismDirty();
}
