# Prism 5.8 — Frontend HTTP / ubus API Specification

This document defines the complete backend API contract exposed by `prismd` (`usr/share/prism/mod/api.uc`) over OpenWrt `uhttpd-mod-ubus` (`POST /ubus`). It is designed as the authoritative reference for the modular `/www/prism/` frontend (`index.html`, `css/`, `js/`).

---

## 1. Transport & Authentication Protocol

All requests are sent as HTTP `POST` to `/ubus` with `Content-Type: application/json` using JSON-RPC 2.0.

### 1.1 Request Envelope
```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "method": "call",
  "params": [
    "<session_token>",
    "prism",
    "<method_name>",
    { ...args }
  ]
}
```
- **Anonymous Session Token** (for public LAN read endpoints):
  `"00000000000000000000000000000000"`
- **Authenticated Session Token** (for `config`, `connections`, and all write methods):
  Obtained via standard OpenWrt `session.login`:
  ```json
  {
    "jsonrpc": "2.0",
    "id": 1,
    "method": "call",
    "params": [
      "00000000000000000000000000000000",
      "session",
      "login",
      { "username": "root", "password": "<password>", "timeout": 3600 }
    ]
  }
  ```
  Successful login returns `result: [0, { "ubus_rpc_session": "<token>", ... }]`.

### 1.2 Response Envelope
```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "result": [
    0,
    { ...payload }
  ]
}
```
- `result[0] === 0` indicates ubus transport success; `result[1]` is the JSON payload returned by `prism`.
- `result[0] === 6` (`UBUS_STATUS_PERMISSION_DENIED`) indicates the session token is missing or expired for a protected method.
- JSON-RPC batching (sending an array of RPC objects in a single `POST /ubus`) is natively supported by `uhttpd-mod-ubus` and should be used when polling multiple endpoints simultaneously.

---

## 2. Permission Matrix (`/usr/share/rpcd/acl.d/prism.json`)

| Category | Methods | Auth Required |
|---|---|---|
| **Public Read** | `status`, `series`, `devices`, `tunnel`, `doctor`, `rules`, `events`, `led_view` | No (`0000...0000`) |
| **Private Read** | `config`, `connections` | Yes (`prism-admin`) |
| **Write Actions** | `reconcile`, `configure`, `device`, `select`, `relogin`, `remember`, `forget`, `claim`, `reload`, `led_demo`, `led_color` | Yes (`prism-admin`) |

---

## 3. Read Endpoints & TypeScript Schemas

### 3.1 `status` — Global Snapshot, 21 Strands, Token Buckets & Weave State
- **Args**: `{}`
- **Cadence**: Updated every `1` second by `prismd` (`weave.interval = 1`, historical `series` sampled every `2` seconds), with a 45-second reconciliation timer. Device rates, class counters and controller snapshots update every four seconds at the default sampling interval.

