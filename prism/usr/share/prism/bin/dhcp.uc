// dnsmasq serializes its lease callbacks. Record each event before notifying
// the daemon, including renewals and removals received while it is down.
import * as ubus from "ubus";
import { record_dhcp } from "../mod/identity.uc";

if (record_dhcp({
	action: getenv("ACTION"), mac: getenv("MACADDR"), ip: getenv("IPADDR"),
	host: getenv("DNSMASQ_SUPPLIED_HOSTNAME") || getenv("HOSTNAME"),
	opt55: getenv("DNSMASQ_REQUESTED_OPTIONS"), vendor: getenv("DNSMASQ_VENDOR_CLASS"),
	cid: getenv("DNSMASQ_CLIENT_ID"), iface: getenv("DNSMASQ_INTERFACE"),
})) {
	let bus = ubus.connect();
	bus?.call("prism", "reconcile", {});
	bus?.disconnect();
}
