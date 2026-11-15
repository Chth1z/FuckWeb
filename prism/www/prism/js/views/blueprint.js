/* ============================================================================
 * PRISM — View 02: Kernel Routing Architecture, Proportional Classify & Ribbons
 * ============================================================================ */

import { S, LOCKED_SPECS, EDITABLE_SPECS, spectralColor, fmtRate } from '../state.js?v=5.4.1';
import { $, $$, el, renderSegMeter, renderSessionLog } from '../dom.js?v=5.4.1';
import { write, call } from '../api.js?v=5.4.1';

let drawerOpen = false;
let rafId = null;
let lastFrameTs = 0;

let prevRuleSample = null;
const liveFlow = {
  totPkts: 0,
  quicPkts: 0,
  vipBps: 0,
  tunBps: 0,
  domBps: 0,
  tunPkts: 0,
  domPkts: 0,
  tunShare: 0
};

const RULE_LABELS = {
  'device-block': '設備禁網',
  'relay': '中繼直連',
  'quic': 'QUIC攔截',
  'device-direct': '設備直連',
  'device-tunnel': '設備隧道',
  'device-game': '遊戲專線',
  'tunnel-range': '強制IP段',
  'tunnel-domain': 'SmartDNS釘選',
  'domestic': '國內直連',
  'domestic-domain': 'SmartDNS國內',
  'tunnel-port': '海外UDP端口',
  'rest-tunnel': '其餘→TW-HOME',
  'rest-direct': '其餘→直連'
};

// Normalized 0..1 wave phase & energy: 0=vip, 1=tw-home, 2=harvest, 3=weave_out, 4=ingress/uplink
const waveState = [
  { phase: 0.08, vel: 0.22, targetVel: 0.22, glow: 0.42, targetGlow: 0.42, width: 2.3 },
  { phase: 0.36, vel: 0.28, targetVel: 0.28, glow: 0.46, targetGlow: 0.46, width: 2.5 },
  { phase: 0.64, vel: 0.34, targetVel: 0.34, glow: 0.52, targetGlow: 0.52, width: 2.6 },
  { phase: 0.18, vel: 0.42, targetVel: 0.42, glow: 0.46, targetGlow: 0.46, width: 2.1 },
  { phase: 0.52, vel: 0.30, targetVel: 0.30, glow: 0.46, targetGlow: 0.46, width: 2.3 }
];

function relBox(elNode, rootRect) {
  if (!elNode) return null;
  const r = elNode.getBoundingClientRect();
  return {
    x: r.left - rootRect.left,
    y: r.top - rootRect.top,
    w: r.width,
    h: r.height,
    cx: r.left - rootRect.left + r.width * 0.5,
    cy: r.top - rootRect.top + r.height * 0.5,
    right: r.right - rootRect.left,
    bottom: r.bottom - rootRect.top
  };
}

function mixWhiteRgb(rgb, whiteMix = 0.60) {
  const parts = String(rgb).split(',').map(v => Number(v.trim()) || 0);
  const mix = (c) => Math.round(c + (255 - c) * whiteMix);
  return `${mix(parts[0])}, ${mix(parts[1])}, ${mix(parts[2])}`;
}

function makeBezier(x0, y0, x1, y1, horizontal = true) {
  if (horizontal) {
    const dx = Math.abs(x1 - x0);
    const pull = Math.max(24, dx * 0.54);
    return { x0, y0, cx1: x0 + pull, cy1: y0, cx2: x1 - pull, cy2: y1, x1, y1 };
  }
  const dy = Math.abs(y1 - y0);
  const pull = Math.max(12, dy * 0.45);
  const dir = y1 >= y0 ? 1 : -1;
  return { x0, y0, cx1: x0, cy1: y0 + dir * pull, cx2: x1, cy2: y1 - dir * pull, x1, y1 };
}

function traceBezier(ctx, g) {
  ctx.beginPath();
  ctx.moveTo(g.x0, g.y0);
  ctx.bezierCurveTo(g.cx1, g.cy1, g.cx2, g.cy2, g.x1, g.y1);
}

