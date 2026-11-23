# Prism

*one beam, twenty-one wavelengths.*

上游网络给每个身份（MAC + 地址）单独限速时，Prism 把单一聚合流量**色散编织到 21 条波长线路（strand）**：新连接被摊到所有满桶健康线路上，国内流量直连，其余进隧道，
DNS 全程防劫持。运行在 ImmortalWrt（fw4 / nftables / procd / ucode）上。

## 词汇表

| 词 | 含义 |
|---|---|
| **site 站点** | 一个被记住的上游网络，凭网关的 MAC 地址识别。聚合与否、用哪个 portal 都跟着站点走 |
| **strand 线路** | 上游网络里一个有独立地址的三层设备（`wan`、macvlan `vwan*`）。它的编号（1..250）同时是 fwmark 低 8 位、conntrack mark 和路由表 `1000+id` |
| **weave 编织** | 新连接落到哪条线路。内核按**槽位**取号，查 `@vip_lane`（低延迟 VIP 专线）或 `@pattern`（脉冲收割池）得到线路编号 |
| **vip_lane 专线** | 2 个槽位按探测质量和负载选同一条健康线路（`ct mark | 0x100`）。线路充足时普通新流避开它，各线路共用同一物理 WAN |
| **pattern 图样** | 槽位 → 线路，按估算的 1.0 MB 令牌桶余量加权（`harvest`），每秒采样，份额变化达到门槛时重排。回答"下一个连接去哪" |
| **anchor 锚** | 槽位 → 线路，均匀且稳定。回答"这一对地址总是去哪" |
| **device 设备** | LAN 上的一个 MAC。可以命名，可以单独决定去向（`auto` / `game` / `direct` / `tunnel` / `block`） |
| **classify 分类** | 一个包走隧道还是直连 |
| **tunnel 隧道** | mihomo。**relay 中继**是它的出口节点 |
| **pass 一轮调谐** | `prism reconcile` 跑一次 |

## 两个进程，一条分界线

```
            慢、会失败、可重试                     快、常驻、只读内核计数
   ┌──────────────────────────────┐      ┌──────────────────────────────┐
   │ prism reconcile  (一次性进程) │      │ prismd  (守护进程)            │
   │  发现线路 → 探测 → portal 登录 │◀─启动─│  每 1s 读线路计数 → 负载       │
   │  路由/规则 → nft 原子事务      │      │  → 重排图样（更新流量与 VIP 槽位）   │
   │  隧道/DNS 配置 → 体检         │─快照─▶│  定时/按需拉起 reconcile       │
   └──────────────────────────────┘      │  发布 ubus 对象 prism（API）   │
                                         └──────────────────────────────┘
```

- **reconcile 保证正确，prismd 负责更优。** 图样只有在"长度不对或含不健康线路"时
  才由 reconcile 重写；平时由 prismd 按负载优化。prismd 挂了，内核照旧按最后的图样
  转发，procd 会把它拉起来。
- reconcile 每次都是新进程：读配置、看现状、只改有差异的部分，跑两遍第二遍无变化。
  没有标志文件，没有跨进程的隐含状态。
- 触发只有一种：ubus 方法 `prism.reconcile`。procd 的接口事件（`interface.*`，
  3s 去抖）、`uci commit prism`、页面按钮、`prism kick` 都走它，突发合并成一轮。

`/etc/init.d/prism` 是一个 procd 服务、三个实例：`prismd`、`smartdns`、`mihomo`。
后两个的配置由 reconcile 渲染；SmartDNS 配置变了由 procd 重启它，mihomo 走 API 热重载。

## 调谐流水线（`prism.uc: reconcile`）

顺序即依赖，新增功能 = 新增一个模块 + 流水线里一行。

0. `strands.site` + `strands.steer`  凭网关 MAC 认出站点 → 决定是否聚合 → 把额外身份的接口拉起或放下
1. `strands.discover`  找出当前存在的线路，网关/网段取自各自的 DHCP 租约
2. `kernel.plumb`      每条线路的路由表与策略规则（必须先于探测：绑定线路的探测要靠它出得去）
3. `strands.check`     到期的线路做 HTTP 探测 → 失败的走 portal 登录 → 得出健康集合
4. `identity.reconcile` 核对设备和地址配对，再由 `tunnel.observe`    渲染并校验 mihomo 配置 → 存活 / 金丝雀 → 是否承载流量
5. `weave.plan`        图样与锚对当前健康集合是否仍有效，无效则重排；只剩一条线路时不编织
6. `kernel.apply`      默认路由覆盖 + nft（一个原子事务，只含变化的单元）
7. `dns.apply` `host.apply` `wifi.apply`
8. `doctor.run` → LED → 写快照

