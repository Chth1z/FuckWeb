-- Render a stock mihomo YAML from /etc/hotel/proxy-nodes.json.
-- nft + SmartDNS classify; mihomo proxies leftover public unicast.
-- Claude / Cloudflare rules are extra PROXY matches, not separate groups.
-- No FakeIP, no GeoSite.dat.

local ok_jsonc, jsonc = pcall(require, "luci.jsonc")
if not ok_jsonc then
	ok_jsonc, jsonc = pcall(require, "cjson")
end
if not ok_jsonc or not jsonc then
	io.stderr:write("mihomo-render: luci.jsonc/cjson missing\n")
	os.exit(1)
end

local function parse(s)
	if jsonc.parse then
		return jsonc.parse(s)
	end
	return jsonc.decode(s)
end

local function read(path)
	local f = io.open(path, "r")
	if not f then return nil end
	local s = f:read("*a")
	f:close()
	return s
end

local function trim(s)
	return (s or ""):gsub("^%s+", ""):gsub("%s+$", "")
end

local function yq(s)
	return '"' .. tostring(s or ""):gsub("\\", "\\\\"):gsub('"', '\\"') .. '"'
end

local function is_array(t)
	if type(t) ~= "table" then return false end
	local n = 0
	for k, _ in pairs(t) do
		if type(k) ~= "number" then return false end
		n = n + 1
	end
	return n > 0 or t[1] ~= nil or next(t) == nil
end

local function table_get(t, k)
	if type(t) == "table" then return t[k] end
	return nil
end

local function is_ipv4(s)
	return type(s) == "string" and s:match("^%d+%.%d+%.%d+%.%d+$") ~= nil
end

local nodes = parse(read("/etc/hotel/proxy-nodes.json") or "[]") or {}
if type(nodes) ~= "table" then
	io.stderr:write("mihomo-render: proxy-nodes.json must be an array\n")
	os.exit(1)
end
if not is_array(nodes) then
	if nodes.outbounds and is_array(nodes.outbounds) then
		nodes = nodes.outbounds
	elseif nodes.type then
		nodes = { nodes }
	else
		io.stderr:write("mihomo-render: proxy-nodes.json must be an array\n")
		os.exit(1)
	end
end

local policy = read("/etc/hotel/policy") or ""
local tlisten = policy:match("TPROXY_LISTEN=([%d.]+)") or "198.51.100.1"
local tport = policy:match("TPROXY_PORT=(%d+)") or "61235"
local mixed = policy:match("MIXED_PORT=(%d+)") or "7890"
local lan = trim(read("/tmp/hotel/lan.ip") or "")
if lan == "" then lan = "192.168.16.1" end
local secret = trim(read("/etc/hotel/clash.secret") or "")

local names = {}
local lines = {}
local dst_ips = {}
local dst_hosts = {}
local seen = {}

local function push_name(name)
	if not name or name == "" or seen[name] then return end
	seen[name] = true
	table.insert(names, name)
end

local function emit_tls(node, indent)
	local tls = table_get(node, "tls") or {}
	local utls = table_get(tls, "utls") or {}
	local reality = table_get(tls, "reality") or {}
	if tls.server_name then
		table.insert(lines, indent .. "servername: " .. yq(tls.server_name))
	end
	local fp = utls.fingerprint or node.fingerprint
	if fp then
		table.insert(lines, indent .. "client-fingerprint: " .. yq(fp))
	end
	if tls.insecure then
		table.insert(lines, indent .. "skip-cert-verify: true")
	end
	if reality.enabled or reality.public_key then
		table.insert(lines, indent .. "reality-opts:")
		table.insert(lines, indent .. "  public-key: " .. yq(reality.public_key or ""))
		if reality.short_id then
			table.insert(lines, indent .. "  short-id: " .. yq(reality.short_id))
		end
	end
end