const SPECTRUM_STOPS = [
  [0.00, [232, 93, 80]],
  [0.18, [235, 154, 94]],
  [0.36, [240, 202, 104]],
  [0.56, [87, 209, 146]],
  [0.78, [100, 174, 245]],
  [1.00, [170, 142, 240]],
];

function makeSpectrumGradient(ctx, x0, y0, x1, y1, alpha, whiteMix = 0) {
  const grad = ctx.createLinearGradient(x0, y0, x1, y1);
  const a = alpha.toFixed(3);
  for (const [offset, c] of SPECTRUM_STOPS) {
    const r = Math.round(c[0] + (255 - c[0]) * whiteMix);
    const g = Math.round(c[1] + (255 - c[1]) * whiteMix);
    const b = Math.round(c[2] + (255 - c[2]) * whiteMix);
    grad.addColorStop(offset, `rgba(${r}, ${g}, ${b}, ${a})`);
  }
  return grad;
}

function drawPortAnchor(ctx, x, y, rgb, glow) {
  const anchorRgb = rgb === 'spectrum' ? '216, 232, 255' : rgb;
  ctx.save();
  ctx.globalCompositeOperation = 'lighter';
  ctx.fillStyle = `rgba(${anchorRgb}, ${(0.28 + glow * 0.36).toFixed(3)})`;
  ctx.fillRect(x - 4, y - 4, 8, 8);
  ctx.fillStyle = `rgba(255, 255, 255, ${(0.55 + glow * 0.38).toFixed(3)})`;
  ctx.fillRect(x - 1.5, y - 1.5, 3, 3);
  ctx.restore();
}

function drawLinkTag(ctx, x, y, text, rgb) {
  ctx.save();
  ctx.font = '600 9.5px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace';
  const tw = ctx.measureText(text).width;
  const bx = x - tw * 0.5 - 5;
  const bw = tw + 10;
  ctx.fillStyle = 'rgba(4, 6, 12, 0.88)';
  ctx.fillRect(bx, y - 8, bw, 15);
  ctx.strokeStyle = rgb === 'spectrum'
    ? makeSpectrumGradient(ctx, bx, y, bx + bw, y, 0.72)
    : `rgba(${rgb}, 0.42)`;
  ctx.lineWidth = 1;
  ctx.strokeRect(bx, y - 8, bw, 15);
  ctx.fillStyle = rgb === 'spectrum'
    ? 'rgba(244, 247, 252, 0.96)'
    : `rgba(${mixWhiteRgb(rgb, 0.45)}, 0.92)`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(text, x, y);
  ctx.restore();
}