## 内核：`table inet prism`

```
LAN 包
 │ DNS 53 → 本机解析器；DoT 853 在 guard 拒绝
 ▼
 prerouting → classify
     dev_block / 未认证 MAC . IPv4 → drop
     已配置的中继 IP . 协议 . 端口 → direct_ok
     拒绝的 QUIC → reject
     dev_direct → direct_ok；dev_tunnel → divert
     中继其他端口 / tunnel4 / tunnel4_dns → divert
     domestic4 / domestic4_dns → direct_ok
     其余 → divert
 direct_ok → weave → packet mark 加 0x20000000
 divert → 按 MAC 投递独立的 TProxy 端口，未匹配设备丢弃

隧道自己发出的包 (routing-mark 0x8000)
   output (route) → jump weave   隧道流量同样编织到所有线路
```

- 标记位：`0xff` 线路编号，`0x4000` 已交给隧道，`0x8000` 隧道自身出站。
- 策略路由：`fwmark id/0xff → 表 1000+id`，`from 线路地址 → 表 1000+id`，
  `fwmark 0x4000 → 表 100 (local lo)`。
- **按单元更新**：骨架 `base`、集合 `domestic4/tunnel4/relay4`、链 `classify/weave`
  各带摘要，一轮只把变化的单元放进同一个 `nft -f`。切换隧道开关只换 `classify` 链，
  不重载 6000 条国内段，也没有泄漏窗口。
- 下行计量：`set strands { type ifname; counter; }`，每条线路一个元素计数器，O(1)，
  转发流量和隧道流量都算。prismd 读的就是它。

## 站点与聚合开关（`mod/strands.uc`）

路由器不该需要人来告诉它"现在在哪"。上联口拿到租约后，查网关的 MAC：

- 命中 `config site` → 用它的设置（是否聚合、portal 插件）。
- 没命中 → 陌生网络：不聚合、不登录 portal，就是一台普通路由器（分类、隧道、
  DNS 照常）。页面上一键"记住这个网络并聚合"。
- `strands.aggregate` 可强制 `on` / `off`，默认 `auto` 跟随站点。
- 网关 MAC 一时解析不出来（ARP 慢）不做任何决定，沿用上一次的结论，避免误拆。

不聚合时，`identity` 匹配的接口（`vwan*`）被 `ifdown` 并写 `auto=0`，重启后也
不会起来：上游只看到一台设备、只发一个租约。实测：关 → 5 秒内收敛为单线路，
体检全绿；开 → 10 秒内 21 条线路全部回来。

## 编织（`mod/weave.uc`）

上游网关对每个 MAC 身份使用双参数令牌桶整形（`CIR = 10 Mbps` 稳态承诺速率，`Bc = 1.0 MB` 突发令牌容量）：任何闲置满桶线路在新连接前 `0.8s–1.0s` 内可释放 `18–20+ Mbps` 脉冲带宽，桶空后触发丢包式尾丢弃（Tail-Drop）。

**VIP 与线路调度**

每秒从 nft 线路集合分别读取收发字节。每个方向的余量按 `clamp(旧余量 + CIR × 实际间隔 − 已传字节, 0, 1000000)` 更新，CIR 默认 1,250,000 B/s，可由 `strand_kbit` 指定。两个方向取较小余量。按平滑速率计算的剩余带宽、余量及 HTTP 探测成功率决定新连接份额。历史曲线保留 720 个样本，约每两秒更新一次。

VIP 选举考虑首字节时间、探测失败及收发负载。有其他健康候选时避开 MPTCP 端点。至少四条健康线路时，普通流的槽位排除 VIP。VIP 连接达到 50 MB 时只清除优先级位，原 NAT 线路保留。

地址与邻居通过 ucode 的 rtnl 模块读取。健康探测每批最多七个并发请求。首次获得或更换租约须先探测成功。HTTP 探测失败率与移除 DNS 时间后的首字节延迟分开计算。内核选用最多六个 MPTCP 端点、最多五个额外子流，MP_JOIN 走源地址规则。

