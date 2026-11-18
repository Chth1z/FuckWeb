// Fixed-size circular history. All rows share the same write position.
export function create(capacity) {
	return { capacity, next: 0, ts: [], total: [], up: [], strands: {}, strands_up: {} };
};

export function add(s, ts, total, up, per, per_up) {
	let i = s.next;
	s.ts[i] = ts;
	s.total[i] = int(total);
	s.up[i] = int(up);
	let put = (rows, sample) => {
		for (let dev in sample)
			rows[dev] ??= map(s.ts, () => 0);
		for (let dev, row in rows)
			row[i] = int(sample[dev] ?? 0);
	};
	put(s.strands, per);
	put(s.strands_up, per_up);
	s.next = (i + 1) % s.capacity;
};

export function dump(s, limit) {
	let n = length(s.ts), count = limit > 0 ? min(n, limit) : n;
	let start = n ? (s.next + n - count) % n : 0;
	let read = (row) => {
		let out = slice(row, start, start + count);
		return length(out) == count ? out : [ ...out, ...slice(row, 0, count - length(out)) ];
	};
	let strands = {}, strands_up = {};
	for (let dev, row in s.strands)
		strands[dev] = read(row);
	for (let dev, row in s.strands_up)
		strands_up[dev] = read(row);
	return { ts: read(s.ts), total: read(s.total), up: read(s.up), strands, strands_up };
};
