# hotel-suite 架构

酒店网络下的旁路栈：多身份上联负载均衡 + 国内直连/其余代理分流 + 防劫持 DNS。
运行在 ImmortalWrt（fw4 / nftables / procd / ucode）上。

## 一句话模型

**一份配置、一个服务、一张 nft 表、一个调谐器。**

```
/etc/config/hotel ──┐
系统现状(facts) ────┼─▶ hotel tick ─▶ 期望状态 ─▶ 只改有差异的部分
state.json ─────────┘    (一次性进程，可重复执行，跑两遍第二遍无变化)
```

- `hotel tick` 每次都是全新进程：读配置、看现状、算期望、做差量。没有常驻逻辑，
  没有标志文件，崩了下一轮自然恢复。
- 数据面全部在内核里（nft + 策略路由）。控制面挂掉不影响转发。
- 唯一常驻的 `supervisor.uc` 只有 40 行：定时、去抖、串行地拉起 `hotel tick`。

## 进程

`/etc/init.d/hotel` 一个 procd 服务，三个实例：

| 实例 | 作用 | 何时重启 |
|---|---|---|
| supervisor | 每 60s 及收到 `hotel kick` 时跑一次 tick | 崩溃自动拉起 |
| smartdns | LAN 的解析大脑 | `smartdns.conf` 内容变化 |
| mihomo | 代理出口 | 配置变化走 API 热重载，不重启 |

触发来源只有 procd：接口事件（`interface.*`，3s 去抖）和 `uci commit hotel`
都只是 `hotel kick`。没有 cron、hotplug 脚本、rc.local。

## 调谐流水线（`hotel.uc: reconcile`）

顺序即依赖，新增功能 = 新增一个模块 + 流水线里一行。

1. `uplink.observe`  发现线路 → 探测 → portal 登录 → 打分 → 排槽位
2. `proxy.observe`   渲染并校验 mihomo 配置 → 存活/金丝雀 → 是否接管流量
3. `datapath.apply`  路由表/策略规则 → nft（原子事务）
4. `dns.apply`       渲染 SmartDNS 配置 → 接线 dnsmasq
5. `system.apply`    RPS、关 IPv6、IRQ 亲和、上行整形
6. `wifi.apply`      AP 守护、备用 STA 角色
7. `doctor.run`      只看系统真实状态的体检 → LED → status.json

## 数据面：`table inet hotel`

```
LAN 包
 │ dns_hijack (nat)        53/853 → 本机解析器
 ▼
 prerouting (mangle)
 ├─ jump proxy             命中 → goto divert（tproxy 给 mihomo，结束）
 │    @node4 return        节点地址不套娃
 │    @proxy4/@proxy4_dyn  强制代理（Cloudflare/Anthropic、SmartDNS 钉住的答案）
 │    udp/123              NTP 走代理
 │    @direct4 return      国内 IP 直连，mihomo 根本看不到
 │    其余 → divert
 └─ jump balance           直连流量：按连接轮转到 42 个槽位 → 线路身份
                           ct mark 记住身份，同一连接始终走同一条线

mihomo 自己发出的包 (routing-mark 0x8000)
   output (route) → jump balance   代理流量同样摊到所有线路
```

- 标记位：`0xff` 线路身份（1..250），`0x4000` 已交给 mihomo，`0x8000` mihomo 自身出站。
- 策略路由：`fwmark id/0xff → 表 1000+id`，`from 线路IP → 表 1000+id`，
  `fwmark 0x4000 → 表 100 (local lo)`。网关和网段取自各线路的 DHCP 租约，不写死。
- **按单元更新**：骨架 `base`、集合 `direct4/proxy4/node4/slot`、链 `proxy/balance`
  各自带摘要，一个 tick 只把变化的单元放进同一个 `nft -f` 事务。切换代理开关只换
  `proxy` 链，不会重载 6000 条国内段，也没有泄漏窗口。
