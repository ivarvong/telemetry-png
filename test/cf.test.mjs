import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { eventsToOtlp, toUnixNano, fetchTraceEvents, traceEventsQuery, recentTracesQuery, traceSummaries, FIELD, SAFE_ATTRIBUTE_PATHS } from '../otel-png-cf.mjs';
import { normalize, buildTrace } from '../otel-png-model.mjs';
import { renderTraceSync } from '../otel-png.mjs';

const fixture = JSON.parse(fs.readFileSync(new URL('./fixtures/cf-events.real.json', import.meta.url)));
const events = fixture.events.events;

test('toUnixNano normalises ms, us and ns by magnitude', () => {
  assert.equal(toUnixNano(1760000000000), '1760000000000000000');
  assert.equal(toUnixNano(1760000000000000), '1760000000000000000');
  assert.equal(toUnixNano('1760000000000000000'), '1760000000000000000');
  assert.equal(toUnixNano(0), null);
  assert.equal(toUnixNano(undefined), null);
  for (const malformed of ['not-a-time', '12ms', NaN, Infinity, Symbol('time')]) assert.equal(toUnixNano(malformed), null);
});

test('toUnixNano rejects booleans, hex, objects and values beyond uint64', () => {
  for (const bad of [true, false, '0x10', ' 12', '1e400', {}, [1760000000000], 2n ** 64n, '18446744073709551616', 1e20, 2e13 * 1e6 * 1e3]) {
    assert.equal(toUnixNano(bad), null, String(bad));
  }
  assert.equal(toUnixNano('18446744073709551615'), '18446744073709551615');
  assert.equal(toUnixNano(18446744073709), '18446744073709000000'); // ms near the uint64 limit
  assert.equal(toUnixNano('1760000000000.4'), '1760000000000000000');
  assert.equal(toUnixNano(1760000000000n), '1760000000000000000');
});

test('events with malformed timestamps are dropped instead of throwing', () => {
  const event = structuredClone(events[0]);
  event.$metadata.startTimeNs = 'not-a-time';
  const dropped = [];
  const otlp = eventsToOtlp([event], { onDrop: (value) => dropped.push(value) });
  assert.equal(otlp.dropped, 1);
  assert.deepEqual(otlp.resourceSpans, []);
  assert.deepEqual(dropped, [event]);
});

test('sanitized real Cloudflare span events map without loss', () => {
  assert.equal(fixture.real, true);
  const otlp = eventsToOtlp(events);
  assert.equal(otlp.dropped, 0);
  const spans = otlp.resourceSpans.flatMap((r) => r.scopeSpans[0].spans);
  assert.equal(spans.length, fixture.summary.spans);
  assert.deepEqual([...new Set(spans.map((s) => s.traceId))], [fixture.summary.traceId]);
  assert.deepEqual(spans.map((s) => s.name).sort(), ['fetch', 'r2_put', 'r2_put', 'r2_put', 'scheduled']);
  assert.deepEqual(otlp.resourceSpans.map((r) => r.resource.attributes[0].value.stringValue), fixture.summary.services);
});

test('source attributes are exact-allowlisted and sensitive values are redacted', () => {
  const event = structuredClone(events[3]);
  Object.assign(event.source, {
    workload_id: 'safe-correlation',
    url: { full: 'https://user:secret@example.invalid/private?token=secret' },
    headers: { authorization: 'Bearer secret', cookie: 'session=secret' },
    account: { id: 'account-secret' },
    arbitrary: { nested: 'must-not-leak' },
    error: 'database password leaked',
  });
  const otlp = eventsToOtlp([event], {
    attributeMode: 'allowlist',
    attributeAllowlist: ['workload_id', 'http.request.method', 'http.response.status_code', 'headers'],
  });
  const [span] = otlp.resourceSpans[0].scopeSpans[0].spans;
  const attrs = Object.fromEntries(span.attributes.map(({ key, value }) => [key, Object.values(value)[0]]));
  assert.deepEqual(attrs, { workload_id: 'safe-correlation', 'http.request.method': 'GET', 'http.response.status_code': '204' });
  assert.deepEqual(span.status, { code: 2 });
  const serialized = JSON.stringify(otlp);
  for (const secret of ['user:secret', 'Bearer secret', 'session=secret', 'account-secret', 'must-not-leak', 'database password leaked']) {
    assert.ok(!serialized.includes(secret), secret);
  }
});

test('default allowlist retains operational values but excludes identifiers', () => {
  assert.ok(Object.isFrozen(SAFE_ATTRIBUTE_PATHS));
  const otlp = eventsToOtlp(events);
  const attrs = otlp.resourceSpans.flatMap((r) => r.scopeSpans[0].spans).flatMap((span) => span.attributes);
  const keys = new Set(attrs.map((attr) => attr.key));
  assert.ok(keys.has('cloudflare.r2.operation'));
  assert.ok(keys.has('http.response.status_code'));
  for (const key of keys) assert.doesNotMatch(key, /(?:^|\.)(?:url|headers?|account|ray_id|key|etag|checksum|host|script_name|script_version|invocation)(?:\.|$)/i);
});

