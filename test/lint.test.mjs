// The leak scan finds hashed values in files without the repository naming them.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { findLeaks, sha256, LEAKED } from '../tools/leak-scan.mjs';

const planted = ['planted-worker-name', 'upstream.example.org', '0f1e2d3c4b5a69788796a5b4c3d2e1f0', '12345678-9abc-4def-8123-456789abcdef'];
const hashes = new Set(planted.map(sha256));

test('leak scan catches planted tokens in a file, alone or embedded', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'otel-png-lint-'));
  try {
    const file = path.join(dir, 'fixture.json');
    fs.writeFileSync(file, JSON.stringify({
      service: 'planted-worker-name',
      url: 'https://api.upstream.example.org/v1?x=1',
      etag: '"0f1e2d3c4b5a69788796a5b4c3d2e1f0"',
      version: 'v=12345678-9abc-4def-8123-456789abcdef;',
    }));
    assert.deepEqual(findLeaks(fs.readFileSync(file, 'utf8'), hashes).sort(), [...hashes].sort());
    fs.writeFileSync(file, 'host: dev.planted-worker-name.workers.dev');
    assert.deepEqual(findLeaks(fs.readFileSync(file, 'utf8'), hashes), [sha256('planted-worker-name')]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('leak scan does not match prefixes or near misses', () => {
  assert.deepEqual(findLeaks('planted-worker-names upstream.example.organic 0f1e2d3c4b5a69788796a5b4c3d2e1f01', hashes), []);
});

test('the real fixture is clean against the shipped hash list', () => {
  assert.equal(LEAKED.size, 4);
  for (const h of LEAKED) assert.match(h, /^[0-9a-f]{64}$/);
  assert.deepEqual(findLeaks(fs.readFileSync('test/fixtures/cf-events.real.json', 'utf8')), []);
});