- 下行计量：`set legs { type ifname; counter; }`，每条线路一个元素计数器，O(1)，
  转发流量和代理流量都算。

## 上联（`mod/uplink.uc`）

- 线路 = 上游网络里一个有独立地址的三层设备（`wan` + macvlan `vwan*`；`phy*-sta*`
  为备用，仅在没有任何主线路健康时启用）。
- 健康：经该线路请求 `probe_url` 得到 `probe_expect`。健康线路每 `probe_interval`
  复测，不健康的每个 tick 都测并尝试 portal 登录；连续 `fail_keep` 轮失败才剔除，
  登录失败 `park_fails` 次后停靠 `park_sec`。
- 调度器 `idle`：每线路 1 槽，富余槽位轮流给下载速率（EWMA）最低的一半线路，
  新连接自然偏向空闲线路。`even` 为纯均分。
- 扩展点：`PORTALS`（portal 插件，导出 `login_cmd(dev, secret)`）和 `SCHEDULERS`。

## DNS

```
客户端 → dnsmasq(:53, DHCP 主机名) → SmartDNS(127.0.0.1:6053)
   代理在线:  cn 域名表 → 国内 DoH（证书校验）   其余 → mihomo DNS(5553, 经代理)
              proxy-domains.list → 走默认组，并把答案写入 nft @proxy4_dyn
   代理离线:  全部 → 国内 DoH
```

- 永不使用明文 UDP/53 上游：酒店会劫持。未认证 portal 时 DoH 证书校验会失败，
  这是预期行为，认证后恢复。
- AAAA 与 HTTPS(65) 记录强制 SOA；LAN 的 IPv6 转发直接 reject，客户端立即回落 IPv4。

## 代理（`mod/proxy.uc`）

- 分流已在内核完成，mihomo 规则只有一条 `MATCH,PROXY`。
- 配置由 `proxy-nodes.json`（sing-box outbound 形状）生成为 JSON（YAML 的子集），
  先 `mihomo -t` 通过才替换线上文件。
- 金丝雀：每 `canary_interval` 测 AUTO 组延迟，连续 `canary_fails` 次失败后
  fail-open（撤掉 `proxy` 链，流量直连）；`option fail_open '0'` 改为 fail-closed。

## 文件

```
/etc/config/hotel                全部可调参数（完整清单与默认值见 lib/config.uc）
/etc/hotel/lists/*.list          direct4 / proxy4 / proxy-domains，纯数据
/etc/hotel/provision.json        本机应有的 UCI 值、IRQ 亲和等
/etc/hotel/proxy-nodes.json      节点（600）
/usr/share/hotel/hotel.uc        CLI + 流水线
/usr/share/hotel/lib/            core(文件/shell/日志) config facts
/usr/share/hotel/mod/            uplink proxy datapath dns system wifi led doctor
/usr/share/hotel/tpl/ruleset.ut  nft 骨架模板
/tmp/hotel/                      运行态：state.json status.json doctor.json events.log
                                 以及渲染产物 smartdns.conf mihomo.yaml ruleset.nft
```

## 常用命令

```
hotel plan [--full]   演练：打印将要做的改动，校验 nft，不动系统
hotel apply           立即调谐并整表重建
hotel doctor [json]   体检（非 0 退出码 = 有 fail）
hotel status | legs | events
hotel proxy reload | ui
hotel provision [--dry]
/etc/init.d/hotel reload | stop    stop 会撤掉全部内核状态，退回普通路由器
```

## 不变量（改代码前先读）

- tproxy 判定必须在 `direct4` 之前检查 `proxy4`，否则 Cloudflare 中国段会绕过代理。
- `prerouting` 必须先放行广播/组播和非单播目的，否则 Wi-Fi 客户端拿不到 DHCP。
- 策略路由先于 nft 应用：流量不能被标记到一张还空着的路由表。
- 线路身份 = ct mark = fwmark 低 8 位，全链路只此一个编号体系。
- 不要对着 ping 丢包调参：酒店网关对 ICMP 限速。