local function emit_node(node)
	local t = node.type
	if t == "hysteria2" or t == "hysteria" then
		local tls = table_get(node, "tls") or {}
		local obfs = table_get(node, "obfs") or {}
		local hop = node.hop_ports or node.ports
		table.insert(lines, "  - name: " .. yq(node.tag))
		table.insert(lines, "    type: hysteria2")
		table.insert(lines, "    server: " .. yq(node.server))
		table.insert(lines, "    port: " .. tostring(node.server_port or 443))
		if type(hop) == "string" and hop ~= "" then
			table.insert(lines, "    ports: " .. yq(hop))
		end
		table.insert(lines, "    password: " .. yq(node.password))
		if tls.server_name then
			table.insert(lines, "    sni: " .. yq(tls.server_name))
		end
		if tls.insecure then
			table.insert(lines, "    skip-cert-verify: true")
		end
		table.insert(lines, "    alpn:")
		table.insert(lines, "      - h3")
		if obfs.type then
			table.insert(lines, "    obfs: " .. yq(obfs.type))
		end
		if obfs.password then
			table.insert(lines, "    obfs-password: " .. yq(obfs.password))
		end
		return true
	end
	if t == "vless" then
		local tls = table_get(node, "tls") or {}
		table.insert(lines, "  - name: " .. yq(node.tag))
		table.insert(lines, "    type: vless")
		table.insert(lines, "    server: " .. yq(node.server))
		table.insert(lines, "    port: " .. tostring(node.server_port or 443))
		table.insert(lines, "    uuid: " .. yq(node.uuid))
		table.insert(lines, "    network: tcp")
		table.insert(lines, "    udp: true")
		table.insert(lines, "    tls: true")
		if type(node.flow) == "string" and node.flow ~= "" then
			table.insert(lines, "    flow: " .. yq(node.flow))
		end
		if type(node.encryption) == "string" and node.encryption ~= "" then
			table.insert(lines, "    encryption: " .. yq(node.encryption))
		end
		if type(node.packet_encoding) == "string" and node.packet_encoding ~= "" then
			table.insert(lines, "    packet-encoding: " .. yq(node.packet_encoding))
		end
		emit_tls(node, "    ")
		return true
	end
	if t == "trojan" then
		table.insert(lines, "  - name: " .. yq(node.tag))
		table.insert(lines, "    type: trojan")
		table.insert(lines, "    server: " .. yq(node.server))
		table.insert(lines, "    port: " .. tostring(node.server_port or 443))
		table.insert(lines, "    password: " .. yq(node.password))
		table.insert(lines, "    udp: true")
		emit_tls(node, "    ")
		return true
	end
	if t == "ss" or t == "shadowsocks" then
		table.insert(lines, "  - name: " .. yq(node.tag))
		table.insert(lines, "    type: ss")
		table.insert(lines, "    server: " .. yq(node.server))
		table.insert(lines, "    port: " .. tostring(node.server_port or 443))
		table.insert(lines, "    cipher: " .. yq(node.method or node.cipher or "aes-128-gcm"))
		table.insert(lines, "    password: " .. yq(node.password))
		table.insert(lines, "    udp: true")
		return true
	end
	if t == "vmess" then
		table.insert(lines, "  - name: " .. yq(node.tag))
		table.insert(lines, "    type: vmess")
		table.insert(lines, "    server: " .. yq(node.server))
		table.insert(lines, "    port: " .. tostring(node.server_port or 443))
		table.insert(lines, "    uuid: " .. yq(node.uuid))
		table.insert(lines, "    alterId: " .. tostring(node.alter_id or node.alterId or 0))
		table.insert(lines, "    cipher: " .. yq(node.security or node.cipher or "auto"))
		table.insert(lines, "    udp: true")
		local tls = table_get(node, "tls") or {}
		if tls.enabled or node.tls == true then
			table.insert(lines, "    tls: true")
		end
		emit_tls(node, "    ")
		return true
	end
	return false
end

for _, node in ipairs(nodes) do
	if type(node) == "table" and node.tag and node.type then
		if node.type ~= "selector" and node.type ~= "urltest" and node.type ~= "direct"
			and node.type ~= "block" and node.type ~= "dns" then
			if emit_node(node) then
				push_name(node.tag)
				local ip = node.server
				if is_ipv4(ip) then
					dst_ips[ip] = true
				elseif type(ip) == "string" and ip ~= "" then
					dst_hosts[ip] = true
				end
			else
				io.stderr:write("mihomo-render: skip unsupported type " .. tostring(node.type) .. "\n")
			end
		end
	end
end

local ns_proxy = #names > 0 and "PROXY" or nil

