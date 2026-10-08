#!/bin/sh
# Datapath seam. Adapters live in /usr/lib/hotel/datapath/<name>.sh
# Commands: apply | egress | teardown

hotel_datapath_bin() {
	echo "/usr/lib/hotel/datapath/${DATAPATH:-ecmp10}.sh"
}

hotel_datapath_apply() {
	impl=$(hotel_datapath_bin)
	if [ ! -f "$impl" ]; then
		echo "NO_DATAPATH ${DATAPATH:-}"
		return 1
	fi
	/bin/sh "$impl" apply
}

hotel_datapath_egress() {
	impl=$(hotel_datapath_bin)
	[ -f "$impl" ] || return 0
	/bin/sh "$impl" egress
}

hotel_datapath_teardown() {
	impl=$(hotel_datapath_bin)
	[ -f "$impl" ] || return 0
	/bin/sh "$impl" teardown
}
