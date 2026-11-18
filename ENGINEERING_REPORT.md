# Prism 5.8.0 engineering report

Redmi AX6000, 18 November 2026. Repository base `dac9c99`. The live system reported Linux 6.12.103, 100 Mbps full duplex, 488,996 kB total RAM, 76,428 kB initially available, zero swap and both firewall offload flags at zero. Runtime events were in `/tmp/prism/events.log`. The event history included 21 → 19 → 21 healthy strands. Four named-counter JSON parse errors were present in the retained system log.

| Finding | Change and evidence |
|---|---|
| Several postrouting lookups incremented the same per-strand counter. HTB class drops missed drops at the fq_codel leaves. | One WAN membership lookup now accounts each transmitted packet. The namespace test compared that counter with an independent postrouting counter. QoS reads leaf drops and class overlimits separately. |
| Sub-CIR traffic could deplete virtual burst credit. Latency also counted as probe failure. | Integrate delivered bytes and elapsed CIR separately in each direction, bound credit at 1 MB and weight by available capacity. A changed lease must pass its 204 probe. The first transient timeout on a confirmed path no longer submits portal credentials. VIP selection accounts for active MPTCP endpoints. |
| Device discovery spawned repeated ip processes. A regular conntrack scan read around 770 KiB every two seconds. Controller reads competed with the sampler. | Native rtnetlink reduced the eight-device scan from 111–115 ms to 6.7–7.1 ms in the initial paired run. Strand counters run every second. Controller and QoS samples run about every four seconds. The privileged flow view requests one background scan, retains the largest 400 rows per source and returns monotonic sample times. A cold call returned in 0.8 ms, with 40 live direct rows available after 141 ms. |
| Relay IP 18.176.216.3 also belonged to the domestic set. Historical IPs and independently updated guard and admission sets could disagree with lease ownership. | Match relay protocol and port, divert remaining relay ports before domestic lookup, and update guard and datapath together. Preserve the forced-domain entries during table rebuild. Current DHCP and LAN evidence determines admitted pairs. Lease changes take effect at the next completed reconciliation. Per-device listeners enforce IN-NAME routing and manual relay choices are persisted after controller acceptance. |
| The existing shaper allowed large bursts and queue memory on a shared 100 Mbps port. Generous socket defaults and conntrack limits competed with Mihomo on a swapless system. | Retain 95 Mbps WAN and 90 Mbps LAN shaping. HTB allows approximately 4 ms of burst at these rates. Each direction has 2.25 MiB of configured fq_codel memory across three classes. Reduce socket defaults, cap autotuned TCP buffers at 8 MiB and conntrack at 65,536 entries. The namespace shaper converged at both 95 and 9 Mbps. |

The kernel still owns connection placement and NAT state. Six MPTCP endpoints and five additional subflows limit per-connection overhead. Independent 10 Mbps hard shapers would discard the authorized burst allowance. Separate nft reads were retained because batching set-list requests on the installed nft returned incomplete results. Production forwarding, sysctls and services remained untouched. End-to-end throughput, loaded latency and steady-state memory under the new settings require a deployed comparison.

## Verification

Run these commands from the repository root in Git Bash. Local checks completed with `version OK: 5.8.0`, 69 LF-clean text files and exact ACL coverage of all 21 methods. Node and shell syntax checks exited zero.

```bash
set -e
git diff --check
./tools/version.sh --check
find prism/www/prism/js -name '*.js' -print0 | xargs -0 -n1 node --check
for f in tools/{rehearse,test-privacy-netns,test-backend,version}.sh; do bash -n "$f"; done
python - <<'PY'
from pathlib import Path
import json, re
texts = [p for p in Path("prism").rglob("*") if p.is_file() and b"\0" not in p.read_bytes()]
assert all(b"\r" not in p.read_bytes() for p in texts)
api = Path("prism/usr/share/prism/mod/api.uc").read_text(encoding="utf-8")
acl = json.loads(Path("prism/usr/share/rpcd/acl.d/prism.json").read_bytes())
methods = set(re.findall(r"^\t\t(\w+): \{$", api, re.M))
grants = {m for role in acl.values() for access in ("read", "write")
          for m in role.get(access, {}).get("ubus", {}).get("prism", [])}
assert methods == grants
print("LF_OK", len(texts), "ACL_OK", len(methods))
PY
```

The full plan reported 21 of 21 healthy and `OK  fail=0 warn=0`. The private ubus fixture passed history wraparound, burst-credit integration, largest-flow retention, lease reassignment, 11 isolated listener routes, saved selection, cached reads and counter reset. The privacy namespaces verified allowed traffic, zero WAN packets on blocked cases, one upload count, packet-only direct permission, service stop, first boot and fw4 include reload.

