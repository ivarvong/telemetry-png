import { test } from 'node:test';
import assert from 'node:assert/strict';
import { homedir } from 'node:os';
import { parseEnv, sanitizeProfile } from '../tools/capture-profile.mjs';
import { PROFILE_METADATA } from '../worker-bench/profile-artifacts.mjs';

test('capture env parsing accepts protected shell env syntax without evaluation', () => {
  assert.deepEqual(parseEnv("export CF_ACCOUNT_ID='account'\nCF_API_TOKEN=token\nIGNORED LINE\n"), {
    CF_ACCOUNT_ID: 'account',
    CF_API_TOKEN: 'token',
  });
});

test('published profile artifacts attest synthetic local provenance', () => {
  assert.equal(PROFILE_METADATA.scope, 'SYNTHETIC TRACE; LOCAL NODE.JS CPU PROFILE; NOT A PRODUCTION MEASUREMENT');
  assert.equal(PROFILE_METADATA.targetTrace.synthetic, true);
  assert.equal(PROFILE_METADATA.targetTrace.traceId, 'feedfacefeedfacefeedfacefeedface');
  assert.match(PROFILE_METADATA.provenance, /No production telemetry/);
  assert.doesNotMatch(JSON.stringify(PROFILE_METADATA), /workers\.dev|\/Users\//);
});

test('captured CDP source URLs publish labels, never absolute home or temp paths', () => {
  const temporary = '/private/tmp/otel-png-capture-test';
  const profile = {
    nodes: [
      { id: 1, callFrame: { functionName: 'worker', url: `${homedir()}/code/otel-png/worker-bench/worker.mjs` } },
      { id: 2, callFrame: { functionName: 'external', url: `${temporary}/bundle.js` } },
      { id: 3, callFrame: { functionName: 'runtime', url: 'cloudflare-internal:runtime' } },
    ],
    samples: [1, 2, 3],
  };
  const clean = sanitizeProfile(profile, temporary);
  assert.equal(clean.nodes[0].callFrame.url, 'source://worker-bench/worker.mjs');
  assert.equal(clean.nodes[1].callFrame.url, 'source://external/bundle.js');
  assert.equal(clean.nodes[2].callFrame.url, 'cloudflare-internal:runtime');
  assert.doesNotMatch(JSON.stringify(clean), new RegExp(`${homedir()}|${temporary}`));
  assert.match(profile.nodes[0].callFrame.url, new RegExp(homedir()), 'input is not mutated');
});
