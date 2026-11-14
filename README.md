# Prism 5.0

*one beam, twenty-one wavelengths.*

運行於 Redmi AX6000（ImmortalWrt 25.12 / Linux 6.12）上的多鏈路令牌桶脈衝色散編織與零洩漏分流系統。針對上游網路按單一身份（MAC + IP）實施令牌桶限速（`CIR = 10 Mbps`, `Bc = 1.0 MB`）的場景，Prism 將單一匯聚業務流折射分散至 21 條虛擬上聯光譜通道（`wan` + `vwan1..vwan20`）：**電競與實時流獨享物理隔離的零丟包 VIP 專線，網頁、4K 視頻與下載動態收割 20 條線路的 `1.0 MB` 首秒突發窗口（`18–70 Mbps`），國內流量直連，海外與 AI 流量全閉鎖匯入單一台灣家寬出口（防封號零跳變）。**

- **完整工程與演算法設計規格書**：[DESIGN.md](DESIGN.md)
- **前端 HTTP / ubus API 規範文檔**：[API.md](API.md)
- **架構細節、詞彙表與不變量**：[prism/etc/prism/ARCHITECTURE.md](prism/etc/prism/ARCHITECTURE.md)
- **控制台面板**：<http://192.168.16.1/prism/>（局域網內狀態免登錄；修改配置使用路由器帳號登錄）

---

## 一、 系統分流與雙平面編織架構圖

```mermaid
flowchart TB
    subgraph ClientLayer["LAN 與 Wi-Fi 6 接入層 (MT7915 AQL 低延遲調優)"]
        PC["💻 終端設備 (無需開啟 Clash，由路由器全權接管)"]
    end

    subgraph ClassifyLayer["內核 nftables classify 智能分流層"]
        QReject["1. 全局攔截 UDP 443 (QUIC)<br/>立即返回 icmpx admin-prohibited (1ms 無感回退 TCP)"]
        GameCheck["2. 實時/遊戲流識別<br/>(非 80/443 小包 UDP、DNS、SSH、ICMP、DSCP EF/CS4-7、game 設備)"]
        SplitCheck["3. 國內外精準分流<br/>(@tunnel4 / @tunnel4_dns -> 台灣家寬隧道<br/>@domestic4 -> 國內直連編織<br/>其餘海外流量 + 海外 STUN -> 台灣家寬隧道)"]
    end

    subgraph ProxyLayer["Mihomo 零分裂台灣家寬隧道 (TW-HOME)"]
        TW1["主力 #1: 🇹🇼 台灣家寬01丨專線 (Trojan TCP 多路編織)<br/>落地：中華電信 HiNet 家寬"]
        TW1_Chain["同出口備援 #2: 🔗 JP-Lightsail -> 台灣家寬01 鏈式<br/>(主備切換 0 出口 IP 變化)"]
        TW2["異機備援 #3/#4: 🇹🇼 台灣家寬02丨專線 / Lightsail 鏈式<br/>落地：中華電信 HiNet 家寬"]
    end

    subgraph WeaveLayer["21 鏈路雙平面物理隔離編織層 (VIP + Burst-Harvest 2.0)"]
        VIPLane["⚡ VIP 遊戲專線 (@vip_lane: 最低純網路 RTT 鏈路)<br/>嚴禁視頻與下載進入！令牌桶 100% 滿電，0% 網關丟包，固定 NAT 端口"]
        HarvestPool["🌾 Burst-Harvest 2.0 收割池 (@pattern: 其餘 20 條鏈路)<br/>2s 高頻令牌桶狀態機 (charged -> draining -> depleted -> cooling)<br/>新連接優先命中滿桶鏈路收割 18~70 Mbps 首秒突發，耗盡鏈路 0 槽位冷卻"]
    end

    subgraph QoSLayer["三級 DiffServ 優先級隊列 (HTB + fq_codel)"]
        QoS["Band 1:10 (Prio 0, target 2ms): 遊戲 UDP / TCP SYN+ACK / DNS (零延遲插隊)<br/>Band 1:20 (Prio 1, target 5ms): 網頁與 4K 視頻分片突發流 (ct bytes < 4MB)<br/>Band 1:30 (Prio 2, target 5ms): 大文件持續下載流 (ct bytes >= 4MB)"]
    end

    PC --> QReject --> GameCheck
    GameCheck -->|"命中實時/遊戲直連流"| VIPLane
    GameCheck -->|"常規業務流"| SplitCheck
    SplitCheck -->|"海外與 Claude 流量"| ProxyLayer -->|"weave_out (每條 TCP 獨立條帶化)"| HarvestPool
    SplitCheck -->|"國內直連流量"| HarvestPool
    VIPLane --> QoS
    HarvestPool --> QoS
```

