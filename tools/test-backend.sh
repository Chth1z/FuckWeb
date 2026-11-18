#!/bin/sh
# Run on the router after plan --full. Use a private netns, controller and ubus.
# Only the published bus, reconcile executable and LED write mode are substituted.
set -eu
base=/tmp/prism-rehearsal
src=$base/tree/usr/share/prism
cd "$src"
ucode -S -e '
import * as a from "./mod/api.uc";
import * as w from "./mod/weave.uc";
import * as s from "./lib/series.uc";
import * as id from "./mod/identity.uc";
import * as fs from "fs";
let lane={ down:{now:500000}, up:{now:0}, bucket:{tokens:1000000} }, load={wan:lane};
w.update_buckets(load,1,1250000); assert(lane.bucket.tokens==1000000);
lane.up.now=2000000; w.update_buckets(load,0.5,1250000); assert(lane.bucket.tokens==625000);
lane.up.now=4000000; w.update_buckets(load,1,1250000); assert(lane.bucket.tokens==0);
lane.up.now=0; w.update_buckets(load,0.25,1250000); assert(lane.bucket.tokens==312500 && lane.bucket.state=="cooling");
let strands=[{dev:"a",id:1},{dev:"b",id:2},{dev:"c",id:3}];
let even=w.compose({policy:"even"},strands,{},7,[]);
assert(join(",",sort(even))=="1,1,1,2,2,3,3");
let h=s.create(3); for(let i=1;i<=5;i++) s.add(h,i,i*2,i,i>=3?{b:i}:{a:i},{});
let hist=s.dump(h,2); assert(join(",",hist.ts)=="4,5" && join(",",hist.strands.a)=="0,0" && join(",",hist.strands.b)=="4,5");
let mac="02:00:00:00:00:01", ip="10.200.0.2", p={anchor_mac:mac,macs:[{mac}],policy:"auto",fp:{last_ip:ip}};
let tel={leases:{}, neigh:{by_ip:{}}, radio:{}, fdb:{}};
let pairs=()=>id.compute_verified_pairs({profiles:[p]},tel);
assert(!length(pairs())); tel.radio[mac]={}; tel.neigh.by_ip[ip]={mac,active:false}; assert(length(pairs())==1);
tel.leases["02:00:00:00:00:02"]={ip}; assert(!length(pairs()));
tel.leases={[mac]:{ip}}; assert(length(pairs())==1); p.policy="block"; assert(!length(pairs()));
let connections=[];
for (let i=0; i<1000; i++) push(connections,{id:i,metadata:{sourceIP:"10.200.0.2"},download:i});
let top=a.tunnel_flows(connections); assert(length(top)==400 && top[0].key==999 && top[-1].key==600);
let cfg=json(fs.readfile("/tmp/prism-rehearsal/run/plan/mihomo.yaml")), groups={};
for(let g in cfg["proxy-groups"]) {groups[g.name]=g;assert(g.type=="select" && !("DIRECT" in g.proxies) && !("REJECT" in g.proxies));}
assert(groups["TW-HOME"] && cfg.rules[-1]=="MATCH,REJECT");
let links=filter(cfg.listeners,(l)=>l.type=="tproxy"), ports={};
for(let l in links){let rs=filter(cfg.rules,(r)=>index(r,"IN-NAME,"+l.name+",")==0); assert(length(rs)==1 && groups[split(rs[0],",")[2]] && !ports[l.port] && l.udp); ports[l.port]=true;}
print("CONTROL_OK bucket, history wrap, lease reassignment, ",length(links)," isolated listeners\n");
'
tmp=$(mktemp -d /tmp/prism-daemon-test.XXXXXX)
ns=prism-test-$$
buspid= httppid= daemonpid=
cleanup() {
    for p in $daemonpid $httppid $buspid; do kill "$p" 2>/dev/null || true; done
    wait || true
    ip netns del "$ns"
    rm -rf "$tmp"
}
ip netns add "$ns"
trap cleanup EXIT
ip -n "$ns" link set lo up
ip netns exec "$ns" nft -f "$base/run/plan/ruleset.nft"
mkdir "$tmp/run" "$tmp/etc" "$tmp/web" "$tmp/uci"
cp -r "$base/etc/state" "$tmp/etc/"
ln -s /etc/prism/relays.json "$tmp/etc/relays.json"
cp "$base/uci/prism" "$tmp/uci/prism"
ln -s "$src/lib" "$src/mod" "$tmp/"
printf 'fixture' >"$tmp/etc/controller.secret"
printf '{"downloadTotal":123456,"uploadTotal":123,"connections":[{"id":"fixture","metadata":{"sourceIP":"10.200.0.2","destinationIP":"203.0.113.10","destinationPort":"443","network":"tcp"},"download":7,"upload":2}]}' > "$tmp/web/connections"
printf '{"proxies":{"TW-HOME":{"now":"fixture","all":["fixture"]}}}' > "$tmp/web/proxies"
printf '{"lan_ip":"127.0.0.1","weave":{"slots":0},"strands":[{"dev":"wan","id":1,"healthy":true}],"tunnel":{"running":true,"restored":true,"pid":"%s"}}' "$(pidof mihomo)" > "$tmp/run/status.json"
sed -e 's|const PRISM = "/usr/sbin/prism";|const PRISM = "/bin/true";|' -e 's|^let bus = ubus.connect();|let bus = ubus.connect(getenv("TEST_BUS"));|' -e '/^core.init_dirs();/i core.set_mode({ dry: true });' "$src/prismd.uc" > "$tmp/prismd.uc"
cd "$tmp"
export STAGED_VERSION="$src/VERSION"
ubusd -s "$tmp/ubus.sock" >"$tmp/bus.log" 2>&1 & buspid=$!
ip netns exec "$ns" uhttpd -f -h "$tmp/web" -p 127.0.0.1:9090 >"$tmp/http.log" 2>&1 & httppid=$!
export PRISM_RUN="$tmp/run" PRISM_ETC="$tmp/etc" PRISM_UCI="$tmp/uci" TEST_BUS="$tmp/ubus.sock"
ip netns exec "$ns" ucode -S "$tmp/prismd.uc" >"$tmp/daemon.log" 2>&1 & daemonpid=$!
for i in $(seq 1 10); do
    sleep 1
    if ! kill -0 "$daemonpid" 2>/dev/null; then cat "$tmp/daemon.log"; exit 1; fi
    ubus -s "$TEST_BUS" call prism status >"$tmp/status" 2>/dev/null || continue
    [ "$(jsonfilter -i "$tmp/status" -e '@.telemetry.branches.tunnel.down_bytes')" = 123456 ] || continue
    [ "$(jsonfilter -i "$tmp/etc/state/device_relays.json" -e '@._tw_home')" = fixture ] || continue
    ubus -s "$TEST_BUS" call prism connections >"$tmp/warm"
    [ "$(jsonfilter -i "$tmp/warm" -e '@.sampled.direct')" = 0 ] || break