```typescript
interface PrismStatusResponse {
  version: string;          // "5.8.1"
  ts: number;               // Current Unix timestamp (seconds)
  reconciled: number;       // Timestamp of last full `prism reconcile` pass
  ok: boolean;              // True if all `fail`-level doctor checks pass
  fail: string[];           // IDs of failing critical checks (empty when healthy)
  warn: string[];           // IDs of warning checks
  led: "green" | "yellow" | "orange" | "red";
  led_state: {              // Live optical LED engine state & sysfs hardware readout
    mode: "prism" | "aurora" | "tunnel" | "netdev" | "stealth" | "off";
    bright: number;
    night_dim: number;
    alert: string;
    quarantine: number;
    demo: boolean;
    status_rgb: number[];
    network_rgb: number[];
    status_hex: string;
    network_hex: string;
    status_bright: number;
    network_bright: number;
    status_trig: string;
    network_trig: string;
    hw: { status: object | null; network: object | null };
  };
  lan_ip: string;           // Router LAN IPv4, e.g. "192.168.16.1"
  role: "primary" | "backup" | "none";

  // Aggregate strand counts & throughput
  strand_count: number;     // Total discovered strands (typically 21: wan + vwan1..vwan20)
  healthy_count: number;    // Number of healthy strands carrying traffic (e.g. 21)
  rate: number;             // Total instantaneous download rate across all strands (bytes/s)
  rate_up: number;          // Total instantaneous upload rate across all strands (bytes/s)
  rate_ewma: number;        // Total EWMA-smoothed download rate (bytes/s)
  rate_up_ewma: number;     // Total EWMA-smoothed upload rate (bytes/s)
  rate_peak: number;        // Rolling history peak download rate (bytes/s)
  down_bytes: number;       // Cumulative download bytes across all strands
  up_bytes: number;         // Cumulative upload bytes across all strands

  // Upstream site recognition (by gateway MAC)
  site: {
    known: boolean;         // True if upstream gateway MAC matches a saved `config site`
    name: string;           // Site display name, e.g. "linkbroad"
    gateway: string;        // Upstream gateway MAC address, e.g. "00:e0:fc:..."
    aggregate: boolean;     // Whether multi-MAC aggregation is currently active
    mode: "auto" | "on" | "off";
    portal: string;         // Portal plugin name, e.g. "linkbroad" or ""
  };

  // Per-strand live state (ordered naturally: wan, vwan1, vwan2, ..., vwan20)
  strands: StrandStatus[];

  // Weave & Burst-Harvest 2.0 scheduler state
  weave: {
    policy: "harvest" | "headroom" | "even";
    affinity: "flow" | "auto" | "dest";
    slots: number;          // Pattern length, typically 126 (6 * 21)
    interval: number;       // Sampling & re-weaving interval in seconds (1)
    pattern: number[];      // Array of `slots` strand IDs (1..21) currently in `@pattern`
    vip: number[];          // Raw `@vip_lane` kernel map values: `[vip_id | 0x100, vip_id | 0x100]`
    vip_id: number;         // Strand ID (1..21) currently elected as the dedicated VIP gaming lane
    vip_dev: string;        // Device name of current VIP strand, e.g. "vwan4"
    charged_count: number;  // Count of healthy strands in "charged" state
    draining_count: number; // Count of healthy strands in "draining" state
    depleted_count: number; // Count of healthy strands in "depleted" state
    cooling_count: number;  // Count of healthy strands in "cooling" state
  };

  // Mihomo tunnel summary
  tunnel: {
    enabled: boolean;       // Always true (locked)
    running: boolean;       // True if mihomo process is alive and tproxy port is bound
    on: boolean;            // True if nftables is diverting non-domestic traffic to mihomo
    restored: boolean;      // True once saved per-device relay selections are restored in RAM
    pid: string;            // Live mihomo PID string
    mixed_port: number;     // Localhost mixed proxy port (7890)
    tproxy_port: number;    // Base TProxy port (61235; per-device ports start at 61236)
    controller_port: number;// External controller / Zashboard port (9090)
    relays: number;         // Total number of loaded relay proxies
    fail_open: boolean;     // Always false (locked fail-closed privacy cage)
    canary_ms: number;      // Last canary probe delay in ms
    canary_fails: number;   // Consecutive canary failures
  };

  // SmartDNS summary
  dns: {
    smartdns: boolean;      // True if smartdns is running
    port: number;           // Local SmartDNS port (6053)
  };

  // MPTCP path-manager endpoint pool
  mptcp: {
    enabled: boolean;
    subflows: number;       // Additional MP_JOIN subflow limit (up to 5)
    endpoints: Array<{ id: number; dev: string; ip: string }>;
  };

  // Bidirectional kernel, Mihomo and QoS branch telemetry (sampled every ~4s)
  telemetry: {
    branches: {
      vip: { down_bps: number; up_bps: number; bps: number; down_bytes: number; up_bytes: number; bytes: number; packets: number };
      tunnel: { down_bps: number; up_bps: number; bps: number; down_bytes: number; up_bytes: number; bytes: number; conns: number; reachable: boolean; k_down_bps: number; k_up_bps: number; k_bps: number; k_down_bytes: number; k_up_bytes: number; k_bytes: number; k_packets: number };
      direct: { down_bps: number; up_bps: number; bps: number; down_bytes: number; up_bytes: number; bytes: number; packets: number };
    };
    classify: { bps: number; packets: number; bytes: number };
    qos: {
      mode: "htb" | "fq_codel";
      down_cap_mbps: number;
      up_cap_mbps: number;
      bands: Record<"1:10" | "1:20" | "1:30", { bps: number; down_bps: number; up_bps: number; bytes: number; packets: number; drops: number; overlimits: number }>;
    };
  } | null;

  // Host system resources
  sys: {
    conntrack: { count: number; max: number };
    load1: number;          // 1-minute load average
    mem_available_kb: number;
    uptime: number;         // Router uptime in seconds
  };

  // Current effective values of all keys in TUNABLE (readable without login)
  settings: Record<string, string | number>;
}

interface StrandStatus {
  dev: string;              // L3 interface name: "wan", "vwan1" .. "vwan20"
  id: number;               // Strand ID (1..21); matches fwmark low byte and routing table 1000+id
  ip: string;               // Assigned IPv4 address from DHCP, e.g. "192.168.148.33"
  gw: string;               // Gateway IPv4 address, e.g. "192.168.128.1"
  subnet: string;           // CIDR subnet, e.g. "192.168.128.0/19"
  iface: string;            // OpenWrt netifd logical interface name
  role: "primary" | "backup";
  healthy: boolean;         // True if HTTP 204 probe succeeded within fail_keep window
  parked: boolean;          // True if temporarily parked after repeated portal auth failures
  http: number;             // Last HTTP status code from probe (204 = healthy, 0 = timeout)
  ttfb: number;             // HTTP time to first byte excluding DNS (`time_starttransfer - time_namelookup`) in seconds
  ttfb_ms: number;          // HTTP TTFB rounded to integer milliseconds (e.g. 16)
  loss: number;             // EWMA of unsuccessful HTTP probes (0..1)
  loss_pct: number;         // Rounded integer percentage of `loss` (0..100)

  // Bandwidth metrics (all in bytes/second unless suffixed with `_bytes`)
  rate: number;             // EWMA-smoothed download rate (bytes/s)
  now: number;              // Last sample interval download rate (bytes/s)
  peak: number;             // Decayed peak download rate (bytes/s)
  down_bytes: number;       // Cumulative download bytes on this strand
  up: number;               // EWMA-smoothed upload rate (bytes/s)
  up_now: number;           // Last sample interval upload rate (bytes/s)
  up_peak: number;          // Decayed peak upload rate (bytes/s)
  up_bytes: number;         // Cumulative upload bytes on this strand

  // Burst-Harvest 2.0 & VIP scheduling state
  slots: number;            // Number of slots assigned to this strand in `@pattern` (VIP excluded with four or more healthy strands)
  vip: boolean;             // True if this strand is the dedicated `@vip_lane` low-latency gaming strand
  bucket: "charged" | "draining" | "depleted" | "cooling";
  tokens: number;           // Estimated remaining burst allowance in bytes (0 .. 1,000,000)
  tokens_max: number;       // Maximum burst bucket capacity in bytes (1,000,000)
  tokens_pct: number;       // Available burst tokens as integer percentage (0 .. 100)
  cooldown_rem: number;     // Estimated seconds to refill at the current rate while cooling
}
```