// Figure-3 Reference Continuous Light-Band: full-length solid core + outer bloom + smooth periodic flow surge (Zero Dark Ends!)
function drawContinuousLightRibbon(ctx, geom, rgb, st, phaseOffset = 0, tag = '') {
  const active = st.vel > 0.01;
  const g = st.glow;
  const w = st.width;
  const isSpec = rgb === 'spectrum';
  const strokePaint = (a, whiteMix = 0) => (
    isSpec
      ? makeSpectrumGradient(ctx, geom.x0, geom.y0, geom.x1, geom.y1, a, whiteMix)
      : `rgba(${whiteMix > 0 ? mixWhiteRgb(rgb, whiteMix) : rgb}, ${a.toFixed(3)})`
  );

  ctx.save();
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.globalCompositeOperation = 'lighter';

  // 1. Wide Outer Optical Bloom (100% full length from port to port, never dim at ends)
  traceBezier(ctx, geom);
  ctx.lineWidth = w * 5.0;
  ctx.strokeStyle = strokePaint(0.08 + g * 0.16);
  ctx.stroke();

  // 2. Solid Saturated Color Beam Body (100% full length continuous ribbon matching Figure 3)
  traceBezier(ctx, geom);
  ctx.lineWidth = w * 2.05;
  ctx.strokeStyle = strokePaint(0.38 + g * 0.44);
  ctx.stroke();

  // 3. Continuous Bright Luminous Inner Core Filament (100% full length solid light streak)
  traceBezier(ctx, geom);
  ctx.lineWidth = Math.max(1.25, w * 0.78);
  ctx.strokeStyle = strokePaint(0.56 + g * 0.36, 0.62);
  ctx.stroke();

  // 4. Subtle Periodic Flowing Optical Surge (adds +luminance crests over already-solid beam — never hollow!)
  if (active && g > 0.08) {
    const p = (st.phase + phaseOffset) % 1.0;
    const surgeGrad = ctx.createLinearGradient(geom.x0, geom.y0, geom.x1, geom.y1);
    const stops = 20;
    for (let i = 0; i <= stops; i++) {
      const u = i / stops;
      const d1 = Math.abs((((u - p) % 1 + 1.5) % 1) - 0.5);
      const d2 = Math.abs((((u - p - 0.5) % 1 + 1.5) % 1) - 0.5);
      const wave = Math.exp(-Math.pow(d1 / 0.15, 2)) + Math.exp(-Math.pow(d2 / 0.15, 2));
      const crestA = Math.min(0.42, wave * g * 0.36);
      surgeGrad.addColorStop(u, `rgba(255, 255, 255, ${crestA.toFixed(3)})`);
    }
    traceBezier(ctx, geom);
    ctx.lineWidth = Math.max(1.6, w * 1.15);
    ctx.strokeStyle = surgeGrad;
    ctx.stroke();
  }

  ctx.restore();

  // Dock crisp glowing emitter/receiver nodes at both module boundaries
  drawPortAnchor(ctx, geom.x0, geom.y0, rgb, g);
  drawPortAnchor(ctx, geom.x1, geom.y1, rgb, g);

  if (tag && Math.hypot(geom.x1 - geom.x0, geom.y1 - geom.y0) >= 24) {
    const mx = (geom.x0 + geom.x1) * 0.5;
    const my = (geom.y0 + geom.y1) * 0.5;
    drawLinkTag(ctx, mx, my, tag, rgb);
  }
}

function renderWaveguidesCanvas() {
  const pipe = $('#bp-pipeline');
  const canvas = $('#bp-flow-canvas');
  if (!pipe || !canvas) return;

  const rect = pipe.getBoundingClientRect();
  if (rect.width < 40 || rect.height < 40) return;

  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const cw = Math.round(rect.width * dpr);
  const ch = Math.round(rect.height * dpr);
  if (canvas.width !== cw || canvas.height !== ch) {
    canvas.width = cw;
    canvas.height = ch;
  }

  const pre = relBox($('#bp-card-pregate'), rect);
  const ing = relBox($('#bp-card-ingress'), rect);
  const vip = relBox($('#bp-card-vip'), rect);
  const tun = relBox($('#bp-card-tun'), rect);
  const dom = relBox($('#bp-card-dom'), rect);
  const qos = relBox($('#bp-card-qos'), rect);
  const q10 = relBox($('#bp-qos-10'), rect);
  const q20 = relBox($('#bp-qos-20'), rect);
  const q30 = relBox($('#bp-qos-30'), rect);
  const up  = relBox($('#bp-card-uplink'), rect);
  if (!pre || !ing || !vip || !tun || !dom || !qos || !up) return;

  const ctx = canvas.getContext('2d');
  ctx.save();
  ctx.scale(dpr, dpr);
  ctx.clearRect(0, 0, rect.width, rect.height);

  // Stage 1 Vertical Conduit: Pre-Gate -> Nftables Classify Engine
  if (ing.y - pre.bottom > 6) {
    const gPre = makeBezier(pre.cx, pre.bottom, ing.cx, ing.y, false);
    drawContinuousLightRibbon(ctx, gPre, 'spectrum', waveState[4], 0.00, 'QUIC→TCP');
  }

  // Inter-Engine Cross-Feed: TW-HOME (TProxy weave_out) -> Burst-Harvest Pool
  if (dom.y - tun.bottom > 6) {
    const gWeave = makeBezier(tun.cx, tun.bottom, dom.cx, dom.y, false);
    drawContinuousLightRibbon(ctx, gWeave, '170, 142, 240', waveState[3], 0.12, 'weave_out');
  }

  // Stage 3 Vertical Convergence: 3-Band HTB QoS -> 21-Uplink NAT & Egress
  if (up.y - qos.bottom > 6) {
    const gOut = makeBezier(qos.cx, qos.bottom, up.cx, up.y, false);
    drawContinuousLightRibbon(ctx, gOut, '240, 202, 104', waveState[4], 0.30, '21 WAN NAT');
  }

  // Horizontal Organic Optical Channels (Desktop / Multi-Column Mode)
  if (vip.x - ing.right > 16) {
    const fanTopY = ing.y + ing.h * 0.24;
    const fanMidY = ing.y + ing.h * 0.50;
    const fanBotY = ing.y + ing.h * 0.76;

    drawContinuousLightRibbon(ctx, makeBezier(ing.right, fanTopY, vip.x, vip.cy, true), '100, 174, 245', waveState[0], 0.00);
    drawContinuousLightRibbon(ctx, makeBezier(ing.right, fanMidY, tun.x, tun.cy, true), '170, 142, 240', waveState[1], 0.16);
    drawContinuousLightRibbon(ctx, makeBezier(ing.right, fanBotY, dom.x, dom.cy, true), '87, 209, 146',  waveState[2], 0.32);

    if (qos.x - tun.right > 16) {
      const y10 = q10 ? q10.cy : (qos.y + qos.h * 0.30);
      const y20 = q20 ? q20.cy : (qos.y + qos.h * 0.55);
      const y30 = q30 ? q30.cy : (qos.y + qos.h * 0.80);

      drawContinuousLightRibbon(ctx, makeBezier(vip.right, vip.cy, qos.x, y10, true), '100, 174, 245', waveState[0], 0.24);
      drawContinuousLightRibbon(ctx, makeBezier(tun.right, tun.cy, qos.x, y20, true), '170, 142, 240', waveState[1], 0.38);
      drawContinuousLightRibbon(ctx, makeBezier(dom.right, dom.cy, qos.x, y30, true), '87, 209, 146',  waveState[2], 0.52);
    }
  }

  ctx.restore();
}

