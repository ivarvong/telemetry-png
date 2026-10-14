// The published entry points resolve through package.json "exports" (self-reference).
import test from 'node:test';
import assert from 'node:assert/strict';

test('exports: otel-png, otel-png/cloudflare and otel-png/package.json resolve; internals do not', async () => {
  const core = await import('otel-png');
  for (const name of ['openTrace', 'renderTrace', 'renderTracePages', 'renderTraceSync', 'renderTracePagesSync', 'renderTraceStream', 'createTracer']) assert.equal(typeof core[name], 'function', name);
  const cf = await import('otel-png/cloudflare');
  for (const name of ['eventsToOtlp', 'fetchTraceEvents', 'toUnixNano', 'runQuery']) assert.equal(typeof cf[name], 'function', name);
  const { default: pkg } = await import('otel-png/package.json', { with: { type: 'json' } });
  assert.equal(pkg.engines.node, '>=20');
  await assert.rejects(import('otel-png/otel-png-model.mjs'), { code: 'ERR_PACKAGE_PATH_NOT_EXPORTED' });
});
