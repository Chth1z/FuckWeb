/* ============================================================================
 * PRISM 5.0 — Central State Store, DSOTM Spectral Color Math & Formatters
 * ============================================================================ */

export const UI_VERSION = '5.4.1';

export const S = {
  tab: 'overview',
  session: localStorage.getItem('prism_session') || '',
  user: localStorage.getItem('prism_user') || '',
  status: null,
  series: null,
  events: null,
  doctor: null,
  tunnel: null,
  devices: null,
  rules: null,
  config: null,
  connections: null,
  hoverStrand: null,
  pinnedStrandId: null,
  selectedDeviceMac: 'all',
  devMenuQuery: '',
  devSort: 'stable',
  connFilter: { route: 'all', q: '' },
  flowSnapshot: {},
  flowSnapshotTs: 0,
  hitBoxes: [],
  topoPointer: { x: -1, y: -1 },
  // Smoothly interpolated visual state per strand index for zero-jitter rendering
  bandSmooth: []
};

export const LOCKED_SPECS = [
  ['weave.policy',       'harvest', 'Burst-Harvest 2.0 脈衝收割'],
  ['weave.affinity',     'flow',    'Per-Flow 跨線鋪開'],
  ['classify.remainder', 'tunnel',  '海外全閉鎖入 TW-HOME'],
  ['classify.quic',      'reject',  'UDP 443 1ms 回退 TCP'],
  ['tunnel.enabled',     '1',       'Mihomo TProxy 常駐'],
  ['tunnel.fail_open',   '0',       'Fail-Closed 嚴禁直連回退']
];

export const EDITABLE_SPECS = [
  { key: 'strands.probe_interval', label: '探針週期 (s)', type: 'number', min: 30, max: 3600 },
  { key: 'weave.slots',            label: '槽位總數 (0=自動)', type: 'number', min: 0, max: 252 },
  { key: 'weave.strand_kbit',      label: '單線上限 (kbps)', type: 'number', min: 0, max: 1000000 },
  { key: 'dns.ads',                label: 'SmartDNS 廣告攔截', type: 'bool' },
  { key: 'main.mss',               label: 'TCP MSS 鉗制', type: 'number', min: 0, max: 1460 }
];

// Classic Pink Floyd "The Dark Side of the Moon" 6-stop dispersion spectrum:
// Top (idx=0, least refracted, 700nm) = Red -> Orange -> Yellow -> Green -> Cyan/Blue -> Violet (idx=N-1, most refracted, 380nm)
const DSOTM_STOPS = [
  [238,  52,  46], // Red
  [244, 124,  38], // Orange
  [247, 212,  46], // Yellow
  [ 68, 198,  92], // Green
  [ 48, 166, 238], // Blue
  [144,  82, 228]  // Violet
];

export function spectralColor(idx, total) {
  const t = Math.max(0, Math.min(1, idx / Math.max(1, total - 1)));
  const scaled = t * (DSOTM_STOPS.length - 1);
  const i = Math.min(DSOTM_STOPS.length - 2, Math.floor(scaled));
  const f = scaled - i;
  const a = DSOTM_STOPS[i];
  const b = DSOTM_STOPS[i + 1];
  const r = Math.round(a[0] + (b[0] - a[0]) * f);
  const g = Math.round(a[1] + (b[1] - a[1]) * f);
  const bl = Math.round(a[2] + (b[2] - a[2]) * f);
  const lambda = Math.round(700 - t * 320); // 700nm (Red) -> 380nm (Violet)
  return {
    r, g, b: bl, lambda,
    rgb: `${r}, ${g}, ${bl}`,
    css: `rgb(${r}, ${g}, ${bl})`
  };
}

export function fmtRate(bytesPerSec) {
  const bps = Math.max(0, (bytesPerSec || 0) * 8);
  if (bps < 1000) return { num: bps.toFixed(0), unit: 'bps', full: bps.toFixed(0) + ' bps' };
  const kbps = bps / 1000;
  if (kbps < 1000) return { num: kbps < 10 ? kbps.toFixed(1) : kbps.toFixed(0), unit: 'Kbps', full: (kbps < 10 ? kbps.toFixed(1) : kbps.toFixed(0)) + ' Kbps' };
  const mbps = kbps / 1000;
  if (mbps < 1000) return { num: mbps < 10 ? mbps.toFixed(2) : mbps.toFixed(1), unit: 'Mbps', full: (mbps < 10 ? mbps.toFixed(2) : mbps.toFixed(1)) + ' Mbps' };
  const gbps = mbps / 1000;
  return { num: gbps.toFixed(2), unit: 'Gbps', full: gbps.toFixed(2) + ' Gbps' };
}

export function fmtBytes(bytes) {
  const b = Math.max(0, bytes || 0);
  if (b < 1024) return b + ' B';
  const kb = b / 1024;
  if (kb < 1024) return kb.toFixed(1) + ' KB';
  const mb = kb / 1024;
  if (mb < 1024) return mb.toFixed(1) + ' MB';
  const gb = mb / 1024;
  return gb.toFixed(2) + ' GB';
}

export function fmtClock(ts) {
  if (!ts) return '--:--:--';
  const d = new Date(ts * 1000);
  const pad = (n) => String(n).padStart(2, '0');
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}
