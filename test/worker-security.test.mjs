import test from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';

// Node does not know the Workers-only cloudflare: scheme. Stub only that module;
// the worker and all of its other dependencies execute normally.
const loader = `
export async function resolve(specifier, context, nextResolve) {
  if (specifier === 'cloudflare:workers') {
    return { url: 'data:text/javascript,' + encodeURIComponent(\`export const tracing = { enterSpan(_name, fn) { return fn({ isTraced: false, setAttributes() {} }); } };\`), shortCircuit: true };
  }
  return nextResolve(specifier, context);
}`;
register(`data:text/javascript,${encodeURIComponent(loader)}`, import.meta.url);
const { default: worker } = await import('../worker-bench/worker.mjs');

const SECRET = 'test-telemetry-secret';
const ACCOUNT_ENV = { TELEMETRY_AUTH_SECRET: SECRET, CF_ACCOUNT_ID: 'account', CF_API_TOKEN: 'api-token' };
const request = (path, token) => new Request(`https://worker.test${path}`, token === undefined ? {} : { headers: { authorization: `Bearer ${token}` } });

function assertPrivateNoStore(response) {
  const cacheControl = response.headers.get('cache-control');
  assert.equal(cacheControl, 'private, no-store, max-age=0');
  assert.doesNotMatch(cacheControl, /(?:^|,)\s*public(?:\s|,|$)/i);
}

test('account telemetry fails closed when the application secret is missing', async () => {
  const response = await worker.fetch(request('/api/traces'), {});
  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), { error: 'account telemetry endpoints are disabled' });
});

test('account telemetry rejects missing and wrong bearer tokens', async () => {
  for (const token of [undefined, 'wrong-telemetry-secret']) {
    const response = await worker.fetch(request('/api/traces', token), ACCOUNT_ENV);
    assert.equal(response.status, 401);
    assert.equal(response.headers.get('www-authenticate'), 'Bearer realm="account-telemetry"');
  }
});

test('a correct bearer token reaches request validation', async () => {
  const response = await worker.fetch(request('/api/traces?minutes=0', SECRET), ACCOUNT_ENV);
  assert.equal(response.status, 400);
  assert.match((await response.json()).error, /minutes/);
});

test('successful recent account telemetry is private and not cacheable', async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  globalThis.fetch = async (_url, init) => {
    assert.equal(init.headers.authorization, 'Bearer api-token');
    return Response.json({ success: true, result: { traces: [] } });
  };

  const response = await worker.fetch(request('/api/traces?minutes=1&scope=all&minSpans=1&errors=any', SECRET), ACCOUNT_ENV);
  assert.equal(response.status, 200);
  assertPrivateNoStore(response);
  assert.deepEqual((await response.json()).traces, []);
});

test('a successful account trace PNG is private and not cacheable', async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  const traceId = 'abcdefabcdefabcdefabcdefabcdefab';
  const now = Date.now();
  globalThis.fetch = async (_url, init) => {
    assert.equal(init.headers.authorization, 'Bearer api-token');
    return Response.json({ success: true, result: { events: { events: [{
      $metadata: {
        id: 'event-1', traceId, spanId: '0123456789abcdef', type: 'span',
        service: 'otel-png-observability-demo', spanName: 'fetch',
        startTimeNs: String(BigInt(now) * 1_000_000n),
        endTimeNs: String(BigInt(now + 10) * 1_000_000n),
      },
      source: { status: 200 },
    }] } } });
  };

  const response = await worker.fetch(request(`/api/trace/${traceId}.png?from=${now - 1000}&to=${now + 1000}&page=1`, SECRET), ACCOUNT_ENV);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('content-type'), 'image/png');
  assertPrivateNoStore(response);
  const bytes = new Uint8Array(await response.arrayBuffer());
  assert.deepEqual([...bytes.subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
});

test('synthetic profile artifacts remain publicly cacheable', async () => {
  const response = await worker.fetch(request('/profile/table.png'), {});
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('cache-control'), 'public, max-age=86400, immutable');
});