function stepAnimation(now) {
  if (S.tab !== 'blueprint' || document.visibilityState === 'hidden') {
    rafId = null;
    lastFrameTs = 0;
    return;
  }

  const dt = lastFrameTs ? Math.min(0.08, (now - lastFrameTs) / 1000) : 0.016;
  lastFrameTs = now;

  for (let k = 0; k < waveState.length; k++) {
    const b = waveState[k];
    b.vel += (b.targetVel - b.vel) * 0.1;
    b.glow += (b.targetGlow - b.glow) * 0.1;
    b.phase = (b.phase + b.vel * dt) % 1.0;
  }

  renderWaveguidesCanvas();
  rafId = requestAnimationFrame(stepAnimation);
}

export function startBlueprintAnim() {
  if (S.tab !== 'blueprint' || document.visibilityState === 'hidden') return;
  if (!rafId) {
    lastFrameTs = 0;
    rafId = requestAnimationFrame(stepAnimation);
  }
}

export function stopBlueprintAnim() {
  if (rafId) {
    cancelAnimationFrame(rafId);
    rafId = null;
    lastFrameTs = 0;
  }
}

export function closeSysModal() {
  drawerOpen = false;
  $('#sys-modal-scrim')?.classList.remove('open');
}

function updateFlowPhysics(st) {
  const totalRate = (st.rate || 0) + (st.rate_up || 0);
  const vipS = (st.strands || []).find(s => s.vip);
  const vipBps = vipS ? ((vipS.now ?? vipS.rate ?? 0) + (vipS.up_now ?? vipS.up ?? 0)) : 0;

  const rules = S.rules?.rules || [];
  let totPkts = 0, quicPkts = 0, tunPkts = 0, domPkts = 0, tunBytes = 0, domBytes = 0;
  for (const r of rules) {
    const p = r.packets || 0;
    const b = r.bytes || 0;
    totPkts += p;
    if (r.tag === 'quic') quicPkts += p;
    if (r.tag.includes('tunnel') || r.tag === 'rest-tunnel') {
      tunPkts += p;
      tunBytes += b;
    } else if (r.tag === 'domestic' || r.tag === 'domestic-domain' || r.tag === 'device-direct' || r.tag === 'rest-direct' || r.tag === 'relay') {
      domPkts += p;
      domBytes += b;
    }
  }

  const nowMs = performance.now();
  if (rules.length > 0) {
    if (prevRuleSample && (nowMs - prevRuleSample.ts) >= 400 && tunBytes >= prevRuleSample.tunBytes) {
      const dtSec = (nowMs - prevRuleSample.ts) / 1000;
      liveFlow.tunBps = (tunBytes - prevRuleSample.tunBytes) / dtSec;
      liveFlow.domBps = Math.max(0, (domBytes - prevRuleSample.domBytes) / dtSec);
    } else if (!prevRuleSample && totPkts > 0) {
      const share = tunPkts / totPkts;
      liveFlow.tunBps = Math.max(0, totalRate - vipBps) * share;
      liveFlow.domBps = Math.max(0, totalRate - vipBps) * (1 - share);
    }
    if (!prevRuleSample || (nowMs - prevRuleSample.ts) >= 400 || tunBytes < prevRuleSample.tunBytes) {
      prevRuleSample = { ts: nowMs, tunBytes, domBytes };
    }
  }

  liveFlow.vipBps = vipBps;
  liveFlow.totPkts = totPkts;
  liveFlow.quicPkts = quicPkts;
  liveFlow.tunPkts = tunPkts;
  liveFlow.domPkts = domPkts;
  liveFlow.tunShare = totPkts > 0 ? tunPkts / totPkts : 0;

  const weaveBps = Math.max(liveFlow.domBps, Math.max(0, totalRate - vipBps));
  const rates = [
    vipS && vipS.healthy ? vipBps : -1,
    st.tunnel?.on && st.tunnel?.running ? liveFlow.tunBps : -1,
    st.healthy_count > 0 ? weaveBps : -1,
    st.tunnel?.on && st.tunnel?.running ? liveFlow.tunBps : -1,
    totalRate
  ];

  for (let k = 0; k < waveState.length; k++) {
    const bps = rates[k];
    const b = waveState[k];
    if (bps < 0) {
      b.targetVel = 0;
      b.targetGlow = 0.08;
      b.width = 1.6;
    } else {
      const mbps = (bps * 8) / 1e6;
      if (mbps < 0.01) {
        b.targetVel = 0.24;
        b.targetGlow = 0.42;
        b.width = 2.1;
      } else {
        const logF = Math.log10(1 + mbps * 6);
        b.targetVel = Math.min(1.25, 0.30 + logF * 0.42);
        b.targetGlow = Math.min(1.0, 0.56 + logF * 0.28);
        b.width = Math.min(3.5, 2.2 + logF * 0.65);
      }
    }
  }
}

