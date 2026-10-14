import test from 'node:test';
import assert from 'node:assert/strict';
import { BoundedCoalescingCache, CacheCapacityError, createBlobUrlStore, createRequestScheduler, filterSummaries, recentOptions, retryAfterMilliseconds, retryAfterSeconds } from '../worker-bench/app-helpers.mjs';

const params = (value) => new URLSearchParams(value);

test('recent options default to workload and validate usable filters', () => {
  assert.deepEqual(recentOptions(params()), { minutes: 15, minSpans: 1, errors: 'any', scope: 'workload' });
  assert.deepEqual(recentOptions(params('minutes=60&minSpans=8&errors=only&scope=observer')), { minutes: 60, minSpans: 8, errors: 'only', scope: 'observer' });
  assert.throws(() => recentOptions(params('minutes=0')), /minutes/);
  assert.throws(() => recentOptions(params('minSpans=1001')), /minSpans/);
  assert.throws(() => recentOptions(params('errors=sometimes')), /errors/);
  assert.throws(() => recentOptions(params('scope=account')), /scope/);
});

test('summary filters combine minimum spans and errors', () => {
  const rows = [{ spans: 2, errors: [] }, { spans: 8, errors: [{ message: 'redacted' }] }, { spans: 10, errors: 0 }];
  assert.deepEqual(filterSummaries(rows, { minSpans: 5, errors: 'only' }), [rows[1]]);
  assert.deepEqual(filterSummaries(rows, { minSpans: 5, errors: 'none' }), [rows[2]]);
});

test('Retry-After honors the full 60-second limiter delay and supports dates', () => {
  assert.equal(retryAfterSeconds('7', 1_000), 7);
  assert.equal(retryAfterSeconds('60', 1_000), 60);
  assert.equal(retryAfterSeconds(new Date(12_000).toUTCString(), 2_000), 10);
  assert.equal(retryAfterSeconds('999', 0), 300);
  assert.equal(retryAfterSeconds('invalid', 0), 2);
  assert.equal(retryAfterMilliseconds('60', 1_000), 60_000);
});

test('rolling request scheduler deterministically makes progress beyond 18 requests', async () => {
  let now = 0;
  const waits = [];
  const scheduler = createRequestScheduler({
    limit: 18,
    windowMs: 60_000,
    now: () => now,
    sleep: async (milliseconds) => { waits.push(milliseconds); now += milliseconds; },
  });
  const admitted = [];
  for (let i = 0; i < 20; i++) admitted.push(await scheduler.permit());
  assert.deepEqual(admitted.slice(0, 18), Array(18).fill(0));
  assert.deepEqual(admitted.slice(18), [60_000, 60_000]);
  assert.deepEqual(waits, [60_000]);
});

test('blob URL eviction never revokes URLs still owned by displayed cards or actions', () => {
  const revoked = [];
  const store = createBlobUrlStore({ maxEntries: 1, revoke: (url) => revoked.push(url) });
  store.put('page-a', { url: 'blob:a' }, 'card-a');
  store.put('page-b', { url: 'blob:b' }, 'card-b');
  assert.deepEqual(revoked, [], 'both displayed URLs remain usable even above the soft LRU bound');
  store.release('card-a');
  assert.deepEqual(revoked, ['blob:a']);
  assert.equal(store.get('page-b').url, 'blob:b');
  store.clear();
  assert.deepEqual(revoked, ['blob:a', 'blob:b']);
});

test('bounded cache coalesces pending loads and expires settled values', async () => {
  let now = 0, loads = 0, release;
  const cache = new BoundedCoalescingCache({ maxEntries: 2, maxWeight: 2, ttlMs: 10, now: () => now });
  const loader = () => { loads++; return new Promise((resolve) => { release = resolve; }); };
  const first = cache.get('a', loader);
  const second = cache.get('a', loader);
  await Promise.resolve();
  assert.equal(loads, 1);
  release('value');
  assert.equal(await first, 'value');
  assert.equal(await second, 'value');
  assert.equal(await cache.get('a', () => 'wrong'), 'value');
  now = 11;
  assert.equal(await cache.get('a', () => { loads++; return 'fresh'; }), 'fresh');
  assert.equal(loads, 2);
});

