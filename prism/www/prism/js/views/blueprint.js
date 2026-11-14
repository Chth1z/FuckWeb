/* ============================================================================
 * PRISM 5.0 — View 02: Animated Blueprint Schematic & Policy Controls
 * ============================================================================ */

import { S, LOCKED_SPECS, EDITABLE_SPECS } from '../state.js';
import { $, $$, el, renderSegMeter, renderSessionLog } from '../dom.js';
import { write, call } from '../api.js';

let drawerOpen = false;

export function bindBlueprintEvents() {
  $$('#site-mode-seg .seg-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      write('configure', { set: { 'strands.aggregate': btn.dataset.mode } }, `聚匯模式已設為 ${btn.dataset.mode}`);
    });
  });

  $('#site-mem-btn')?.addEventListener('click', () => {
    const st = S.status;
    if (!st) return;
    if (st.site?.known) {
      write('forget', {}, '已從配置忘記此站點');
    } else {
      const name = prompt('請輸入站點名稱 (如: IHG 酒店)', st.site?.name || 'site');
      if (name != null) {
        write('remember', { name: name.trim() || 'site', aggregate: true, portal: st.site?.portal || '' }, `已記住站點「${name.trim() || 'site'}」並開啟聚匯`);
      }
    }
  });

  $('#btn-toggle-sys')?.addEventListener('click', async () => {
    drawerOpen = !drawerOpen;
    const drw = $('#bp-sys-drawer');
    const btn = $('#btn-toggle-sys');
    if (drw) drw.style.display = drawerOpen ? 'flex' : 'none';
    if (btn) btn.textContent = drawerOpen ? '收起體檢與 UCI ▴' : '體檢與 UCI 參數 ▾';
    if (drawerOpen) {
      if (S.session && !S.config) {
        try { S.config = await call('config'); } catch (_) {}
      }
      renderBlueprintDrawer();
    }
  });
}

export function renderBlueprint() {
  const st = S.status;
  if (!st) return;
  const w = st.weave || {};
  const tun = S.tunnel;
  const nH = Math.max(1, st.healthy_count || st.strand_count || 21);

  // Advisor Left Rail
  const canaryMs = st.tunnel?.canary_ms || 0;
  $('#adv-verdict').textContent = st.ok ? 'zero-leak verified' : (st.fail?.join(', ') || 'check failed');
  $('#adv-verdict').className = st.ok ? 'c-mint' : 'c-crimson';
  $('#adv-canary').textContent = canaryMs > 0 ? `${canaryMs} ms` : (st.tunnel?.on ? 'active' : 'off');
  $('#adv-ct').textContent = `${st.sys?.conntrack?.count ?? 0}`;
  $('#adv-strands').textContent = `${st.healthy_count ?? 0}/${st.strand_count ?? 21}`;

  const dnsEl = $('#adv-dns');
  if (dnsEl) {
    dnsEl.textContent = st.dns?.smartdns ? `53 → ${st.dns.port || 6053}` : 'offline';
    dnsEl.className = st.dns?.smartdns ? 'c-mint' : 'c-crimson';
  }
  $('#adv-doctor').textContent = st.ok
    ? `all ${S.doctor?.checks?.length || 24} invariants ok`
    : `${st.fail?.length || 1} fail · ${st.warn?.length || 0} warn`;

  // Lead Scheduler Box
  const chargedRatio = (w.charged_count || 0) / nH;
  renderSegMeter($('#bp-harvest-meter'), chargedRatio, 10, 'amber');
  $('#bp-harvest-txt').textContent = `${w.policy || 'harvest'} (${Math.round(chargedRatio * 100)}% ready)`;

  const curMode = st.settings?.['strands.aggregate'] || st.site?.mode || 'auto';
  $$('#site-mode-seg .seg-btn').forEach(b => b.classList.toggle('on', b.dataset.mode === curMode));

  const memBtn = $('#site-mem-btn');
  if (memBtn) {
    if (!st.site?.gateway) {
      memBtn.disabled = true;
      memBtn.textContent = '無上聯網關 MAC';
    } else if (st.site?.known) {
      memBtn.disabled = false;
      memBtn.textContent = `忘記: ${st.site.name}`;
    } else {
      memBtn.disabled = false;
      memBtn.textContent = '記住並聚匯';
    }
  }

  // Middle Token Capacitor Layer
  $('#cap-slots').textContent = `${w.slots ?? 126} · ${w.affinity || 'flow'}`;
  renderSegMeter($('#bar-charged'), (w.charged_count || 0) / nH, 12, 'mint');
  $('#val-charged').textContent = `${w.charged_count ?? 0}/${nH}`;

  renderSegMeter($('#bar-draining'), (w.draining_count || 0) / nH, 12, 'amber');
  $('#val-draining').textContent = `${w.draining_count ?? 0}`;

  renderSegMeter($('#bar-cooling'), ((w.cooling_count || 0) + (w.depleted_count || 0)) / nH, 12, 'violet');
  $('#val-cooling').textContent = `${(w.cooling_count || 0) + (w.depleted_count || 0)}`;

  const vipS = (st.strands || []).find(s => s.vip);
  renderSegMeter($('#bar-vip'), vipS ? (vipS.tokens_pct || 100) / 100 : 0, 12, 'blue');
  $('#val-vip').textContent = vipS ? `${vipS.dev} (${vipS.ttfb_ms}ms)` : 'none';

  // 3 Cerulean Sub-Nodes
  const rules = S.rules?.rules || [];
  let totPkt = 0, tunPkt = 0;
  for (const r of rules) {
    totPkt += r.packets || 0;
    if (r.tag.includes('tunnel') || r.tag === 'rest-tunnel') tunPkt += r.packets || 0;
  }
  const tunRatio = totPkt > 0 ? tunPkt / totPkt : 0.5;
  renderSegMeter($('#sub1-bar'), tunRatio, 10, 'blue');
  $('#sub1-pct').textContent = totPkt > 0 ? `${Math.round(tunRatio * 100)}%` : 'idle';
  $('#sub1-desc').textContent = `隧道包 ${(tunPkt / 1000).toFixed(1)}k / 總 ${(totPkt / 1000).toFixed(1)}k`;
  $('#sub1-st').textContent = S.rules?.tunnel_on ? 'divert active' : 'direct only';

  const mihomoOk = !!st.tunnel?.running;
  renderSegMeter($('#sub2-bar'), mihomoOk ? 1 : 0, 10, mihomoOk ? 'blue' : 'amber');
  $('#sub2-pct').textContent = mihomoOk ? '100%' : '0%';
  $('#sub2-desc').textContent = tun?.tw_home || tun?.selected || 'TW-HOME';
  $('#sub2-st').textContent = mihomoOk ? (canaryMs > 0 ? `${canaryMs} ms ok` : 'running') : 'starting...';

  const dnsOk = !!st.dns?.smartdns;
  renderSegMeter($('#sub3-bar'), dnsOk ? 1 : 0, 10, dnsOk ? 'blue' : 'amber');
  $('#sub3-pct').textContent = dnsOk ? '100%' : '0%';
  $('#sub3-desc').textContent = `tunnel4_dns: ${S.rules?.sizes?.tunnel4_dns ?? 0} ips`;
  $('#sub3-st').textContent = dnsOk ? 'running' : 'offline';

  // Bottom Verify Box & Session Log
  $('#bp-verify-summary').textContent = st.ok
    ? `上次調諧正常 · 可用內存 ${Math.round((st.sys?.mem_available_kb || 0) / 1024)} MB · load ${st.sys?.load1 ?? 0}`
    : `異常項目: ${(st.fail || []).join(', ')}`;

  renderSessionLog($('#ov-session-log'), S.events?.events || [], 6);

  if (drawerOpen) renderBlueprintDrawer();
}

