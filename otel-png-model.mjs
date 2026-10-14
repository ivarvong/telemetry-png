// otel-png-model.mjs — OTLP JSON -> trace model. Knows nothing about pixels.
//
//   normalize(otlp)        validate and flatten spans; never throws on bad spans
//   buildTrace(normal)     forest, self time, critical path, aggregates, display rows
//
// Contracts (each has tests in test/model.test.mjs):
//
//   Time        Offsets are nanoseconds from the earliest span start, as Numbers.
//               Exact while the trace is shorter than 2^53 ns (about 104 days).
//   Forest      A span whose parent is not in the payload is a root. A span in a
//               parent cycle becomes a root. Roots and siblings sort by start time.
//   Self time   duration minus the measure of the UNION of direct children's
//               intervals, each clipped to the parent's interval. Never negative.
//               Overlapping children are not double-counted; a child that outlives
//               its parent only subtracts the part inside it.
//   Service self time is the SUM of its spans' self times. With concurrency this can
//               exceed wall time; it is attributed work, not elapsed time.
//   Critical path  Walk back from the end of the trace. At each moment the span on
//               the path is the deepest one still running in the subtree that
//               finishes last. `crit` holds the intervals where a span is that
//               span; they partition [0, total] together with `untraced`, the time
//               on the path that no span accounts for (queue lag, missing
//               instrumentation). Shortening a `crit` interval shortens the trace.
//   Invalid     Spans with a missing or unparseable id or timestamp, and duplicate
//               ids, are dropped and counted in `invalid`. end < start is clamped
//               to zero duration and marked with an attribute.
//   Folding     >= `fold` leaf siblings with the same service and name become one
//               display row carrying every member's interval. Analysis runs first,
//               on the real spans; folding only changes what is displayed.

// ---------- formatting shared by the model's summaries and the layout ----------

export function formatDuration(ns) {
  if (ns >= 1e9) return `${(ns / 1e9).toFixed(2)} s`;
  if (ns >= 1e6) return `${(ns / 1e6).toFixed(1)} ms`;
  if (ns >= 1e3) return `${(ns / 1e3).toFixed(ns >= 1e4 ? 0 : 1)} µs`;
  return `${Math.round(ns)} ns`;
}

// ---------- normalize ----------

const anyValue = (v) =>
  v == null ? '' : v.stringValue ?? v.intValue ?? v.doubleValue ?? v.boolValue ?? JSON.stringify(v.arrayValue?.values ?? v.kvlistValue?.values ?? v);

const exceptionText = (events) => {
  const attrs = events?.find((e) => e.name === 'exception')?.attributes ?? [];
  const get = (k) => attrs.find((a) => a.key === k)?.value?.stringValue;
  return get('exception.message') ?? get('exception.type');
};

const timestamp = (v) => {
  try {
    const t = BigInt(v); // uint64 as a string: Number would lose precision
    return t > 0n ? t : null;
  } catch {
    return null;
  }
};

export function normalize(otlp) {
  const spans = [];
  const ids = new Set();
  let invalid = 0;
  for (const rs of otlp?.resourceSpans ?? []) {
    const service = rs.resource?.attributes?.find((a) => a.key === 'service.name')?.value?.stringValue ?? 'unknown';
    for (const ss of rs.scopeSpans ?? []) {
      for (const s of ss.spans ?? []) {
        const start = timestamp(s.startTimeUnixNano);
        let end = timestamp(s.endTimeUnixNano);
        if (!s.spanId || ids.has(s.spanId) || start === null || end === null) { invalid++; continue; }
        ids.add(s.spanId);
        const attrs = (s.attributes ?? []).map((a) => [String(a.key), String(anyValue(a.value))]);
        if (end < start) { end = start; attrs.push(['otel-png.clamped', 'end<start']); }
        spans.push({
          id: s.spanId,
          parent: s.parentSpanId || null,
          traceId: s.traceId ?? '',
          name: String(s.name ?? ''),
          service,
          start,
          end,
          error: s.status?.code === 2 || s.status?.code === 'STATUS_CODE_ERROR',
          message: s.status?.message || exceptionText(s.events) || '',
          attrs,
          events: (s.events ?? []).flatMap((e) => {
            const t = timestamp(e.timeUnixNano);
            return t === null ? [] : [{ name: String(e.name ?? 'event'), t }];
          }),
        });
      }
    }
  }
  return { spans, invalid };
}

// ---------- buildTrace ----------

const sum = (segs) => segs.reduce((n, [a, b]) => n + (b - a), 0);