done
cat "$tmp/daemon.log"
ubus -s "$TEST_BUS" call prism status >"$tmp/status"
ubus -s "$TEST_BUS" call prism connections >"$tmp/conns"
ubus -s "$TEST_BUS" call prism tunnel >"$tmp/tunnel"
ubus -s "$TEST_BUS" call prism rules >"$tmp/rules"
ubus -s "$TEST_BUS" call prism devices >"$tmp/devices"
ubus -s "$TEST_BUS" call prism connections >"$tmp/repeat"
ucode -S -e '
import * as fs from "fs";
let get = (p) => json(fs.readfile(p));
let status = get("status"), flows = get("conns");
assert(status.version == trim(fs.readfile(getenv("STAGED_VERSION"))));
assert(status.telemetry.branches.tunnel.down_bytes == 123456);
assert(flows.connections[0].key == "fixture" && flows.sampled.tunnel > 0 && flows.sampled.direct > 0);
let repeated = get("repeat").sampled;
assert(repeated.direct == flows.sampled.direct && repeated.tunnel == flows.sampled.tunnel);
assert(get("tunnel").tw_home == "fixture", "selector missing from ubus");
assert(get("etc/state/device_relays.json")._tw_home == "fixture", "selector missing from disk");
assert(length(get("rules").rules) > 5 && length(get("devices").devices) > 0);
'
printf '{"downloadTotal":3,"uploadTotal":1,"connections":[]}' >"$tmp/web/counters.new"
mv "$tmp/web/counters.new" "$tmp/web/connections"
for i in $(seq 1 10); do
    sleep 1
    ubus -s "$TEST_BUS" call prism status >"$tmp/reset"
    [ "$(jsonfilter -i "$tmp/reset" -e '@.telemetry.branches.tunnel.down_bytes')" != 3 ] || break
done
ubus -s "$TEST_BUS" call prism connections >"$tmp/after"
ucode -S -e '
import * as fs from "fs";
let get = (p) => json(fs.readfile(p));
let status = get("reset"), t = status.telemetry.branches.tunnel;
assert(t.reachable && t.down_bytes == 3 && t.up_bytes == 1 && t.down_bps == 0 && t.up_bps == 0);
let after = get("after");
assert(after.sampled.tunnel > get("conns").sampled.tunnel && !length(after.connections));
print("PRIVATE_UBUS_OK ", status.version, " cached reads, selector persistence, counter reset\n");
'