local claude_dns_suffix = {
	"anthropic.com", "claude.ai", "claude.com", "clau.de",
	"claudemcpclient.com", "claudemcpcontent.com", "claudeusercontent.com",
	"sentry.io", "statsigapi.net", "statsig.com", "featuregates.org",
	"prodregistryv2.org", "intercom.io", "intercomcdn.com",
	"datadoghq.com", "datadoghq.eu", "sift.com", "siftscience.com",
	"ntp.org", "cloudflare.com", "cloudflareinsights.com",
}
local claude_dns_exact = {
	"servd-anthropic-website.b-cdn.net",
	"anthropic.com.cdn.cloudflare.net",
	"anthropic.auth0.com",
	"anthropic-com.ghost.io",
	"browser-intake-us5-datadoghq.com",
	"cdn.usefathom.com",
	"time.google.com",
	"time.cloudflare.com",
	"time.apple.com",
	"time.windows.com",
	"time.nist.gov",
	"ntp.ubuntu.com",
	"one.one.one.one",
}

local claude_rules = {
	"DOMAIN-SUFFIX,anthropic.com",
	"DOMAIN-SUFFIX,claude.ai",
	"DOMAIN-SUFFIX,claude.com",
	"DOMAIN-SUFFIX,clau.de",
	"DOMAIN-SUFFIX,claudemcpclient.com",
	"DOMAIN-SUFFIX,claudemcpcontent.com",
	"DOMAIN-SUFFIX,claudeusercontent.com",
	"DOMAIN,servd-anthropic-website.b-cdn.net",
	"DOMAIN,anthropic.com.cdn.cloudflare.net",
	"DOMAIN,anthropic.auth0.com",
	"DOMAIN,anthropic-com.ghost.io",
	"DOMAIN-SUFFIX,sentry.io",
	"DOMAIN-SUFFIX,statsigapi.net",
	"DOMAIN-SUFFIX,statsig.com",
	"DOMAIN-SUFFIX,featuregates.org",
	"DOMAIN-SUFFIX,prodregistryv2.org",
	"DOMAIN,browser-intake-us5-datadoghq.com",
	"DOMAIN-KEYWORD,datadog",
	"DOMAIN-KEYWORD,sentry",
	"DOMAIN-KEYWORD,sift",
	"DOMAIN-SUFFIX,intercom.io",
	"DOMAIN-SUFFIX,intercomcdn.com",
	"DOMAIN,cdn.usefathom.com",
	"DOMAIN-SUFFIX,cloudflare.com",
	"DOMAIN-SUFFIX,cloudflareinsights.com",
	"DOMAIN,one.one.one.one",
	"IP-CIDR,1.1.1.1/32",
	"IP-CIDR,1.0.0.1/32",
	"DOMAIN-SUFFIX,ntp.org",
	"DOMAIN,time.google.com",
	"DOMAIN,time.cloudflare.com",
	"DOMAIN,time.apple.com",
	"DOMAIN,time.windows.com",
	"DOMAIN,time.nist.gov",
	"DOMAIN,ntp.ubuntu.com",
	"DST-PORT,123",
	"IP-CIDR,160.79.104.0/21",
	"IP-CIDR6,2607:6bc0::/32",
}

local out = {}
table.insert(out, "mode: rule")
table.insert(out, "log-level: error")
table.insert(out, "ipv6: false")
table.insert(out, "allow-lan: false")
table.insert(out, "find-process-mode: off")
table.insert(out, "unified-delay: true")
table.insert(out, "tcp-concurrent: true")
table.insert(out, "geodata-mode: false")
table.insert(out, "geo-auto-update: false")
table.insert(out, "keep-alive-interval: 30")
table.insert(out, "profile:")
table.insert(out, "  store-selected: true")
table.insert(out, "  store-fake-ip: false")
table.insert(out, "tun:")
table.insert(out, "  enable: false")
table.insert(out, "sniffer:")
table.insert(out, "  enable: true")
table.insert(out, "  override-destination: false")
table.insert(out, "  parse-pure-ip: false")
table.insert(out, "  force-dns-mapping: true")
table.insert(out, "  sniff:")
table.insert(out, "    HTTP:")
table.insert(out, "      ports: [80]")
table.insert(out, "    TLS:")
table.insert(out, "      ports: [443, 8443]")
table.insert(out, "external-controller: " .. lan .. ":9090")
if secret ~= "" then
	table.insert(out, "secret: " .. yq(secret))
