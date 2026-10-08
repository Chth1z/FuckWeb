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

## 应急

```sh
/etc/init.d/braid stop      # 撤掉全部内核状态，退回普通路由器（DNS 改用上游下发的）
/etc/init.d/braid start
```

最初 v1 的文件备份在路由器 `/etc/braid/backup-v1.tgz`（仅文件，不会自动启用）。
