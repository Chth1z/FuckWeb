# Braid

*many strands, one line.*

Redmi AX6000（ImmortalWrt 25.12）上的上联编织栈：把上游按身份限速的多条线路织成一条，
国内直连、其余进隧道、DNS 防劫持，自带管理与监控页面。

- 设计、词汇表、不变量：[braid/etc/braid/ARCHITECTURE.md](braid/etc/braid/ARCHITECTURE.md)
- 页面：<http://192.168.16.1/braid/>（状态免登录；管理用路由器账号登录）

## 目录

```
braid/     路由器上的文件，按绝对路径镜像（etc/ usr/ www/ lib/）
tools/     本机侧工具
legacy/    v1（shell）与 v2（hotel-suite）的源码、迁移脚本、迁移前快照
```

## 日常操作

```sh
tools/rsh                        # 登录路由器（密钥 ~/.ssh/id_ed25519_ax6000）
tools/rsh braid strands          # 每条线路：健康、速率、峰值、槽位
tools/rsh braid doctor           # 体检
tools/rsh braid events           # 最近的状态变化

tools/rehearse.sh plan --full    # 把本地代码放到路由器 /tmp 下演练，不碰线上
tools/deploy.sh                  # 部署代码+列表+页面，体检不过自动回退
tools/deploy.sh --config         # 连同 /etc/config/braid（会覆盖页面里做的设置、站点和设备）
tools/deploy.sh --assets         # 连同 mihomo.gz / 域名表 / 节点面板
tools/deploy.sh --secrets        # 连同 relays.json
tools/rsh sh -s < tools/router_snapshot.sh > snap.tgz   # 只读快照（密钥类内容已脱敏）
```

## 改东西去哪改

| 想改 | 位置 |
|---|---|
| 参数（编织策略、亲和性、探测地址、DoH 上游、fail-open…） | `braid/etc/config/braid`，常用项也可在页面里改 |
| 国内段 / 强制隧道段 / 强制隧道域名 | `braid/etc/braid/lists/` |
| 中继 | `braid/etc/braid/relays.json`（`--secrets` 才会推送） |
| 本机应有的 UCI 值、IRQ 亲和 | `braid/etc/braid/provision.json` |
| 新网络是否聚合 | 页面概览页"记住这个网络并聚合"，或 `braid/etc/config/braid` 里加 `config site` |
| 设备命名 / 按设备分流 | 页面"设备"页 |
| 换 portal | `usr/share/braid/portal/` 加一个插件，在 `mod/strands.uc` 的 `PORTALS` 登记 |
| 换编织策略 | `mod/weave.uc` 的 `POLICIES` |
| 页面允许改哪些参数 | `lib/config.uc` 的 `TUNABLE` |
| nft 规则骨架 | `usr/share/braid/tpl/braid.nft.ut` |

## 版本管理

本地 git 仓库，`main` 分支。中继凭据（`relays.json`）和 mihomo 二进制不入库，见
`.gitignore`；所有文本文件强制 LF（路由器直接执行它们），见 `.gitattributes`。
路由器上的 `/etc/config/braid` 归路由器所有，仓库里那份是初始模板。

## 应急

```sh
/etc/init.d/braid stop      # fail_open=0 时保留独立防泄露保护；受保护设备公共流量断开
/etc/init.d/braid start
```

最初 v1 的文件备份在路由器 `/etc/braid/backup-v1.tgz`（仅文件，不会自动启用）。

`fail_open=0` 也覆盖启动和停止期间的 DNS：解析器不可用就失败，不改用上游。
独立 `inet braid_guard` 由 fw4 在启动/重载时加载，保留局域网、明确设为直连的
设备、固定 IP 节点的实际传输端口和 `tunnel.guard_ssh4` 指定的 SSH 地址。
普通设备的中国直连在 Braid 正常运行时保留；整项服务停止时也暂停。
不要开启 flow offload，它会绕过逐包的保护检查，体检会报告此错误。

`tools/test-privacy-netns.sh` 在路由器三个完全隔离的网络命名空间里验证直连、
强制代理、停止服务和防火墙重载的保护。测试目标均在测试命名空间内，不访问互联网。