end
table.insert(out, "external-ui: /etc/hotel/zashboard")
table.insert(out, "dns:")
table.insert(out, "  enable: true")
table.insert(out, "  listen: 127.0.0.1:5553")
table.insert(out, "  ipv6: false")
table.insert(out, "  enhanced-mode: redir-host")
table.insert(out, "  cache-algorithm: arc")
table.insert(out, "  use-hosts: false")
table.insert(out, "  use-system-hosts: false")
table.insert(out, "  respect-rules: false")
table.insert(out, "  default-nameserver:")
table.insert(out, "    - 1.1.1.1")
table.insert(out, "  proxy-server-nameserver:")
table.insert(out, "    - " .. yq("https://1.1.1.1/dns-query"))
table.insert(out, "  nameserver:")
if ns_proxy then
	table.insert(out, "    - " .. yq("https://1.1.1.1/dns-query#PROXY"))
else
	table.insert(out, "    - 223.5.5.5")
	table.insert(out, "    - 223.6.6.6")
end
if ns_proxy then
	table.insert(out, "  nameserver-policy:")
	for _, d in ipairs(claude_dns_suffix) do
		table.insert(out, "    \"+." .. d .. "\": " .. yq("https://1.1.1.1/dns-query#" .. ns_proxy))
	end
	for _, d in ipairs(claude_dns_exact) do
		table.insert(out, "    " .. yq(d) .. ": " .. yq("https://1.1.1.1/dns-query#" .. ns_proxy))
	end
end
table.insert(out, "listeners:")
table.insert(out, "  - name: mixed-in")
table.insert(out, "    type: mixed")
table.insert(out, "    port: " .. mixed)
table.insert(out, "    listen: 127.0.0.1")
table.insert(out, "  - name: tproxy-in")
table.insert(out, "    type: tproxy")
table.insert(out, "    port: " .. tport)
table.insert(out, "    listen: " .. tlisten)
table.insert(out, "    udp: true")
table.insert(out, "proxies:")
if #lines == 0 then
	table.insert(out, "  []")
else
	for _, line in ipairs(lines) do
		table.insert(out, line)
	end
end
table.insert(out, "proxy-groups:")
if #names > 0 then
	table.insert(out, "  - name: AUTO")
	table.insert(out, "    type: url-test")
	table.insert(out, "    url: https://www.gstatic.com/generate_204")
	table.insert(out, "    interval: 600")
	table.insert(out, "    tolerance: 80")
	table.insert(out, "    lazy: true")
	table.insert(out, "    expected-status: 204")
	table.insert(out, "    proxies:")
	for _, name in ipairs(names) do
		table.insert(out, "      - " .. yq(name))
	end
	table.insert(out, "  - name: PROXY")
	table.insert(out, "    type: select")
	table.insert(out, "    proxies:")
	table.insert(out, "      - AUTO")
	for _, name in ipairs(names) do
		table.insert(out, "      - " .. yq(name))
	end
	table.insert(out, "      - DIRECT")
else
	table.insert(out, "  - name: PROXY")
	table.insert(out, "    type: select")
	table.insert(out, "    proxies:")
	table.insert(out, "      - DIRECT")
end
table.insert(out, "rules:")
for _, r in ipairs(claude_rules) do
	if r:match("^IP%-CIDR") then
		table.insert(out, "  - " .. r .. ",PROXY,no-resolve")
	else
		table.insert(out, "  - " .. r .. ",PROXY")
	end
end
table.insert(out, "  - MATCH,PROXY")
table.insert(out, "")

local f = io.open("/etc/hotel/mihomo.yaml", "w")
if not f then
	io.stderr:write("mihomo-render: cannot write mihomo.yaml\n")
	os.exit(1)
end
f:write(table.concat(out, "\n"))
f:close()

local ipf = io.open("/tmp/hotel/sb_dst4.ips", "w")
if ipf then
	for ip, _ in pairs(dst_ips) do
		ipf:write(ip .. "\n")
	end
	ipf:close()
end

local hf = io.open("/tmp/hotel/sb_dst_hosts", "w")
if hf then
	for host, _ in pairs(dst_hosts) do
		hf:write(host .. "\n")
	end
	hf:close()
end

local tf = io.open("/tmp/hotel/proxy.tags", "w")
if tf then
	for _, name in ipairs(names) do
		tf:write(name .. "\n")
	end
	tf:close()
end

print("nodes=" .. #names)
os.exit(#names > 0 and 0 or 2)