```bash
./tools/rehearse.sh plan --full
./tools/rsh 'sh -s' < tools/test-backend.sh
./tools/rsh 'sh -s' < tools/test-privacy-netns.sh
```

Strict compilation and module loads passed. Both nft files passed kernel validation, and Mihomo accepted the generated configuration. The generated rules placed forced ranges and domains before both domestic sets. SmartDNS used the loopback resolver and distinct domestic and tunnel sets. All 51 sysctl keys existed. The final namespace and scratch-directory checks produced no output. Standard rehearsal output is under `/tmp/prism-rehearsal/run/plan`.

```bash
./tools/rsh 'sh -s' <<'ROUTER'
set -e
d=/tmp/prism-rehearsal
p=$d/run/plan
cd "$d/tree/usr/share/prism"
for f in prism.uc prismd.uc bin/dhcp.uc; do ucode -S -c -o /dev/null "$f"; done
for f in lib/*.uc mod/*.uc portal/*.uc; do ucode -S -e "import * as m from './$f';"; done
nft -c -f "$p/guard.nft"
nft -c -f "$p/ruleset.nft"
SAFE_PATHS="$d/etc" "$d/run/mihomo" -t -d "$d/run" -f "$p/mihomo.yaml"
awk '/comment "(unverified-drop|relay-other-port|tunnel-range|tunnel-domain|domestic|domestic-domain|rest-tunnel)"/ {print NR,$NF}' "$p/ruleset.nft"
awk '/^bind |^server 127.0.0.1|^nftset / {print}' "$p/smartdns.conf"
n=0
while IFS='=' read -r key val; do
    case "$key" in ""|\#*) continue;; esac
    test -r "/proc/sys/$(echo "$key" | tr . /)"
    n=$((n+1))
done < "$d/tree/etc/sysctl.d/99-prism.conf"
echo "STRICT_LOAD_OK $n sysctls"
ip netns list
find /tmp -maxdepth 1 \( -name 'prism-daemon-test.*' -o -name 'prism-privacy.*' -o -name 'prism-probe.*' \) -print
ROUTER
```

<details>
<summary>On-router timing commands</summary>

The first command alternates installed and staged code, eight scans per batch. A repeat measured 116.0 and 103.6 ms installed, 6.7 and 6.7 ms staged. The second uses the staged API against read-only live conntrack and records the first reply and first completed direct sample.

```bash
./tools/rsh 'sh -s' <<'ROUTER'
set -e
cd /tmp/prism-rehearsal/tree/usr/share/prism && ucode -S -e 'import * as old from "/usr/share/prism/mod/devices.uc"; import * as fresh from "./mod/devices.uc"; import * as config from "./lib/config.uc"; let cfg=config.load(); let ms=()=>{let t=clock(true);return t[0]*1000+t[1]/1e6;}; for (let probe in [old.scan,fresh.scan,old.scan,fresh.scan]) {let start=ms(), rows;for(let i=0;i<8;i++) rows=probe(cfg);printf("%.1f ms/scan, %d devices\n",(ms()-start)/8,length(rows));}'
set -e; cd /tmp/prism-rehearsal/tree/usr/share/prism; ucode -S -e 'import * as a from "./mod/api.uc"; import * as u from "uloop"; import * as fs from "fs";u.init();let s=json(fs.readfile("/tmp/prism/status.json"));let now=()=>{let t=clock(true);return t[0]+t[1]/1e9;};let api=a.methods({snapshot:()=>s,now,tunnel_flows:()=>[],tunnel_sampled:()=>0});let start=now(), cold=api.connections.call();printf("cold reply %.1f ms\n",(now()-start)*1000);let timer=u.interval(20,()=>{let x=api.connections.call();if(x.sampled.direct){printf("%d direct rows, ready in %.0f ms\n",length(x.connections),(now()-start)*1000);for(let f in x.connections)assert(length(f.via));u.end();}});u.timer(5000,()=>{die("worker timeout");});u.run();'
ROUTER
```

</details>

## Post-deploy maintenance fix and verification

Following initial router deployment (`e08a659`), live `logread` surfaced a strict-mode forward call in `mod/tunnel.uc` (`sync_selected` calling `persist_selected` before its export declaration). Moving `persist_selected` ahead of `sync_selected` and adding `usr/share/prism/bin` to the `tools/deploy.sh` rollback archive resolved this (`f7b8a1f`). Full local checks, rehearsal, `test-backend.sh`, `test-privacy-netns.sh`, `./tools/deploy.sh` (`DEPLOY_OK`, `OK  fail=0 warn=0`), live `tunnel.sync_selected`, and post-deploy `ubus` / `logread` checks all passed (`21/21` healthy, `mptcp_subflows=5`).