### 內核數據包分流決策流程圖（縱向）

```mermaid
flowchart TD
    Pkt["LAN 數據包進入 prerouting"] --> Block{"1. 設備屬 @dev_block ?"}
    Block -->|是| Drop["drop (禁網)"]
    Block -->|否| QUIC{"2. UDP 443 (QUIC) ?"}
    QUIC -->|是| Reject["reject with icmpx admin-prohibited<br/>(1ms 強制瀏覽器回退 TCP)"]
    QUIC -->|否| DirectDev{"3. 設備屬 @dev_direct<br/>或目標屬 @relay4 ?"}
    DirectDev -->|是| ToWeave["goto direct_ok -> weave<br/>(跨鏈路直連編織)"]
    DirectDev -->|否| ForceTunnel{"4. 設備屬 @dev_tunnel<br/>或目標屬 @tunnel4 / @tunnel4_dns ?"}
    ForceTunnel -->|是| ToTunnel["goto divert<br/>(TProxy -> Mihomo -> TW-HOME 台灣家寬)"]
    ForceTunnel -->|否| DomIP{"5. 目標屬 @domestic4<br/>(中國大陸白名單 IP) ?"}
    DomIP -->|是| ToWeave
    DomIP -->|否| Rest["6. 其餘所有海外流量 & 海外 STUN"] --> ToTunnel

    subgraph WeaveEngine["weave 雙平面編織鏈"]
        ToWeave --> Existing{"已有 ct mark ?"}
        Existing -->|是| RestoreMark["沿用原線路標記<br/>(>50MB 的 VIP 流自動遷回 @pattern)"]
        Existing -->|否 新建連接| IsVIP{"屬遊戲 / 短包UDP / SSH / 高DSCP ?"}
        IsVIP -->|是| PinVIP["查 @vip_lane 鎖定最低 RTT 專線<br/>(ct mark = id | 0x100)"]
        IsVIP -->|否| Spread["查 @pattern (126 槽位)<br/>分配至滿桶脈衝線路"]
    end
```

---

## 二、 核心特性

1. **`Burst-Harvest 2.0` 脈衝令牌桶收割引擎（[mod/weave.uc](prism/usr/share/prism/mod/weave.uc)）**
   - 精確建模上游網關 `CIR = 10 Mbps`、`Bc = 1.0 MB` 的單 MAC 令牌桶充放電物理過程。
   - 每條閒置滿桶線路在新連接首秒可爆發 `18–70 Mbps` 零丟包吞吐；一旦桶深耗盡（`depleted`）或速率逼近限速線，立即在 `@pattern` 中將其槽位清零（`0 slots`），強制冷卻 `2.5 秒` 回血，徹底規避上游尾丟棄（Tail-Drop）引發的 TCP 擁塞窗口塌陷。
2. **`@vip_lane` 電競與實時流物理隔離專線（[mod/weave.uc](prism/usr/share/prism/mod/weave.uc) & [mod/strands.uc](prism/usr/share/prism/mod/strands.uc)）**
   - 探針採用純網路首包延遲（`time_starttransfer - time_namelookup`）剔除本地 DNS 等待誤差，自動選出全場延遲最低且零擁塞的 1 條線路作為 `@vip_lane`，專供遊戲、語音與控制包使用，享受 `0%` 網關限速器丟包與穩定 NAT 映射；若單條流累計超過 `50 MB` 則自動驅逐回普通收割池。