---

### 3.2 `series` — Historical Time-Series (Total & Per-Strand)
- **Args**: `{ "limit"?: number }` (default `0` = all available samples, up to `720` samples = 24 minutes at 2s interval)
```typescript
interface PrismSeriesResponse {
  interval: number;                      // Seconds between samples (2)
  ts: number[];                          // Unix timestamps (seconds) for each sample
  total: number[];                       // Total download rate (bytes/s) at each sample
  up: number[];                          // Total upload rate (bytes/s) at each sample
  strands: Record<string, number[]>;     // dev -> download rate (bytes/s) array aligned with `ts`
  strands_up: Record<string, number[]>;  // dev -> upload rate (bytes/s) array aligned with `ts`
}
```

---

### 3.3 `devices` — LAN Clients, Wi-Fi Signal, Traffic & Per-Device Policy
- **Args**: `{}`
```typescript
interface PrismDevicesResponse {
  devices: LanDevice[];
  quarantine: Array<{
    mac: string; ip: string; host: string; link: string; online: boolean;
    signal: number; rand: boolean; os: string; score: number; reason: string;
    candidates: Array<{uid: string; group_name: string; alias: string; score: number; reasons: string[]}>;
  }>;
}

interface LanDevice {
  uid?: string;             // Enrolled profile ID
  active_mac?: string;
  bound_macs?: string[];
  group_name?: string;
  port?: number;            // Dedicated Mihomo TProxy listener
  relay?: string;           // Persisted manual group selection
  mac: string;              // Lowercase MAC address, e.g. "aa:bb:cc:dd:ee:ff"
  ip: string;               // Observed IPv4 address, last recorded address for offline profiles, or ""
  host: string;             // DHCP hostname or ""
  name: string;             // User-assigned name (falls back to DHCP hostname)
  named: boolean;           // True if explicitly named by the user in UCI
  link: "wired" | "5G" | "2.4G";
  signal: number;           // Wi-Fi RSSI in dBm (e.g. -52), or 0 for wired/offline
  online: boolean;          // True if currently associated on Wi-Fi or reachable in ARP table
  policy: "auto" | "game" | "direct" | "tunnel" | "block";
  down: number;             // Instantaneous download rate (bytes/s)
  up: number;               // Instantaneous upload rate (bytes/s)
  down_bytes: number;       // Cumulative download bytes
  up_bytes: number;         // Cumulative upload bytes
}
```
> **Device Policy Semantics**:
> - `"auto"`: Forced-tunnel destinations precede domestic direct destinations. Remaining traffic uses the device’s selected relay group.
> - `"game"`: Gives new direct connections from this MAC the VIP strand and HTB class `1:10`. At 50 MB the kernel clears the priority bit and preserves the established route.
> - `"direct"`: Forces all traffic from this MAC to go direct (bypasses `mihomo` tunnel).
> - `"tunnel"`: Forces all traffic from this MAC into `mihomo` tunnel (even domestic IPs).
> - `"block"`: Blocks internet access for this MAC while keeping the router LAN UI reachable.