function renderClassifyStrip() {
  const grid = $('#bp-classify-grid');
  if (!grid) return;
  const rules = S.rules?.rules || [];
  if (!rules.length) {
    grid.innerHTML = '<span class="c-muted" style="font-size:11px">等待 nftables classify 計數...</span>';
    return;
  }

  const tot = Math.max(1, rules.reduce((acc, r) => acc + (r.packets || 0), 0));
  const coreSet = new Set(['quic', 'device-direct', 'tunnel-range', 'domestic', 'rest-tunnel']);
  const visible = rules
    .filter(r => (r.packets || 0) > 0 || coreSet.has(r.tag))
    .sort((a, b) => (b.packets || 0) - (a.packets || 0));

  const frag = document.createDocumentFragment();
  for (const r of visible) {
    const label = RULE_LABELS[r.tag] || r.tag;
    const pkts = r.packets || 0;
    const share = (pkts / tot) * 100;
    const fillPct = pkts > 0 ? Math.min(100, Math.max(6, Math.pow(share / 100, 0.58) * 100)) : 0;

    let colorHex = 'var(--c-mint)';
    let colorRgb = '87, 209, 146';
    let textCls = 'c-mint';
    if (r.tag.includes('tunnel') || r.tag === 'rest-tunnel') {
      colorHex = 'var(--c-violet)';
      colorRgb = '170, 142, 240';
      textCls = 'c-violet';
    } else if (r.tag === 'device-game') {
      colorHex = 'var(--c-blue)';
      colorRgb = '100, 174, 245';
      textCls = 'c-blue';
    } else if (r.tag === 'quic') {
      colorHex = 'var(--c-amber)';
      colorRgb = '235, 154, 94';
      textCls = 'c-amber';
    } else if (r.tag === 'device-block') {
      colorHex = 'var(--c-crimson)';
      colorRgb = '230, 108, 120';
      textCls = 'c-crimson';
    }

    const pktTxt = pkts >= 1000 ? `${(pkts / 1000).toFixed(1)}k` : `${pkts}`;
    const pctTxt = pkts > 0 ? (share >= 1 ? `${Math.round(share)}%` : `${share.toFixed(1)}%`) : '0%';

    const fillEl = el('div', {
      class: 'classify-bar-fill',
      style: {
        width: `${fillPct.toFixed(1)}%`,
        background: colorHex,
        boxShadow: pkts > 0 ? `0 0 10px rgba(${colorRgb}, 0.72), 0 0 22px rgba(${colorRgb}, 0.34)` : 'none'
      }
    });

    frag.appendChild(el('div', {
      class: `classify-bar-card ${pkts > 0 ? 'active' : ''}`,
      style: { '--cb-rgb': colorRgb }
    },
      el('div', { class: 'classify-bar-head' },
        el('span', { class: pkts > 0 ? 'c-bright' : 'c-muted', style: { fontWeight: pkts > 0 ? '600' : '400', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', minWidth: '0' } }, label),
        el('span', { class: pkts > 0 ? textCls : 'c-muted', style: { fontVariantNumeric: 'tabular-nums', fontWeight: '600', whiteSpace: 'nowrap', fontSize: '9.5px' } }, `${pktTxt}·${pctTxt}`)
      ),
      el('div', { class: 'classify-bar-track' }, fillEl)
    ));
  }
  grid.innerHTML = '';
  grid.appendChild(frag);
}

function renderMiniSpectrum(strands) {
  const bar = $('#bp-mini-spectrum');
  if (!bar || !strands.length) return;
  if (bar.children.length !== strands.length) {
    bar.innerHTML = '';
    strands.forEach((s, idx) => {
      const col = spectralColor(idx, strands.length);
      bar.appendChild(el('span', {
        class: 'mini-sp-cell',
        style: { backgroundColor: col.css }
      }));
    });
  }
  for (let i = 0; i < strands.length; i++) {
    const s = strands[i];
    const cell = bar.children[i];
    if (!cell) continue;
    const col = spectralColor(i, strands.length);
    if (!s.healthy) {
      cell.style.backgroundColor = 'rgba(230, 108, 120, 0.35)';
      cell.style.boxShadow = 'none';
      cell.style.opacity = '0.45';
    } else {
      cell.style.backgroundColor = col.css;
      const pct = (s.tokens_pct ?? 100) / 100;
      const active = (s.now ?? s.rate ?? 0) > 2000;
      cell.style.opacity = String(0.36 + pct * 0.64);
      cell.style.boxShadow = active ? `0 0 8px ${col.css}` : 'none';
    }
  }
}

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

  const openSysModal = async () => {
    drawerOpen = true;
    $('#sys-modal-scrim')?.classList.add('open');
    if (S.session && !S.config) {
      try { S.config = await call('config'); } catch (_) {}
    }
    renderBlueprintDrawer();
  };

  $('#btn-toggle-sys')?.addEventListener('click', openSysModal);
  $('#btn-close-sys')?.addEventListener('click', closeSysModal);
  $('#sys-modal-scrim')?.addEventListener('click', (e) => {
    if (e.target.id === 'sys-modal-scrim') closeSysModal();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && drawerOpen) closeSysModal();
  });
}

export function renderBlueprint() {
  const st = S.status;
  if (!st) return;

  updateFlowPhysics(st);
  startBlueprintAnim();

  const w = st.weave || {};
  const tun = S.tunnel;
  const nH = Math.max(1, st.healthy_count || st.strand_count || 21);
  const totalRate = (st.rate || 0) + (st.rate_up || 0);
  const strands = st.strands || [];

  const mptcpBadge = $('#bp-mptcp-badge');
  if (mptcpBadge) {
    const mp = st.mptcp;
    if (mp?.enabled) {
      mptcpBadge.className = 'st-badge charged';
      mptcpBadge.textContent = `MPTCP · ${mp.subflows} subflows · ${mp.endpoints?.length || 0} ep`;
    } else {
      mptcpBadge.className = 'st-badge draining';
      mptcpBadge.textContent = 'MPTCP · standby';
    }
  }

  // Left Guard Rail
  const canaryMs = st.tunnel?.canary_ms || 0;
  $('#adv-verdict').textContent = st.ok ? 'zero-leak verified' : (st.fail?.join(', ') || 'check failed');
  $('#adv-verdict').className = `v ${st.ok ? 'c-mint' : 'c-crimson'}`;
  $('#adv-canary').textContent = canaryMs > 0 ? `${canaryMs} ms` : (st.tunnel?.on ? 'active' : 'off');
  $('#adv-ct').textContent = `${st.sys?.conntrack?.count ?? 0}`;
  $('#adv-strands').textContent = `${st.healthy_count ?? 0}/${st.strand_count ?? 21}`;

  const dnsEl = $('#adv-dns');
  if (dnsEl) {
    dnsEl.textContent = st.dns?.smartdns ? `53 → ${st.dns.port || 6053}` : 'offline';
    dnsEl.className = `v ${st.dns?.smartdns ? 'c-mint' : 'c-crimson'}`;
  }
  $('#adv-doctor').textContent = st.ok
    ? `all ${S.doctor?.checks?.length || 41} invariants ok`
    : `${st.fail?.length || 1} fail · ${st.warn?.length || 0} warn`;

  const evList = S.events?.events || [];
  if ($('#log-count')) $('#log-count').textContent = `${evList.length} 條`;
  renderSessionLog($('#ov-session-log'), evList, 35);

  // Tier 1A: Pre-Gate & SmartDNS
  $('#bp-quic-pkts').textContent = liveFlow.quicPkts >= 1000
    ? `${(liveFlow.quicPkts / 1000).toFixed(1)}k pkts`
    : `${liveFlow.quicPkts} pkts`;
  const sz = S.rules?.sizes || {};
  $('#bp-dns-st').textContent = `SmartDNS :${st.dns?.port || 6053} · dom ${sz.domestic4 ?? 0} · cn ${sz.domestic4_dns ?? 0} · tun ${sz.tunnel4_dns ?? 0}`;

  const chargedRatio = (w.charged_count || 0) / nH;
  renderSegMeter($('#bp-harvest-meter'), chargedRatio, 10, 'spectrum');
  $('#bp-harvest-txt').textContent = `${w.policy || 'harvest'} ${Math.round(chargedRatio * 100)}%`;

  const curMode = st.settings?.['strands.aggregate'] || st.site?.mode || 'auto';
  $$('#site-mode-seg .seg-btn').forEach(b => b.classList.toggle('on', b.dataset.mode === curMode));

  const memBtn = $('#site-mem-btn');
  if (memBtn) {
    if (!st.site?.gateway) {
      memBtn.disabled = true;
      memBtn.textContent = '無網關';
    } else if (st.site?.known) {
      memBtn.disabled = false;
      memBtn.textContent = `忘記: ${st.site.name}`;
    } else {
      memBtn.disabled = false;
      memBtn.textContent = '記住站點';
    }
  }

  // Tier 1B: Nftables Classify Engine
  $('#bp-ingress-rate').textContent = fmtRate(totalRate).full;
  $('#bp-ingress-pkts').textContent = `${(liveFlow.totPkts / 1000).toFixed(1)}k pkts`;
  renderClassifyStrip();

  // Tier 2 · Branch 0: @vip_lane
  const vipS = strands.find(s => s.vip);
  $('#bp-vip-rate').textContent = vipS ? fmtRate(liveFlow.vipBps).full : '0 bps';
  const vipTok = vipS ? (vipS.tokens_pct ?? 100) / 100 : 0;
  renderSegMeter($('#bp-vip-meter'), vipTok, 10, 'blue');
  $('#bp-vip-pct').textContent = vipS ? `${Math.round(vipTok * 100)}%` : 'none';
  $('#bp-vip-desc').textContent = vipS
    ? `${vipS.dev} · τ=${vipS.ttfb_ms || '—'}ms · loss ${vipS.loss_pct ?? 0}%`
    : 'auto selecting lowest RTT strand...';
  $('#bp-vip-st').textContent = vipS && vipS.healthy ? 'dedicated lane pinned' : 'standby';

  // Tier 2 · Branch 1: TW-HOME Mihomo + MPTCP + Zashboard
  const mihomoOk = !!st.tunnel?.running;
  $('#bp-tun-rate').textContent = mihomoOk ? fmtRate(liveFlow.tunBps).full : '0 bps';
  renderSegMeter($('#bp-tun-meter'), mihomoOk ? Math.max(0.08, liveFlow.tunShare) : 0, 10, mihomoOk ? 'violet' : 'amber');
  $('#bp-tun-pct').textContent = mihomoOk ? `${Math.round(liveFlow.tunShare * 100)}%` : '0%';
  $('#bp-tun-desc').textContent = `主力: ${(tun?.tw_home || tun?.selected || 'TW-HOME').slice(0, 24)} · ${(liveFlow.tunPkts / 1000).toFixed(1)}k`;
  const mptcpEl = $('#bp-tun-mptcp');
  if (mptcpEl) {
    mptcpEl.textContent = st.mptcp?.enabled
      ? `MPTCP ${st.mptcp.subflows} subflows → weave_out`
      : 'MPTCP single-path → weave_out';
  }
  $('#bp-tun-st').textContent = mihomoOk ? (canaryMs > 0 ? `canary ${canaryMs} ms ok` : 'cage encrypted') : 'offline / direct';
  const zBtn = $('#zashboard-link');
  if (zBtn) {
    zBtn.href = tun?.dashboard || `http://${st.lan_ip || location.hostname || '192.168.16.1'}:9090/ui/`;
  }

  // Tier 2 · Branch 2: Domestic Direct + Burst-Harvest
  const directShare = Math.max(0, 1 - liveFlow.tunShare);
  const weaveRate = Math.max(liveFlow.domBps, Math.max(0, totalRate - liveFlow.vipBps));
  $('#bp-dom-rate').textContent = fmtRate(weaveRate).full;
  renderSegMeter($('#bp-dom-meter'), chargedRatio, 10, 'mint');
  $('#bp-dom-pct').textContent = `${w.charged_count ?? 0}/${nH}`;
  renderMiniSpectrum(strands);
  $('#bp-dom-desc').textContent = `slots ${w.slots ?? 126} (${w.affinity || 'flow'}) · direct ${(liveFlow.domPkts / 1000).toFixed(1)}k (${Math.round(directShare * 100)}%)`;
  $('#bp-dom-st').textContent = `${w.charged_count ?? 0} charged · ${w.draining_count ?? 0} drain · ${(w.cooling_count || 0) + (w.depleted_count || 0)} cool`;

  // Tier 3: Physical 21-Uplink Summary
  $('#bp-verify-summary').textContent = st.ok
    ? `21/21 鏈路在線 · 內存 ${Math.round((st.sys?.mem_available_kb || 0) / 1024)} MB · load ${st.sys?.load1 ?? 0}`
    : `異常: ${(st.fail || []).join(', ')}`;

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
          el('div', { class: 'c-muted', style: { fontSize: '10.5px' } }, desc)
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
        type: 'button',
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
        type: 'button',
        class: 'btn-cmd',
        onClick: () => write('configure', { set: { [spec.key]: Number(inp.value) } }, `${spec.key} = ${inp.value}`)
      }, '套用');
      control = el('div', { style: { display: 'flex', gap: '6px' } }, inp, save);
    }
    cp.appendChild(el('div', { class: 'cfg-row' },
      el('div', {},
        el('div', { class: 'c-bright' }, spec.key),
        el('div', { class: 'c-muted', style: { fontSize: '10.5px' } }, spec.label)
      ),
      control
    ));
  }
}