export function buildTrace({ spans, invalid = 0 }, { fold = 5 } = {}) {
  if (spans.length === 0) throw new Error('no valid spans in OTLP payload');
  let t0 = spans[0].start, t1 = spans[0].end;
  for (const s of spans) {
    if (s.start < t0) t0 = s.start;
    if (s.end > t1) t1 = s.end;
  }
  const rel = (t) => Number(t - t0);
  const total = Math.max(1, rel(t1));

  // Forest. Every loop below is iterative: depth is bounded by memory, not the call stack.
  const nodes = spans.map((s) => ({
    s, off: rel(s.start), end: rel(s.end), parent: null, kids: [], depth: 0, subEnd: 0,
    segs: [], self: 0, crit: [], critSelf: 0, seen: false, hidden: false, group: null,
  }));
  const byId = new Map(nodes.map((n) => [n.s.id, n]));
  const roots = [];
  for (const n of nodes) {
    const p = n.s.parent && n.s.parent !== n.s.id ? byId.get(n.s.parent) : undefined;
    if (p) { n.parent = p; p.kids.push(n); } else roots.push(n);
  }
  const mark = (from) => {
    for (const stack = [from]; stack.length;) {
      const n = stack.pop();
      if (n.seen) continue;
      n.seen = true;
      for (const k of n.kids) stack.push(k);
    }
  };
  roots.forEach(mark);
  for (const n of nodes) { // whatever is left is in a parent cycle: cut it open here
    if (n.seen) continue;
    n.parent.kids = n.parent.kids.filter((k) => k !== n);
    n.parent = null;
    roots.push(n);
    mark(n);
  }
  const byStart = (a, b) => a.off - b.off;
  roots.sort(byStart);
  for (const n of nodes) n.kids.sort(byStart);

  const order = []; // preorder
  for (const stack = [...roots].reverse(); stack.length;) {
    const n = stack.pop();
    n.depth = n.parent ? n.parent.depth + 1 : 0;
    order.push(n);
    for (let i = n.kids.length - 1; i >= 0; i--) stack.push(n.kids[i]);
  }

  // Self time: the span's interval minus the union of its children's clipped intervals.
  for (const n of order) {
    let cur = n.off;
    for (const k of n.kids) {
      const a = Math.min(n.end, Math.max(n.off, k.off));
      const b = Math.min(n.end, k.end);
      if (a > cur) n.segs.push([cur, a]);
      if (b > cur) cur = b;
    }
    if (n.end > cur) n.segs.push([cur, n.end]);
    n.self = sum(n.segs);
    n.subEnd = n.end;
  }
  for (let i = order.length - 1; i >= 0; i--) { // latest finish in each subtree
    const n = order[i];
    if (n.parent && n.subEnd > n.parent.subEnd) n.parent.subEnd = n.subEnd;
  }

  // Critical path, from a virtual root that spans the trace.
  for (const work = [[{ off: 0, end: 0, kids: roots, crit: [] }, total]]; work.length;) {
    const [r, hi] = work.pop();
    let cursor = hi;
    const own = (a, b) => {
      const lo = Math.max(a, r.off), up = Math.min(b, r.end);
      if (up > lo) r.crit.push([lo, up]);
    };
    for (const k of [...r.kids].sort((p, q) => q.subEnd - p.subEnd)) {
      const ke = Math.min(k.subEnd, cursor);
      if (ke <= k.off) continue; // started after the cursor: it ran in parallel with the path
      own(ke, cursor);
      work.push([k, ke]);
      cursor = k.off;
    }
    own(-Infinity, cursor);
  }
  for (const n of order) n.critSelf = sum(n.crit);
  // Whatever part of [0, total] no span claimed: queue lag, missing instrumentation.
  const gaps = [];
  let covered = 0;
  for (const [a, b] of order.flatMap((n) => n.crit).sort((p, q) => p[0] - q[0])) {
    if (a > covered) gaps.push([covered, a]);
    covered = Math.max(covered, b);
  }
  if (total > covered) gaps.push([covered, total]);
  const untraced = sum(gaps);

  // Aggregates over real spans.
  const services = new Map();
  for (const n of order) services.set(n.s.service, (services.get(n.s.service) ?? 0) + n.self);
  const colorBy = services.size > 1 ? 'service' : 'name'; // one service: colour by span name instead
  const keyOf = (s) => (colorBy === 'service' ? s.service : s.name);
  const byKey = new Map();
  for (const n of order) byKey.set(keyOf(n.s), (byKey.get(keyOf(n.s)) ?? 0) + n.self);
  const legend = [...byKey].map(([key, self]) => ({ key, self })).sort((p, q) => q.self - p.self);

  // Folding: decide per parent, then emit display rows in preorder.
  if (fold > 0) {
    for (const n of order) {
      if (n.kids.length < fold) continue;
      const groups = new Map();
      for (const k of n.kids) {
        if (k.kids.length) continue;
        const id = `${k.s.service}\u0000${k.s.name}`;
        if (!groups.has(id)) groups.set(id, []);
        groups.get(id).push(k);
      }
      for (const members of groups.values()) {
        if (members.length < fold) continue;
        members[0].group = members;
        for (let i = 1; i < members.length; i++) members[i].hidden = true;
      }
    }
  }
  const rows = [];
  for (const n of order) {
    if (n.hidden) continue;
    const m = n.group ?? [n];
    const errors = m.filter((k) => k.s.error);
    rows.push({
      name: n.s.name, service: n.s.service, key: keyOf(n.s), depth: n.depth, count: m.length,
      off: m[0].off, end: m.reduce((e, k) => Math.max(e, k.end), 0), dur: m.reduce((d, k) => d + (k.end - k.off), 0),
      bars: m.map((k) => [k.off, k.end]),
      leaf: n.kids.length === 0,
      self: m.reduce((d, k) => d + k.self, 0), segs: m.flatMap((k) => k.segs),
      critSelf: m.reduce((d, k) => d + k.critSelf, 0), crit: m.flatMap((k) => k.crit),
      error: errors.length > 0, message: errors[0]?.s.message ?? '',
      attrs: n.group ? summarize(m, errors.length) : n.s.attrs,
      events: n.group ? [] : n.s.events.map((e) => ({ name: e.name, t: rel(e.t) })),
      parentName: n.parent?.s.name ?? '', guides: 0, last: false, parentNode: n.parent,
    });
  }
  // Tree guides: `last` marks a final visible child; bit k of `guides` says the
  // ancestor at depth k has a later sibling, so its vertical line continues.
  const closed = new Set();
  for (let i = rows.length - 1; i >= 0; i--) {
    rows[i].last = !closed.has(rows[i].parentNode);
    closed.add(rows[i].parentNode);
  }
  let open = 0;
  for (const r of rows) {
    const d = Math.min(r.depth, 30);
    open &= (1 << d) - 1;
    r.guides = open;
    if (!r.last) open |= 1 << d;
    delete r.parentNode;
  }

  // Ranking: display rows by time on the critical path, plus the untraced gap.
  const top = rows.filter((r) => r.critSelf > 0);
  if (untraced > total * 0.005) {
    top.push({ gap: true, name: '(untraced)', parentName: '', service: '', key: null, count: 1, off: 0, end: total, dur: untraced, bars: [], leaf: true, self: 0, segs: [], critSelf: untraced, crit: gaps, error: false, message: '', attrs: [], events: [] });
  }
  top.sort((p, q) => q.critSelf - p.critSelf).splice(5);

  return {
    rows, top, hot: top.find((r) => !r.gap) ?? null,
    spanCount: spans.length, invalid, total, untraced,
    startMs: Number(t0 / 1_000_000n),
    traceId: spans[0].traceId,
    services: [...services].map(([name, self]) => ({ name, self })),
    colorBy, legend,
    totalSelf: Math.max(1, order.reduce((n, k) => n + k.self, 0)),
    errors: order.filter((n) => n.s.error).length,
    maxDepth: order.reduce((d, n) => Math.max(d, n.depth), 0) + 1,
  };
}

// What a folded row says about its members: count, spread, and which attributes vary.
function summarize(members, errors) {
  const durs = members.map((k) => k.end - k.off).sort((a, b) => a - b);
  const out = [
    ['count', String(members.length)],
    ['min', formatDuration(durs[0])],
    ['p50', formatDuration(durs[durs.length >> 1])],
    ['max', formatDuration(durs[durs.length - 1])],
  ];
  if (errors) out.push(['errors', String(errors)]);
  const values = new Map();
  for (const k of members) {
    for (const [key, v] of k.s.attrs) {
      if (!values.has(key)) values.set(key, new Set());
      values.get(key).add(v);
    }
  }
  // Attributes that vary across members come first: they are what distinguishes the calls.
  const varying = [], constant = [];
  for (const [key, set] of values) (set.size > 1 ? varying : constant).push([key, set.size > 1 ? `(${set.size} distinct)` : [...set][0]]);
  return [...out, ...varying, ...constant];
}