---

### 3.4 `tunnel` — Mihomo Relay Groups & Taiwan Residential Cage Status
- **Args**: `{}`
```typescript
interface PrismTunnelResponse {
  reachable: boolean;       // True if mihomo external-controller answered
  selected: string;         // Most frequent effective relay across device selectors
  tw_home: string;          // Manual selection in TW-HOME
  auto: string;             // Alias for tw_home
  groups: Array<{ uid: string; group_name: string; anchor_mac: string; port: number; now: string }>;
  dashboard: string;        // URL to Zashboard UI, e.g. "http://192.168.16.1:9090/ui/"
  relays: Array<{
    name: string;           // Group or proxy name
    type: string;           // e.g. "Fallback", "Hysteria2", "Vless", "Trojan"
    delay: number;          // Last measured latency in ms (0 if untested/timeout)
  }>;
}
```

---

### 3.5 `doctor` — Live System Health Verification
- **Args**: `{}`
```typescript
interface PrismDoctorResponse {
  ts: number;
  ok: boolean;
  fail: string[];           // IDs of failed checks with level == "fail"
  warn: string[];           // IDs of failed checks with level == "warn"
  checks: Array<{
    id: string;             // e.g. "ip_forward", "nft_table", "privacy_guard", "strands_healthy", ...
    level: "fail" | "warn";
    ok: boolean;
    detail: string;         // Optional diagnostic context, e.g. "21 of 21"
  }>;
}
```

---

### 3.6 `rules` — nftables Classification Counters & Set Sizes
- **Args**: `{}`
```typescript
interface PrismRulesResponse {
  tunnel_on: boolean;
  rules: Array<{
    tag: "device-block" | "unverified-drop" | "relay" | "relay-other-port" | "quic" | "device-direct" | "device-tunnel" | "tunnel-range" | "tunnel-domain" | "domestic" | "domestic-domain" | "tunnel-port" | "rest-tunnel";
    packets: number;
    bytes: number;
  }>;
  sizes: {
    domestic4: number;      // Number of CIDRs in domestic4.list (~6395)
    tunnel4: number;        // Number of CIDRs in tunnel4.list (~18)
    tunnel_domains: number; // Number of forced-tunnel domains (~49)
    tunnel4_dns: number;    // Live SmartDNS-populated IPs in `@tunnel4_dns` (cached 20s)
    domestic4_dns: number;  // Live SmartDNS-populated IPs in `@domestic4_dns` (cached 20s)
    relay4: number;         // Live resolved relay server IPs in `@relay4` (cached 20s)
  };
  ports: number[];
}
```

---

### 3.7 `events` — Recent State Transition Log
- **Args**: `{ "limit"?: number }` (default `60`)
```typescript
interface PrismEventsResponse {
  events: Array<{
    ts: number;             // Unix timestamp (seconds)
    msg: string;            // e.g. "STRANDS 21 of 21 healthy: 1 2 3 ..."
  }>;
}
```

---

