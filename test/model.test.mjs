// Timing semantics, independent of geometry.
import test from 'node:test';
import assert from 'node:assert/strict';
import { normalize, buildTrace } from '../otel-png-model.mjs';
import { otlp, ns, MS, load } from './helpers.mjs';

const build = (o, opts) => buildTrace(normalize(o), opts);
const row = (t, name) => t.rows.find((r) => r.name === name);

test('self time subtracts the union of children, not their sum', () => {
  const t = build(otlp(['a', 'parent', 0, 100, {}, [['a', 'k1', 10, 30], ['a', 'k2', 20, 50]]]));
  assert.equal(row(t, 'parent').self, 60 * MS); // 100 - |[10,50]|
  assert.deepEqual(row(t, 'parent').segs, [[0, 10 * MS], [50 * MS, 100 * MS]]);
});

test('self time is never negative when children cover or exceed the parent', () => {
  const t = build(otlp(['a', 'parent', 10, 20, {}, [['a', 'early', 0, 15], ['a', 'late', 12, 40]]]));
  assert.equal(row(t, 'parent').self, 0);
  for (const r of t.rows) assert.ok(r.self >= 0);
});

test('a child that starts after its parent ended does not stretch the parent', () => {
  const t = build(otlp(['api', 'enqueue', 0, 7, {}, [['worker', 'process', 4000, 9000]]]));
  assert.equal(row(t, 'enqueue').self, 7 * MS);
  assert.equal(t.total, 9000 * MS);
});

test('critical path: serial children partition the trace', () => {
  const t = build(otlp(['a', 'root', 0, 100, {}, [['a', 'x', 10, 40], ['a', 'y', 40, 90]]]));
  assert.equal(row(t, 'x').critSelf, 30 * MS);
  assert.equal(row(t, 'y').critSelf, 50 * MS);
  assert.equal(row(t, 'root').critSelf, 20 * MS);
  assert.equal(t.rows.reduce((n, r) => n + r.critSelf, 0) + t.untraced, t.total);
});

test('critical path: of parallel children only the straggler is on it', () => {
  const t = build(otlp(['a', 'root', 0, 100, {}, [['a', 'fast', 5, 20], ['a', 'slow', 5, 95]]]));
  assert.equal(row(t, 'fast').critSelf, 0);
  assert.equal(row(t, 'slow').critSelf, 90 * MS);
  assert.equal(t.hot.name, 'slow');
});

test('critical path follows a child that outlives its parent, and reports the gap', () => {
  const t = build(otlp(['api', 'POST', 0, 48, {}, [['api', 'enqueue', 39, 46, {}, [['worker', 'process', 4310, 9420]]]]]));
  assert.equal(row(t, 'process').critSelf, 5110 * MS);
  assert.equal(t.untraced, (4310 - 46) * MS); // from enqueue's end: POST's 46-48 tail ran beside the queue wait, not on the path
  assert.equal(t.top[0].name, 'process');
  assert.ok(t.top.some((r) => r.gap));
  assert.equal(t.rows.reduce((n, r) => n + r.critSelf, 0) + t.untraced, t.total);
});

test('missing parent: the span becomes a root', () => {
  const t = build(otlp(['a', 'root', 0, 10], ['b', 'orphan', 2, 4, { parentSpanId: 'not-here' }]));
  assert.deepEqual(t.rows.map((r) => [r.name, r.depth]), [['root', 0], ['orphan', 0]]);
});

test('multiple roots sort by start and share one critical path', () => {
  const t = build(otlp(['a', 'second', 50, 100], ['a', 'first', 0, 40]));
  assert.deepEqual(t.rows.map((r) => r.name), ['first', 'second']);
  assert.equal(row(t, 'first').critSelf, 40 * MS);
  assert.equal(row(t, 'second').critSelf, 50 * MS);
  assert.equal(t.untraced, 10 * MS);
});

test('parent cycles and self-parents terminate and keep every span', () => {
  const o = otlp(['a', 'x', 0, 10, { spanId: 'x', parentSpanId: 'y' }], ['a', 'y', 1, 9, { spanId: 'y', parentSpanId: 'x' }], ['a', 'self', 2, 3, { spanId: 'z', parentSpanId: 'z' }]);
  const t = build(o);
  assert.equal(t.rows.length, 3);
  assert.equal(t.spanCount, 3);
});

test('zero-duration spans are kept with zero self time', () => {
  const t = build(otlp(['a', 'root', 0, 10, {}, [['a', 'instant', 5, 5]]]));
  assert.equal(row(t, 'instant').dur, 0);
  assert.equal(row(t, 'instant').self, 0);
  assert.equal(row(t, 'root').self, 10 * MS);
});

test('malformed spans are dropped and counted, never thrown on', () => {
  const o = otlp(['a', 'ok', 0, 10], ['a', 'no-start', 0, 1, { start: undefined }], ['a', 'junk', 0, 1, { end: 'soon' }], ['a', 'dup', 0, 1, { spanId: 's1' }]);
  o.resourceSpans[0].scopeSpans[0].spans[1].startTimeUnixNano = undefined;
  const n = normalize(o);
  assert.equal(n.spans.length, 1);
  assert.equal(n.invalid, 3);
  assert.equal(build(o).invalid, 3);
});

test('end before start is clamped to zero duration and marked', () => {
  const t = build(otlp(['a', 'root', 0, 10, {}, [['a', 'skewed', 8, 6]]]));
  assert.equal(row(t, 'skewed').dur, 0);
  assert.deepEqual(row(t, 'skewed').attrs.at(-1), ['otel-png.clamped', 'end<start']);
});

