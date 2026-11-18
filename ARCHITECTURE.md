# Prism on the Redmi AX6000

The 100 Mbps WAN carries a parent interface and up to twenty addressed macvlan children. Prism assigns new connections to healthy strands. The kernel retains the strand for the life of each connection. Per-device Mihomo listeners implement manual relay selection. The detailed packet path, mark allocation, probe policy and shaper settings are in the [router architecture](prism/etc/prism/ARCHITECTURE.md).

The reconciler owns policy, MPTCP endpoints and admission. The long-lived daemon samples kernel counters, adjusts slot weights and serves the dashboard. The fw4 include installs the forwarding guard independently of either process. Project overview, deployment and test runbooks live in [README](README.md); interface, routing and release verification contracts are documented in the [ubus API](API.md), [device routing design](DEVICE_ROUTING_DESIGN.md), and the [5.8.0 engineering report](ENGINEERING_REPORT.md).