**亲和性**

- 锁定 `flow`（按流铺开）：每个新流选择一条线路，已建立连接沿用 conntrack 线路。代理出口由客户端手动选择的设备组及 `TW-HOME` 决定。

## 设备（`mod/devices.uc`）

首次建立档案时导入已配置及在线设备，以后使用持久档案认领。当前 DHCP 租约优先，同 IP 即使被未知设备租走，也不能沿用旧配对。无租约时使用已登记 MAC 的活动邻居，或由无线关联、近期 FDB 活动佐证的邻居。开机缺少邻居记录时，只向已连接设备上次使用的本地地址查询，并依照内核实际学到的 MAC 放行。DHCP 热插拔先写 tmpfs 观察记录，再请求调谐。两张 nft 表的 admission 集合在同一事务生效。

设备就是 MAC。地址、主机名、接入方式每次现查（DHCP 租约 + 邻居表 + hostapd），
所以换了地址，名字和策略都还在。

- 计量：`@dev_up`（prerouting，按源地址）和 `@dev_down`（postrouting，按目的地址）
  两个带计数器的动态集合，首包自动建元素。放在 postrouting 才能同时看到转发流量
  和隧道回给客户端的流量。
- 去向（在 `classify` 最前面按 MAC 判断）：`auto` 跟大家一样；`direct` 永不进隧道；
  `tunnel` 全部进隧道（含国内）；`block` 不能上网但仍能访问路由器。
- 实测：block 丢包且路由器页面仍可达；direct 访问 1.1.1.1 命中 `device-direct`
  而不是 `tunnel-range`；tunnel 访问国内地址命中 `device-tunnel`。

## DNS

```
客户端 → dnsmasq(:53, DHCP 主机名) → SmartDNS(127.0.0.1:6053)
   任意时刻（fail-closed）:
     cn 域名表 → 国内 DoH（证书校验），答案写入 @domestic4_dns
     其余       → 隧道 DNS(127.0.0.1:5553)
     tunnel-domains.list → 走默认组，答案写入 nft @tunnel4_dns
```

永不使用明文 UDP/53 上游（这里会被劫持）。portal 未认证时 DoH 证书校验会失败，
属预期，认证后恢复。AAAA 与 HTTPS(65) 记录强制 SOA；LAN 的 IPv6 转发直接 reject。

## API 与页面

prismd 发布 ubus 对象 `prism`，uhttpd 经 `/ubus` 暴露，ACL 在
`/usr/share/rpcd/acl.d/prism.json`：

| 方法 | 权限 | 内容 |
|---|---|---|
| `status` `series` `events` `doctor` `tunnel` `devices` `rules` `led_view` | 局域网内免登录 | 站点/线路/负载/图样、历史曲线、事件、体检、中继、设备与速率、分类规则及实时命中、LED 状态 |
| `config` `connections` | 登录 | 可调参数及取值范围；活跃直连/隧道流列表（带单调采样时间戳，需鉴权） |
| `reconcile` `configure` `relogin` `select` `device` `remember` `forget` `claim` `reload` `led_demo` `led_color` | 登录 | 触发一轮、改参数、重登 portal、切换中继、设备改名/改去向/认领、记住/忘记网络、重载配置、LED 控制 |

任何处理函数抛异常只损失这一次应答，不会带垮 prismd。

页面在 `http://<路由器>/prism/`，采用模块化原生 ES6 架构（`index.html`、`css/`、`js/`），登录用路由器（LuCI）账号。
可调参数白名单及范围在 `lib/config.uc: TUNABLE`，页面和 API 共用同一份校验。

## 文件