test('bounded cache removes failures and evicts to count and weight limits', async () => {
  const cache = new BoundedCoalescingCache({ maxEntries: 2, maxWeight: 3, ttlMs: 100, weight: (v) => v.length, now: () => 0 });
  await assert.rejects(cache.get('bad', () => { throw new Error('boom'); }), /boom/);
  assert.equal(await cache.get('bad', () => 'x'), 'x');
  await cache.get('b', () => 'yy');
  await cache.get('c', () => 'z');
  assert.ok(cache.entries.size <= 2);
  assert.ok([...cache.entries.values()].reduce((sum, entry) => sum + entry.weight, 0) <= 3);
});

test('independent per-page caches coalesce one pending telemetry event query', async () => {
  const telemetry = new BoundedCoalescingCache({ maxEntries: 2, maxPending: 1, maxWeight: 10, ttlMs: 100, weight: (value) => value.events.length });
  const png = new BoundedCoalescingCache({ maxEntries: 3, maxPending: 3, maxWeight: 100, ttlMs: 100, weight: (value) => value.length });
  let eventLoads = 0, releaseEvents;
  const loadEvents = () => {
    eventLoads++;
    return new Promise((resolve) => { releaseEvents = resolve; });
  };
  const renderPage = (page) => png.get(`trace:${page}`, async () => {
    const value = await telemetry.get('trace', loadEvents);
    return `page-${page}-from-${value.events.length}-events`;
  });
  const first = renderPage(1), second = renderPage(2);
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(eventLoads, 1);
  assert.equal(telemetry.pendingCount, 1);
  releaseEvents({ events: [{ id: 1 }, { id: 2 }] });
  assert.deepEqual(await Promise.all([first, second]), ['page-1-from-2-events', 'page-2-from-2-events']);
  assert.equal(await renderPage(3), 'page-3-from-2-events');
  assert.equal(eventLoads, 1, 'a new PNG page reuses the independent telemetry cache');
});

test('bounded cache rejects a distinct-key pending flood at the hard concurrency bound', async () => {
  const releases = [], started = [];
  let active = 0, maximumActive = 0;
  const cache = new BoundedCoalescingCache({ maxEntries: 4, maxPending: 2, maxWeight: 4, ttlMs: 100, retryAfter: 7 });
  const load = (key) => async () => {
    started.push(key);
    active++;
    maximumActive = Math.max(maximumActive, active);
    await new Promise((resolve) => releases.push(resolve));
    active--;
    return key;
  };
  const a = cache.get('a', load('a'));
  const b = cache.get('b', load('b'));
  const coalesced = cache.get('a', () => assert.fail('coalesced key must not start another load'));
  await Promise.resolve();
  await assert.rejects(cache.get('c', load('c')), (error) => {
    assert.ok(error instanceof CacheCapacityError);
    assert.equal(error.publicStatus, 503);
    assert.equal(error.retryAfter, 7);
    return true;
  });
  assert.deepEqual(started, ['a', 'b']);
  assert.equal(cache.pendingCount, 2);
  assert.equal(cache.entries.size, 2);
  releases.shift()();
  assert.equal(await a, 'a');
  assert.equal(await coalesced, 'a');
  const c = cache.get('c', load('c'));
  await Promise.resolve();
  assert.equal(cache.pendingCount, 2);
  assert.ok(cache.entries.size <= 4);
  releases.splice(0).forEach((release) => release());
  assert.deepEqual(await Promise.all([b, c]), ['b', 'c']);
  assert.equal(maximumActive, 2);
});