### 3.8 `config` — Tunable Settings & Lock Metadata *(Auth Required)*
- **Args**: `{}`
```typescript
interface PrismConfigResponse {
  values: Record<string, string | number>;
  tunable: Record<string, {
    choices?: string[];
    min?: number;
    max?: number;
    locked: boolean;        // True if locked by architecture/security invariants
  }>;
}
```
> **Locked vs Editable Settings (`tunable[key].locked`)**:
> - **Locked (`locked: true`)** — Must be displayed as locked/read-only in the UI (cannot be modified):
>   - `weave.policy`: `"harvest"` (Burst-Harvest 2.0 token-bucket scheduler)
>   - `weave.affinity`: `"flow"` (Per-flow spread across strands)
>   - `classify.remainder`: `"tunnel"` (Overseas traffic always enters tunnel)
>   - `classify.quic`: `"reject"` (Reject UDP/443 QUIC so browsers use multi-strand TCP/TLS)
>   - `tunnel.enabled`: `1` (Tunnel always enabled)
>   - `tunnel.fail_open`: `0` (Strict fail-closed privacy guard; zero direct leak on outage)
> - **Editable (`locked: false`)**:
>   - `strands.aggregate`: `"auto" | "on" | "off"`
>   - `strands.probe_interval`: `30 .. 3600` (seconds)
>   - `weave.slots`: `0 .. 252` (`0` = auto `6` per healthy strand)
>   - `weave.strand_kbit`: `0 .. 1000000` (`0` = default 10 Mbps CIR; peak ceiling under `headroom`)
>   - `dns.ads`: `0 .. 1` (SmartDNS ad blocking)
>   - `main.mss`: `0 .. 1460` (TCP MSS clamping, default `1440`)
>   - `led.mode`: `"prism" | "aurora" | "tunnel" | "netdev" | "stealth" | "off"`
>   - `led.bright`: `5 .. 100` (peak brightness percentage)
>   - `led.night_dim`: `0 .. 1` (automatic dimming between 22:00 and 08:00)

---

### 3.9 `connections` — Active Direct & Tunnelled Flows *(Auth Required)*

Requests return the latest completed samples. When the direct sample is four seconds old or absent, the first reader starts one background conntrack scan. On a cold read, direct rows appear after that scan finishes. Repeated timestamps identify the same sample. Direct rows use admitted client addresses and the original and reply tuples to identify the WAN strand.
- **Args**: `{}`
```typescript
interface PrismConnectionsResponse {
  sampled: { direct: number; tunnel: number }; // Monotonic seconds per source. Zero until its first completed sample.
  connections: Array<{
    key: string;            // Unique flow identifier
    src: string;            // LAN client IPv4, e.g. "192.168.16.178"
    dst: string;            // Destination hostname (if sniffed/tunnelled) or IPv4 address
    port: number;           // Destination port
    proto: string;          // "tcp" | "udp"
    route: "direct" | "tunnel";
    via: string;            // For direct: strand dev ("vwan4"); for tunnel: relay name ("🇹🇼【亚洲】台湾家宽01丨专线【3x】")
    vip: boolean;           // True if this flow is riding the dedicated `@vip_lane`
    up: number;             // Cumulative upload bytes for this flow
    down: number;           // Cumulative download bytes for this flow
    start?: string;         // ISO timestamp for tunnelled flows
  }>;
}
```

---

## 4. Write Endpoints *(All Require Auth)*

All write endpoints return `{ "ok": boolean, "error"?: string }` with any additional result fields shown below. Policy writes schedule a reconciler pass. Selector writes take effect in Mihomo immediately.

| Method | Args Schema | Description |
|---|---|---|
| `reconcile` | `{}` | Triggers an immediate `prism reconcile` pass. |
| `configure` | `{ "set": Record<string, string \| number> }` | Validates and commits one or more `TUNABLE` settings to `/etc/config/prism`. Atomic: rejects the entire batch if any key is invalid or out of bounds. |
| `device` | `{ "mac": string, "name": string, "policy": "auto" \| "game" \| "direct" \| "tunnel" \| "block" }` | Updates a LAN client's display name and/or routing policy. If reset to `name: ""` and `policy: "auto"`, removes the UCI entry cleanly. |
| `select` | `{ "name": string, "group"?: string }` | Selects a member of TW-HOME or the specified device group (UID or group name). Persists the confirmed choice in `/etc/prism/state/device_relays.json`. |
| `claim` | `{ "mac": string, "action": "new" \| "merge" \| "forget", "target_uid"?: string, "alias"?: string, "policy"?: string, "relay"?: string }` | Enrolls, merges or removes a device identity. |
| `reload` | `{}` | Refreshes the daemon's UCI settings. |
| `led_demo`, `led_color` | `{}` or `{ "r": number, "g": number, "b": number, "target"?: string, "ttl"?: number }` | Controls the LEDs. |
| `relogin` | `{}` | Clears all portal park timers and forces an immediate probe + captive-portal re-authentication across all strands. |
| `remember` | `{ "name": string, "aggregate": boolean, "portal"?: string }` | Saves the current upstream gateway MAC as a known site in `/etc/config/prism`. |
| `forget` | `{}` | Removes the current upstream gateway MAC from saved sites in `/etc/config/prism`. |