test('nothing valid: a clear error', () => {
  assert.throws(() => build({}), /no valid spans/);
  assert.throws(() => build({ resourceSpans: [{ scopeSpans: [{ spans: [{ spanId: 'a' }] }] }] }), /no valid spans/);
});

test('nanosecond timestamps keep full uint64 precision', () => {
  const o = otlp(['a', 'root', 0, 1, { start: '1760000000000000001', end: '1760000000000000004' }]);
  assert.equal(build(o).total, 3);
});

test('a 100,000-deep chain does not overflow the stack', () => {
  const spans = Array.from({ length: 100000 }, (_, i) => ({ traceId: 't', spanId: `s${i}`, parentSpanId: i ? `s${i - 1}` : '', name: 'n', startTimeUnixNano: ns(i), endTimeUnixNano: ns(200000 - i) }));
  const t = build({ resourceSpans: [{ scopeSpans: [{ spans }] }] });
  assert.equal(t.maxDepth, 100000);
  assert.equal(t.rows.at(-1).critSelf, (200000 - 2 * 99999) * MS);
});

test('tree guides: last-child flags and continuing ancestors', () => {
  const t = build(otlp(['a', 'root', 0, 100, {}, [['a', 'k1', 0, 40, {}, [['a', 'g1', 0, 10], ['a', 'g2', 10, 20]]], ['a', 'k2', 50, 60]]]));
  const g = Object.fromEntries(t.rows.map((r) => [r.name, [r.last, r.guides]]));
  assert.deepEqual(g.k1, [false, 0]);
  assert.deepEqual(g.g1, [false, 0b10]); // k1 (depth 1) has a later sibling
  assert.deepEqual(g.g2, [true, 0b10]);
  assert.deepEqual(g.k2, [true, 0]);
});

test('folding: repeated leaf siblings become one row; analysis is unchanged', () => {
  const kids = Array.from({ length: 8 }, (_, i) => ['db', 'SELECT 1', 10 + i * 10, 15 + i * 10, { attrs: { 'order.id': i, 'db.system': 'pg' } }]);
  const o = otlp(['api', 'GET', 0, 100, {}, [...kids, ['api', 'render', 92, 99]]]);
  const folded = build(o), flat = build(o, { fold: 0 });
  assert.equal(flat.rows.length, 10);
  assert.deepEqual(folded.rows.map((r) => [r.name, r.count]), [['GET', 1], ['SELECT 1', 8], ['render', 1]]);
  const f = row(folded, 'SELECT 1');
  assert.equal(f.dur, 40 * MS);
  assert.equal(f.bars.length, 8);
  assert.equal(f.critSelf, flat.rows.filter((r) => r.name === 'SELECT 1').reduce((n, r) => n + r.critSelf, 0));
  assert.deepEqual(f.attrs.slice(0, 1), [['count', '8']]);
  assert.ok(f.attrs.some(([k, v]) => k === 'order.id' && v === '(8 distinct)'));
  assert.ok(f.attrs.some(([k, v]) => k === 'db.system' && v === 'pg'));
  assert.equal(folded.spanCount, 10);
  assert.equal(row(folded, 'render').last, true);
});

test('folding leaves spans with children, and groups below the threshold, alone', () => {
  const kids = Array.from({ length: 4 }, (_, i) => ['db', 'q', i * 10, i * 10 + 5]);
  assert.equal(build(otlp(['a', 'root', 0, 100, {}, kids])).rows.length, 5);
  const parents = Array.from({ length: 6 }, (_, i) => ['a', 'attempt', i * 10, i * 10 + 5, {}, [['b', 'call', i * 10 + 1, i * 10 + 4]]]);
  assert.equal(build(otlp(['a', 'root', 0, 100, {}, parents])).rows.length, 13);
});

test('service self time sums spans; colour key falls back to span name for one service', () => {
  const multi = build(load('sample-trace.json'));
  assert.equal(multi.colorBy, 'service');
  assert.deepEqual(multi.legend.map((e) => e.key), ['payments', 'checkout-svc', 'edge-gateway']);
  assert.equal(multi.legend.reduce((n, e) => n + e.self, 0), multi.totalSelf);
  const one = build(otlp(['a', 'root', 0, 100, {}, [['a', 'paint', 0, 60], ['a', 'deflate', 60, 90]]]));
  assert.equal(one.colorBy, 'name');
  assert.deepEqual(one.legend.map((e) => e.key), ['paint', 'deflate', 'root']);
});

test('semantic golden: the sample trace', () => {
  const t = build(load('sample-trace.json'));
  assert.equal(t.total, 182 * MS);
  assert.equal(t.errors, 3);
  assert.equal(t.maxDepth, 6);
  assert.deepEqual(t.top.map((r) => [r.name, r.critSelf / MS]), [['stripe.create_intent', 51], ['pricing.compute {tax, shipping, discounts}', 35], ['stripe.confirm [retry #2]', 27], ['cart.load', 26], ['auth.verify_jwt', 7.5]]);
  assert.deepEqual(t.rows.map((r) => `${' '.repeat(r.depth)}${r.name}|${r.self / MS}`), [
    'GET /api/checkout|5', ' auth.verify_jwt|7.5', ' ratelimit.check|0.5', ' fetch checkout-svc|5', '  POST /checkout|6', '   cart.load|26',
    '   pricing.compute {tax, shipping, discounts}|35', '   payments.charge|4', '    POST /charge|4', '     db.query SELECT * FROM cards WHERE id=$1|7',
    '     stripe.create_intent|51', '     stripe.confirm [retry #2]|27', '   emit order.created ~async|4', 'orphan: café lookup|0.0004',
  ]);
});
