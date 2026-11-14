// A fixed-length history of load samples, held in the daemon's memory.
// It exists so a freshly opened dashboard has a past to draw.

export function create(capacity) {
	return { capacity, ts: [], total: [], up: [], strands: {}, strands_up: {} };
};

// per: { dev: download bytes_per_second }, per_up: { dev: upload bytes_per_second }
export function add(s, ts, total, up, per, per_up) {
	push(s.ts, ts);
	push(s.total, int(total));
	push(s.up, int(up));
	let n = length(s.ts);
	for (let dev, rate in per ?? {}) {
		let row = (s.strands[dev] ??= map(slice(s.ts, 0, n - 1), () => 0));
		push(row, int(rate));
	}
	for (let dev, rate in per_up ?? {}) {
		let row = (s.strands_up[dev] ??= map(slice(s.ts, 0, n - 1), () => 0));
		push(row, int(rate));
	}
	// A strand that vanished keeps its row aligned until it scrolls out.
	for (let tbl in [ s.strands, s.strands_up ]) {
		for (let dev, row in tbl) {
			if (length(row) < n)
				push(row, 0);
			if (length(row) > s.capacity)
				shift(row);
		}
	}
	if (n > s.capacity) {
		shift(s.ts);
		shift(s.total);
		shift(s.up);
	}
};

export function dump(s, limit) {
	let n = length(s.ts), from = max(0, n - (limit > 0 ? limit : n));
	let strands = {}, strands_up = {};
	for (let dev, row in s.strands)
		strands[dev] = slice(row, from);
	for (let dev, row in s.strands_up)
		strands_up[dev] = slice(row, from);
	return { ts: slice(s.ts, from), total: slice(s.total, from), up: slice(s.up, from), strands, strands_up };
};