3. **三級 DiffServ 優先級隊列與 TCP ACK 加速（[mod/host.uc](prism/usr/share/prism/mod/host.uc) & [tpl/prism.nft.ut](prism/usr/share/prism/tpl/prism.nft.ut)）**
   - 在 `wan` 與 `br-lan` 上部署三級 `HTB + fq_codel`（`1:10` 實時插隊隊列 `target 2ms`、`1:20` 交互突發隊列、`1:30` 大流下載隊列），確保滿載下載時遊戲包與小於 `128B` 的 TCP `SYN/ACK` 零排隊發送。
4. **`TW-HOME` 台灣家寬零跳變籠與 `inet prism_guard` 防洩漏保護（[mod/tunnel.uc](prism/usr/share/prism/mod/tunnel.uc) & [mod/guard.uc](prism/usr/share/prism/mod/guard.uc)）**
   - 自動合成 `JP-Lightsail -> 台灣家寬` 鏈式備援節點，將所有海外與 Claude/Anthropic 流量鎖定在同一個台灣中華電信家寬出口 IP，消除多地區 IP 跳變。
   - 獨立於服務生命週期的 `inet prism_guard` 表強制執行 `fail_open = 0`（Fail-Closed），即使服務停止或重啟，受保護流量與境外 DNS 也絕不會回退至直連。

---

## 三、 目錄結構

```text
API.md         前端 HTTP / ubus JSON-RPC 完整接口規範（供前端開發使用）
DESIGN.md      Prism 5.0 物理實測基線、數學模型與工程詳細設計文檔
prism/         路由器根目錄鏡像（按絕對路徑對應 /etc、/usr、/www、/lib）
tools/         本機側部署、演練與測試腳本
legacy/        早期 v1（shell）與 v2（hotel-suite）歸檔快照
```

---

## 四、 日常操作與部署命令

```sh
tools/rsh                        # 登錄路由器（密鑰 ~/.ssh/id_ed25519_ax6000）
tools/rsh prism strands          # 查看 21 條線路：健康、令牌桶狀態、純網路 TTFB、速率、槽位
tools/rsh prism doctor           # 執行全項健康與隱私保護體檢
tools/rsh prism events           # 查看最近的狀態轉換日誌

tools/rehearse.sh plan --full    # 將本地代碼同步至路由器 /tmp 演練，不改動線上狀態
tools/deploy.sh                  # 部署代碼、規則列表與頁面，體檢不過自動回滾
tools/deploy.sh --config         # 連同 /etc/config/prism 一起推送
tools/deploy.sh --assets         # 連同 mihomo.gz / 域名表 / 面板靜態資源一起推送
tools/deploy.sh --secrets        # 連同 relays.json 一起推送
```

---

## 五、 常用修改位置速查

| 調整項 | 文件路徑 |
|---|---|
| 全局參數與可調範圍白名單 | `prism/etc/config/prism`、`prism/usr/share/prism/lib/config.uc`（`SCHEMA` / `TUNABLE`） |
| 國內白名單段 / 強制隧道段 / 強制隧道域名 | `prism/etc/prism/lists/`（`domestic4.list`、`tunnel4.list`、`tunnel-domains.list`） |
| 代理中繼節點配置 | `prism/etc/prism/relays.json`（不入 Git 庫，需 `--secrets` 推送） |
| 令牌桶參數與 `Burst-Harvest 2.0` 權重 | `prism/usr/share/prism/mod/weave.uc` |
| 內核 `nftables` 骨架與分流規則 | `prism/usr/share/prism/tpl/prism.nft.ut`、`prism/usr/share/prism/mod/kernel.uc` |
| Portal 認證插件 | `prism/usr/share/prism/portal/linkbroad.uc` |
| 前端 ubus API 實現 | `prism/usr/share/prism/mod/api.uc`（規範見 [API.md](API.md)） |
| 前端模組化控制台 | `prism/www/prism/`（`index.html`、`css/`、`js/` 原生 ES6 Modules） |