```
/etc/config/prism                全部可调参数（完整清单与默认值见 lib/config.uc）
/etc/hotplug.d/dhcp/50-prism     DHCP 事件入口（调用 bin/dhcp.uc 记录指纹并触发协调）
/etc/prism/guard.nft             持久化的独立 fail-closed 防护规则（fw4 ruleset-post 包含）
/etc/prism/lists/*.list          domestic4 / tunnel4 / tunnel-domains，纯数据
/etc/prism/provision.json        本机应有的 UCI 值、IRQ 亲和、AQL 限制
/etc/prism/relays.json           中继（600）  controller.secret  portal.secret
/etc/prism/state/                运行持久态：profiles.json、device_relays.json、sites
/usr/share/prism/prism.uc        CLI + 流水线
/usr/share/prism/prismd.uc       守护进程
/usr/share/prism/bin/            dhcp.uc（DHCP 热插拔） lan_probe.lua（LAN 名称探测）
/usr/share/prism/lib/            core(文件/shell/日志) config facts(rtnl) series(环形缓冲)
/usr/share/prism/mod/            strands weave kernel tunnel guard dns devices identity host wifi led doctor api
/usr/share/prism/portal/         portal 插件（导出 address() 与 login_cmd(dev, secret, ip)）
/usr/share/prism/tpl/prism.nft.ut   nft 骨架模板
/www/prism/                      模块化前端控制台（index.html + css/ + js/）
/tmp/prism/                      运行态：state.json status.json doctor.json pattern.json guard.nft
                                 events.log dhcp_obs/ 以及渲染产物 smartdns.conf mihomo.yaml ruleset.nft
```

## 命令

```
prism plan [--full]   演练：打印将要做的改动，校验 nft，不动系统
prism apply           立即调谐并整表重建
prism strands         每条线路的健康、速率、峰值、槽位
prism doctor [json]   体检（非 0 退出码 = 有 fail）
prism status | events | kick
prism tunnel reload | ui
prism provision [--dry]
/etc/init.d/prism reload | stop    fail_open=0 时 stop 保留独立保护，禁止公共直连回退
```

## 不变量（改代码前先读）

- `inet prism_guard` 与 `inet prism` 生命周期独立，由 fw4 的 ruleset-post 包含
  持久生成的 `/etc/prism/guard.nft`。停止 Prism 不删除 guard。
- 只有本次分类认可的直连流量，在 weave 选线后取得 packet mark `0x20000000`。
  这个授权位不得写入 conntrack；停止分类后，已有连接也不能靠旧授权直出。
- fail_open=0 时启动、代理缺失、服务停止均不可把境外 DNS 回退至国内上游。

- 分类时 `tunnel4` 必须先于 `domestic4` 判断，否则 Cloudflare 中国段会绕过隧道。
- `prerouting` 必须先放行广播/组播和非单播目的，否则 Wi-Fi 客户端拿不到 DHCP。
- 策略路由先于探测、先于 nft：流量不能被标记到一张还空着的路由表。
- 探测必须打 204 端点、期望 204：portal 对任何明文 HTTP 都回自己的 200 页面，
  期望 200 会把掉了认证的线路当成健康，也就永远不会去重新登录。
- 隧道的监听地址（lo 上的 198.51.100.1）必须先于 mihomo 存在，否则 tproxy 监听器
  会被悄悄跳过（`prism prepare` 负责；reconcile 发现后会重启 mihomo）。
- `weave` 链里的 `mod N` 必须等于 `@pattern` 的长度；N 只由 reconcile 决定，
  prismd 只在既定长度内重排。`@anchor` 只由 reconcile 写。
- `/etc/config/prism` 归路由器所有（页面会往里写站点、设备和设置），`deploy.sh`
  默认不覆盖它，要覆盖须加 `--config`。
- ucode 的正则是 POSIX ERE：没有十六进制转义，没有懒惰量词。
- ucode 以 `-S` 严格模式运行：函数不能引用文件里更靠后才声明的名字。
- 不要对着 ping 丢包调参：这里的网关对 ICMP 限速。

## 上行

上行不需要另一套机制：编织是按连接做的，不分方向。需要补的是三件事，都已补上。

- **计量**：`@strands_up`（postrouting，按出口设备）给每条线路记上行字节，和下行
  的 `@strands` 对称。
- **进入余量**：见上，线路的占用取两个方向里更高的那个。一条被上传占满的线路不会
  再被分到新连接，哪怕它的下行是空的。
- **排队**：上行的瓶颈是我们自己的铜线口，那里本来就有 HTB + fq_codel。

## 整形：谁拥有瓶颈前的队列，谁就拥有延迟

只在上联是 10/100 Mbit 时启用（千兆以上不是瓶颈，不动）。