test('non-allowlist mapping modes and non-array allowlists are rejected', () => {
  assert.throws(() => eventsToOtlp(events, { attributeMode: 'all' }), /allowlist mode/);
  assert.throws(() => eventsToOtlp(events, { attributeAllowlist: 'bytes' }), /must be an array/);
});

test('the mapped trace has the expected shape through the real model', () => {
  const trace = buildTrace(normalize(eventsToOtlp(events)), {});
  assert.equal(trace.spanCount, fixture.summary.spans);
  assert.equal(trace.errors, 0);
  assert.equal(trace.maxDepth, 2);
});

test('the mapped trace renders to a valid PNG', () => {
  const png = renderTraceSync(eventsToOtlp(events));
  assert.deepEqual([...png.subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
});

test('query filters by trace id and uses epoch-ms timeframes', () => {
  const q = traceEventsQuery({ traceId: 'abc', from: 1, to: 2 });
  assert.equal(q.view, 'events');
  assert.deepEqual(q.parameters.datasets, ['otel']);
  assert.deepEqual(q.parameters.filters[0], { key: '$metadata.traceId', operation: 'eq', type: 'string', value: 'abc' });
  assert.deepEqual(q.parameters.filters[1], { key: '$metadata.type', operation: 'eq', type: 'string', value: 'span' });
});

test('recent traces are server-filtered by service and both API response shapes parse', () => {
  const q = recentTracesQuery({ from: 1, to: 2, service: 'otel-ping' });
  assert.deepEqual(q.parameters.datasets, ['otel']);
  assert.equal(q.parameters.filters[0].value, 'otel-ping');
  assert.deepEqual(traceSummaries({ traces: [{ traceId: 'a' }] }), [{ traceId: 'a' }]);
  assert.deepEqual(traceSummaries({ traces: { traces: [{ traceId: 'b' }] } }), [{ traceId: 'b' }]);
});

test('pagination follows the last $metadata.id and stops on a short page', async () => {
  const bodies = [];
  const pages = [
    Array.from({ length: 3 }, (_, i) => ({ $metadata: { id: `p1-${i}` } })),
    Array.from({ length: 3 }, (_, i) => ({ $metadata: { id: `p2-${i}` } })),
    [{ $metadata: { id: 'p3-0' } }],
  ];
  const fake = async (_url, init) => {
    bodies.push(JSON.parse(init.body));
    return { ok: true, status: 200, json: async () => ({ success: true, result: { events: { events: pages[bodies.length - 1] } } }) };
  };
  const out = await fetchTraceEvents({ accountId: 'A', token: 'T', traceId: 't', from: 1, to: 2, limit: 3, fetch: fake });
  assert.equal(out.length, 7);
  assert.equal(bodies[0].offset, undefined);
  assert.equal(bodies[1].offset, 'p1-2');
  assert.equal(bodies[2].offset, 'p2-2');
  assert.equal(bodies[2].offsetDirection, 'next');
});

test('a repeated cursor cannot loop forever', async () => {
  const fake = async () => ({ ok: true, status: 200, json: async () => ({ success: true, result: { events: { events: [{ $metadata: { id: 'same' } }, { $metadata: { id: 'same' } }] } } }) });
  const out = await fetchTraceEvents({ accountId: 'A', token: 'T', traceId: 't', from: 1, to: 2, limit: 2, maxPages: 10, fetch: fake });
  assert.equal(out.length, 4); // page 1, then page 2 sees the same cursor and stops
});

test('event pagination obeys the total event bound', async () => {
  const requestedLimits = [];
  const fake = async (_url, init) => {
    const body = JSON.parse(init.body);
    requestedLimits.push(body.limit);
    const events = Array.from({ length: body.limit }, (_, i) => ({ $metadata: { id: `${requestedLimits.length}-${i}` } }));
    return { ok: true, status: 200, json: async () => ({ success: true, result: { events: { events } } }) };
  };
  const out = await fetchTraceEvents({ accountId: 'A', token: 'T', traceId: 't', from: 1, to: 2, limit: 4, maxPages: 10, maxEvents: 6, fetch: fake });
  assert.equal(out.length, 6);
  assert.deepEqual(requestedLimits, [4, 2]);
});

test('API errors surface with status and message', async () => {
  const fake = async () => ({ ok: false, status: 403, json: async () => ({ success: false, errors: [{ code: 10000, message: 'Authentication error' }] }) });
  await assert.rejects(fetchTraceEvents({ accountId: 'A', token: 'T', traceId: 't', from: 1, to: 2, fetch: fake }), /403.*Authentication error/);
});

test('every mapped field has a fallback list', () => {
  for (const [k, v] of Object.entries(FIELD)) assert.ok(Array.isArray(v) && v.length, k);
});
