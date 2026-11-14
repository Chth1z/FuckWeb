/**
 * Braid 5.0 Optical Weave — State Store, Constants, Spectral Math & Formatters
 */

export const UI_VERSION = "5.0.0";
export const ANON = "00000000000000000000000000000000";
export const QUIET = 125000; // 1 Mbit/s baseline reference in bytes/s

export const PAGES = {
	overview: "01 · 總覽 PRISM",
	strands: "02 · 線路 STRANDS",
	devices: "03 · 設備 TERMINALS",
	connections: "04 · 連接 FLOWS",
	tunnel: "05 · 隧道與分流 CAGE",
	system: "06 · 系統自檢 DOCTOR",
};

export const POLICY_OPTS = [
	["auto", "AUTO · 智能分流 (國內直連/海外家寬/UDP遊戲VIP)"],
	["game", "GAME · 電競 VIP 專線 (0x100 低延遲獨享)"],
	["direct", "DIRECT · 強制多線直連"],
	["tunnel", "TUNNEL · 強制台灣家寬隧道"],
	["block", "BLOCK · 阻斷外網訪問"],
];

export const RULE_META = {
	"device-block": ["被設為「BLOCK 禁網」的終端", "DROP 阻斷", "crimson"],
	"device-direct": ["被設為「DIRECT 直連」的終端", "DIRECT 直連", "blue"],
	"relay": ["發往台灣家寬前置中繼自身的加密流", "DIRECT 直連", "blue"],
	"device-tunnel": ["被設為「TUNNEL 代理」的終端", "TUNNEL 台灣家寬", "violet"],
	"tunnel-range": ["目標 IP 命中強制隧道網段 (@tunnel4)", "TUNNEL 台灣家寬", "violet"],
	"tunnel-domain": ["目標域名命中強制隧道集合 (@tunnel4_dns)", "TUNNEL 台灣家寬", "violet"],
	"tunnel-port": ["NTP 時間同步端口 (UDP 123)", "TUNNEL 台灣家寬", "violet"],
	"domestic": ["目標 IP 屬於中國大陸網段 (@domestic4)", "DIRECT 直連", "blue"],
	"quic": ["HTTP/3 QUIC (UDP 443) 強制降級為 TCP+BBR", "REJECT 拒絕", "amber"],
	"rest-tunnel": ["其餘所有海外與未知流量 (classify.remainder)", "TUNNEL 台灣家寬", "violet"],
	"rest-direct": ["其餘所有流量 (直連模式)", "DIRECT 直連", "blue"],
};

export const CHECK_DESC = {
	strands_healthy: ["物理與虛擬 WAN 線路連通性", "檢查 WAN 網線或重新登錄 Portal"],
	strands_low: ["健康 WAN 線路數量充足度", "部分線路認證過期，系統會自動重登或點「重新認證 Portal」"],
	strands_masq: ["WAN 防火牆 NAT 偽裝區完整性", "執行立即調諧修復防火牆綁定"],
	tunnel_running: ["mihomo 隧道守護進程狀態", "系統將自動拉起 mihomo 進程"],
	tunnel_relays: ["台灣家寬中繼節點配置完整性", "檢查 /etc/braid/relays.json"],
	tunnel_fail_open: ["防漏死鎖模式 (Fail-Closed)", "已硬件鎖死為零洩漏模式"],
	tunnel_canary: ["台灣家寬金絲雀端到端探測", "驗證通過台灣住宅出口訪問外部網路"],
	tunnel_divert: ["nftables TPROXY 透明劫持規則", "執行立即調諧同步內核表"],
	smartdns: ["SmartDNS 本地雙棧解析器進程", "監聽 :6053 分流解析國內外域名"],
	smartdns_responsive: ["SmartDNS 實時解析響應測試", "無響應時 braidd 會自動重啟 SmartDNS"],
	dns_forward: ["dnsmasq 上游轉發至 SmartDNS", "確保所有 LAN DNS 查詢受控並填充 @tunnel4_dns"],
	dhcp_listen: ["LAN DHCP 服務監聽狀態", "為局域網終端分配 192.168.16.0/24 地址"],
	uplink_carrier: ["物理 WAN 口網線載波信號", "檢查光貓或交換機網線連接"],
	shaper: ["HTB + fq_codel 優先級流量整形器", "優先保障 1:10 VIP 遊戲包零排隊"],
	nft_table: ["內核 inet braid 規則表完整性", "包含 126 槽位 @pattern、@vip_lane 與 0x20000000 牢籠"],
	overlay_space: ["路由器 Flash 可用存儲空間", "保留足夠空間供配置與狀態寫入"],
	secret_perms: ["敏感憑證文件權限最小化", "確保 0600 權限"],
	ssh_public: ["SSH 管理端口僅限局域網訪問", "防止公網暴力破解"],
	http_public: ["Web 管理介面僅限局域網訪問", "防止公網未授權探測"],
};

