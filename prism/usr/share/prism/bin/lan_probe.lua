#!/usr/bin/lua
-- Probe LAN clients by IP for NetBIOS (:137) and unicast mDNS PTR (:5353) hostnames.
-- Reads/updates /tmp/prism/lan_names.json safely with short non-blocking timeouts.

local nixio = require("nixio")

local RUN_DIR = os.getenv("PRISM_RUN") or "/tmp/prism"
local CACHE_FILE = RUN_DIR .. "/lan_names.json"

local function trim(s)
	return (s:gsub("^%s+", ""):gsub("%s+$", ""))
end

local function nbns_encode_wildcard()
	local raw = "*" .. string.rep("\0", 15)
	local out = { string.char(32) }
	for i = 1, 16 do
		local b = raw:byte(i)
		out[#out + 1] = string.char(65 + math.floor(b / 16), 65 + (b % 16))
	end
	out[#out + 1] = "\0"
	return table.concat(out)
end

local function u16(s, i)
	local a, b = s:byte(i, i + 1)
	if not a or not b then return nil end
	return a * 256 + b
end

local function skip_dns_name(buf, i)
	local len = #buf
	local jumped = false
	local hops = 0
	while i <= len and hops < 32 do
		local b = buf:byte(i)
		if b == 0 then
			return i + 1
		elseif b >= 192 then
			return i + 2
		else
			i = i + 1 + b
		end
		hops = hops + 1
	end
	return nil
end

local function read_dns_name(buf, i)
	local parts = {}
	local len = #buf
	local hops = 0
	while i <= len and hops < 40 do
		local b = buf:byte(i)
		if b == 0 then
			break
		elseif b >= 192 then
			local b2 = buf:byte(i + 1)
			if not b2 then break end
			i = ((b - 192) * 256 + b2) + 1
		else
			if i + b > len then break end
			parts[#parts + 1] = buf:sub(i + 1, i + b)
			i = i + 1 + b
		end
		hops = hops + 1
	end
	return table.concat(parts, ".")
end

local function probe_nbstat(ip)
	local sock = nixio.socket("inet", "dgram")
	if not sock then return nil end
	sock:setblocking(false)
	local pkt = string.char(0x81, 0x01, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0)
		.. nbns_encode_wildcard()
		.. string.char(0, 0x21, 0, 1)
	sock:sendto(pkt, ip, 137)
	local deadline = os.time() + 1
	local resp
	for _ = 1, 6 do
		local r = nixio.poll({ { fd = sock, events = nixio.poll_flags("in") } }, 40)
		if r and r > 0 then
			resp = sock:recvfrom(1024)
			if resp and #resp > 56 then break end
		end
		if os.time() >= deadline then break end
	end
	sock:close()
	if not resp or #resp < 56 then return nil end
	local an = u16(resp, 7) or 0
	if an < 1 then return nil end
	local pos = skip_dns_name(resp, 13)
	if not pos or pos + 10 > #resp then return nil end
	pos = pos + 10 -- type(2) + class(2) + ttl(4) + rdlen(2)
	local num = resp:byte(pos)
	pos = pos + 1
	if not num or num < 1 then return nil end
	for _ = 1, math.min(num, 16) do
		if pos + 17 > #resp then break end
		local name = trim(resp:sub(pos, pos + 14))
		local suffix = resp:byte(pos + 15)
		local flags = u16(resp, pos + 16) or 0
		if (flags < 32768) and (suffix == 0 or suffix == 32) and #name > 0 and not name:match("^__") then
			return name:gsub("[^%w%._%-]", "")
		end
		pos = pos + 18
	end
	return nil
end

local function encode_ptr_qname(ip)
	local a, b, c, d = ip:match("^(%d+)%.(%d+)%.(%d+)%.(%d+)$")
	if not a then return nil end
	local labels = { d, c, b, a, "in-addr", "arpa" }
	local out = {}
	for _, lb in ipairs(labels) do
		out[#out + 1] = string.char(#lb) .. lb
	end
	out[#out + 1] = "\0"
	return table.concat(out)
end

local function probe_mdns_ptr(ip)
	local qname = encode_ptr_qname(ip)
	if not qname then return nil end
	local sock = nixio.socket("inet", "dgram")
	if not sock then return nil end
	sock:setblocking(false)
	local pkt = string.char(0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0)
		.. qname
		.. string.char(0, 0x0c, 0, 1)
	sock:sendto(pkt, ip, 5353)
	local resp
	for _ = 1, 6 do
		local r = nixio.poll({ { fd = sock, events = nixio.poll_flags("in") } }, 40)
		if r and r > 0 then
			resp = sock:recvfrom(1024)
			if resp and #resp > 24 then break end
		end
	end
	sock:close()
	if not resp or #resp < 24 then return nil end
	local qd = u16(resp, 5) or 0
	local an = u16(resp, 7) or 0
	if an < 1 then return nil end
	local pos = 13
	for _ = 1, qd do
		pos = skip_dns_name(resp, pos)
		if not pos then return nil end
		pos = pos + 4
	end
	for _ = 1, an do
		local npos = skip_dns_name(resp, pos)
		if not npos or npos + 9 > #resp then break end
		local rtype = u16(resp, npos)
		local rdlen = u16(resp, npos + 8) or 0
		local rdata = npos + 10
		if rtype == 12 and rdata + rdlen - 1 <= #resp then
			local target = read_dns_name(resp, rdata)
			target = target:gsub("%.local%.?$", "")
			if #target > 0 then
				return target:gsub("[^%w%._%-]", "")
			end
		end
		pos = rdata + rdlen
	end
	return nil
end

local function read_cache()
	local f = io.open(CACHE_FILE, "r")
	if not f then return {} end
	local raw = f:read("*a")
	f:close()
	local out = {}
	for ip, body in raw:gmatch('"(%d+%.%d+%.%d+%.%d+)":%s*(%b{})') do
		local ts = tonumber(body:match('"ts":(%d+)')) or 0
		local name = body:match('"name":"([^"]*)"') or ""
		local mac = body:match('"mac":"([^"]*)"') or ""
		out[ip] = { ts = ts, name = name, mac = mac }
	end
	return out
end

local function write_cache(tbl)
	local parts = { "{" }
	local first = true
	for ip, v in pairs(tbl) do
		if not first then parts[#parts + 1] = "," end
		first = false
		parts[#parts + 1] = string.format('"%s":{"ts":%d,"mac":"%s","name":"%s"}',
			ip, v.ts or 0, (v.mac or ""):gsub('[^%da-fA-F:]', ""), (v.name or ""):gsub('["\\]', ""))
	end
	parts[#parts + 1] = "}\n"
	local tmp = CACHE_FILE .. ".tmp." .. tostring(os.time())
	local f = io.open(tmp, "w")
	if f then
		f:write(table.concat(parts))
		f:close()
		os.rename(tmp, CACHE_FILE)
	end
end

local ip = arg[1]
local mac = (arg[2] or ""):lower():gsub('[^%da-f:]', "")
if not ip or not ip:match("^%d+%.%d+%.%d+%.%d+$") then
	os.exit(0)
end

local name = probe_nbstat(ip) or probe_mdns_ptr(ip) or ""
local cache = read_cache()
cache[ip] = { ts = os.time(), mac = mac, name = name }
write_cache(cache)
if #name > 0 then
	print(name)
end