export function renderBlueprintDrawer() {
  const doc = S.doctor;
  const dl = $('#doctor-list');
  if (doc && dl) {
    $('#doctor-cap').textContent = doc.ok ? `OK (${doc.checks.length} checks)` : `${doc.fail.length} FAIL / ${doc.warn.length} WARN`;
    const sig = doc.checks.map(c => `${c.id}:${c.ok}:${c.detail}`).join('|');
    if (dl.dataset.sig !== sig) {
      dl.dataset.sig = sig;
      dl.innerHTML = '';
      for (const c of doc.checks) {
        const cls = c.ok ? '' : (c.level === 'fail' ? 'bad' : 'warn');
        dl.appendChild(el('div', { class: `doc-item ${cls}` },
          el('span', { class: c.ok ? 'c-primary' : (c.level === 'fail' ? 'c-crimson' : 'c-amber') }, c.id),
          el('span', { class: c.ok ? 'c-mint' : 'c-crimson' }, c.ok ? (c.detail || 'OK') : (c.detail || c.level.toUpperCase()))
        ));
      }
    }
  }

  const lp = $('#locked-panel');
  if (lp && !lp.dataset.built) {
    lp.dataset.built = '1';
    lp.innerHTML = '';
    for (const [k, val, desc] of LOCKED_SPECS) {
      lp.appendChild(el('div', { class: 'cfg-row' },
        el('div', {},
          el('div', { class: 'c-bright' }, k),
          el('div', { class: 'c-muted', style: { fontSize: '11px' } }, desc)
        ),
        el('span', { class: 'st-badge draining' }, `LOCKED · ${val}`)
      ));
    }
  }

  const cp = $('#config-panel');
  if (!cp) return;
  if (!S.session) {
    cp.innerHTML = '';
    cp.appendChild(el('div', { class: 'c-muted', style: { padding: '12px 0' } }, '需點擊右上角「管理登入」以修改 UCI 可調參數'));
    return;
  }
  const vals = S.config?.values || S.status?.settings || {};
  const sig = EDITABLE_SPECS.map(s => `${s.key}=${vals[s.key]}`).join('|');
  if (cp.dataset.sig === sig) return;
  cp.dataset.sig = sig;
  cp.innerHTML = '';
  for (const spec of EDITABLE_SPECS) {
    const v = vals[spec.key];
    let control;
    if (spec.type === 'bool') {
      control = el('button', {
        class: `btn-cmd ${v ? 'primary' : ''}`,
        onClick: () => write('configure', { set: { [spec.key]: v ? 0 : 1 } }, `${spec.label}已切換`)
      }, v ? '已開啟 (1)' : '已關閉 (0)');
    } else {
      const inp = el('input', {
        class: 'bp-input',
        type: 'number',
        min: spec.min,
        max: spec.max,
        value: v ?? '',
        style: { width: '90px', textAlign: 'right' }
      });
      const save = el('button', {
        class: 'btn-cmd',
        onClick: () => write('configure', { set: { [spec.key]: Number(inp.value) } }, `${spec.key} = ${inp.value}`)
      }, '套用');
      control = el('div', { style: { display: 'flex', gap: '6px' } }, inp, save);
    }
    cp.appendChild(el('div', { class: 'cfg-row' },
      el('div', {},
        el('div', { class: 'c-bright' }, spec.key),
        el('div', { class: 'c-muted', style: { fontSize: '11px' } }, spec.label)
      ),
      control
    ));
  }
}