export const S = {
	sid: sessionStorage.getItem("braid.sid") || ANON,
	page: "overview",
	status: null,
	series: { ts: [], total: [], up: [], strands: {}, strands_up: {} },
	doctor: null,
	events: [],
	tunnel: null,
	devices: [],
	rules: null,
	config: null,
	conns: [],
	connPrev: {},
	connAt: 0,
	connRoute: "all",
	hover: null,
	editing: false,
	seeded: false,
	interval: 2,
};

export function strandHue(idx, total = 21) {
	const t = total > 1 ? idx / (total - 1) : 0;
	return Math.round(4 + t * 268);
}

export function strandColor(idx, total = 21, alpha = 1, light = 58) {
	const h = strandHue(idx, total);
	return `hsla(${h}, 90%, ${light}%, ${alpha})`;
}

export function strandWavelengthNm(idx, total = 21) {
	const t = total > 1 ? idx / (total - 1) : 0;
	return Math.round(655 - t * 250);
}

export function rateParts(bytesPerSec) {
	const bits = Math.max(0, bytesPerSec || 0) * 8;
	if (bits >= 1e6) return [(bits / 1e6).toFixed(bits >= 1e8 ? 0 : bits >= 1e7 ? 1 : 2), "Mbit/s"];
	if (bits >= 1e3) return [(bits / 1e3).toFixed(bits >= 1e5 ? 0 : 1), "kbit/s"];
	return [bits.toFixed(0), "bit/s"];
}

export const rateText = (b) => rateParts(b).join(" ");

export function sizeText(bytes) {
	const u = ["B", "KB", "MB", "GB", "TB"];
	let i = 0;
	let v = Math.max(0, bytes || 0);
	while (v >= 1024 && i < 4) {
		v /= 1024;
		i++;
	}
	return v.toFixed(i && v < 100 ? 1 : 0) + " " + u[i];
}

export function countText(n) {
	const v = n || 0;
	if (v >= 1e9) return (v / 1e9).toFixed(1) + "G";
	if (v >= 1e6) return (v / 1e6).toFixed(1) + "M";
	if (v >= 1e3) return (v / 1e3).toFixed(1) + "k";
	return String(v);
}

export const clockText = (ts) => new Date(ts * 1000).toLocaleTimeString("zh-CN", { hour12: false });

export function agoText(ts) {
	if (!ts) return "—";
	const d = Math.max(0, Math.round(Date.now() / 1000 - ts));
	if (d < 60) return d + "s ago";
	if (d < 3600) return Math.round(d / 60) + "m ago";
	return Math.round(d / 3600) + "h ago";
}

export function niceStep(v) {
	const p = Math.pow(10, Math.floor(Math.log10(v || 1)));
	for (const m of [0.25, 0.5, 1, 2.5, 5, 10]) {
		if (v / (m * p) <= 4) return m * p;
	}
	return 10 * p;
}

export function asciiBlocks(pct, cells = 10) {
	const filled = Math.round((Math.max(0, Math.min(100, pct)) / 100) * cells);
	return "█".repeat(filled) + "░".repeat(Math.max(0, cells - filled));
}

export function deviceName(ip) {
	const d = S.devices.find((x) => x.ip === ip);
	return d ? (d.name || d.host || ip) : ip;
}