| 方向 | 在哪整形 | 速率 | 为什么 |
|---|---|---|---|
| 上行 | 上联口 `wan` 出口 | 链路的 95% | 队列本来就在我们这里，交给 fq_codel 管 |
| 下行 | LAN 桥 `br-lan` 出口 | 链路的 90% | 队列本来会堆在上游交换机里，我们管不到。把转发给 LAN 的流量压到略低于线速，发送方会在那条队列堆起来之前先慢下来 |

每个方向按 20/50/30 分配 HTB 保底份额，各类均可借到该方向的总速率。HTB 信用约为四毫秒。fq_codel 的目标延迟为 2/5/5 ms，队列内存上限为 2 MiB / 4 MiB / 2 MiB（`1:10` 上限 512 包且仅接纳 `<= 1500B` VIP 包与小交互包）。四秒采集一次 class 的字节与 overlimits，以及叶子队列的 drops。LAN 桥整形只覆盖实际发往该桥的包。

此前版本在此站点的实测（下载占满铜线时，从空闲线路新建连接）：

| | 握手 | 首包 |
|---|---|---|
| 铜线空闲 | 7 ms | 15 ms |
| 占满，无下行整形 | 29 ms | 59 ms |
| 占满，有下行整形 | 12 ms | 23 ms |

代价是满速下载的总吞吐从约 88 降到约 82 Mbit/s。`shaper.pct_down '0'` 可关。

## 实测上限（2026-10-09，本酒店）

| 量 | 值 | 怎么测的 |
|---|---|---|
| 单身份下行 | 10.5 Mbit/s | 一条线路 1 个连接 10.4；同一线路 4 个连接合计 10.5（按身份限，不按连接限） |
| 单身份上行 | 约 11 Mbit/s | 同上，POST 到 USTC 测速端点 |
| 聚合下行 | 约 88 Mbit/s | 2 / 4 / 8 条线路 = 21 / 40 / 79，线性；16 条起封顶 |
| 聚合上行 | 约 79 Mbit/s（未测到顶） | 4 条 = 44；更多时测速服务器按来源地址限并发 |
| 铜线 | 100 Mbit/s 全双工 | `wan: Link is Up - 100Mbps/Full`（WAN 口本身是 2.5G） |
| 跑满的线路上的新连接延迟 | 和空闲线路一样（15 ms） | 上游对身份是丢包式限速，不是排队式 |

由此得到的结论：

1. **9 条线路就吃满铜线。** 现在的 21 条不增加总吞吐，增加的是"每个连接独占一条
   线路"的概率。
2. **总量的天花板是那根 100M 铜线**，不是身份数量。墙上端口若是千兆而网线只通了
   两对，换一根线就能把天花板抬到约 220 Mbit/s（21 × 10.5）；如果端口本身是百兆，
   这条路到头了。
3. **单个连接的天花板是 10.5 Mbit/s**，这是按连接分流这种做法的硬上限：一个连接
   只能属于一个身份。多线程下载、多连接的应用可以叠加；单流的 4K 视频不行。
4. **线路之间不需要各自整形**：限速是丢包式的，跑满的线路不会给同线路的新连接
   增加延迟。需要整形的只有铜线本身（见上）。
5. **隧道流量走 QUIC 类中继（Hysteria2）时只能用到一条线路**：所有流量复用在一条
   UDP 连接里。Trojan / VLESS 每个连接独立，可以叠加。

## 当前 MPTCP 边界

JP-Lightsail-VLESS 开启 MPTCP。直接访问的普通 TCP 对端及 HY2 的单条 UDP 会话受其所属线路的限制。所有子流仍共用同一条 100 Mbit/s 全双工铜线。

## 考虑过但没采用的

- **flowtable / 硬件分流**：已建立的流会绕过 mangle 链，线路计数随之失效；这条
  上行合计不到 100 Mbit/s，CPU 远不是瓶颈。
- **单进程事件循环里做一切**：探测和 portal 登录会阻塞几十秒，放进常驻进程就得
  全部异步化；拆成"常驻只做快且不会失败的事 + 一次性进程做慢且会失败的事"更简单。
- **用 mwan3**：它不认识 portal、不做按负载的槽位分配，且仍基于 iptables。
- **按 IP 段单表 verdict map 分类**：`tunnel4` 与 `domestic4` 有交叠且需要优先级，
  顺序判断的三行规则比带冲突消解的区间映射更清楚。
