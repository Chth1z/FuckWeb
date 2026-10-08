// A fixed-length history of load samples, held in the daemon's memory.
// It exists so a freshly opened dashboard has a past to draw.

export function create(capacity) {
	return { capacity, ts: [], total: [], strands: {} };
};

// per: { dev: bytes_per_second } for this sample
export function add(s, ts, total, per) {
	push(s.ts, ts);
	push(s.total, int(total));
	let n = length(s.ts);
	for (let dev, rate in per) {
		let row = (s.strands[dev] ??= map(slice(s.ts, 0, n - 1), () => 0));
		push(row, int(rate));
	}
	// A strand that vanished keeps its row aligned until it scrolls out.
	for (let dev, row in s.strands) {
		if (length(row) < n)
			push(row, 0);
		if (length(row) > s.capacity)
			shift(row);
	}
	if (n > s.capacity) {
		shift(s.ts);
		shift(s.total);
	}
};

export function dump(s, limit) {
	let n = length(s.ts), from = max(0, n - (limit > 0 ? limit : n));
	let strands = {};
	for (let dev, row in s.strands)
		strands[dev] = slice(row, from);
	return { ts: slice(s.ts, from), total: slice(s.total, from), strands };
};
