// Hostile inputs fail with clear errors or render; they never crash inside the renderer.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { parseProfile, decodeProfile, flameGraph, profileTable, summary, rasterize } from '../src/index.js';
import { gunzip, MAX_INFLATED_BYTES } from '../src/profile.js';

const cpu = readFileSync(new URL('../fixtures/cpu.pprof', import.meta.url));

// Minimal protobuf writer: varint fields and length-delimited messages.
const varint = (n) => { const out = []; for (; n > 127; n = Math.floor(n / 128)) out.push((n & 127) | 128); out.push(n); return out; };
const field = (f, v) => [...varint(f * 8), ...varint(v)];
const message = (f, bytes) => [...varint(f * 8 + 2), ...varint(bytes.length), ...bytes];
const str = (s) => message(6, [...new TextEncoder().encode(s)]);

test('a location whose line has no function link renders as (unknown) in every view', () => {
  const bytes = Uint8Array.from([
    ...['', 'samples', 'count', 'main.work'].flatMap(str),
    ...message(1, [...field(1, 1), ...field(2, 2)]),                  // sample_type samples/count
    ...message(5, [...field(1, 1), ...field(2, 3)]),                  // function 1 = main.work
    ...message(4, [...field(1, 1), ...message(4, field(1, 1))]),      // location 1 -> function 1
    ...message(4, [...field(1, 2), ...message(4, field(2, 7))]),      // location 2: line without a function
    ...message(2, [...field(1, 2), ...field(1, 1), ...field(2, 5)]), // sample: leaf location 2, caller 1
    ...message(2, [...field(1, 1), ...field(2, 3)]),
  ]);
  const p = decodeProfile(bytes);
  assert.equal(p.locations.lineFn[1], -1);
  for (const view of [profileTable, flameGraph]) {
    const dl = view(p, { maxHeight: 900 });
    const texts = dl.ops.filter((o) => o.op === 'text').map((o) => o.text).join('\n');
    assert.match(texts, /\(unknown\)/, view.name);
    assert.doesNotMatch(texts, /undefined/, view.name);
    assert.equal(rasterize(dl).length, dl.width * dl.height * 3);
  }
  const s = summary(p);
  assert.match(s, /\(unknown\)/);
  assert.doesNotMatch(s, /undefined/);
});

test('gzip output is capped: a bomb is refused, not inflated', async () => {
  const bomb = gzipSync(Buffer.alloc(MAX_INFLATED_BYTES + 1), { level: 9 });
  assert.ok(bomb.length < 1e6);
  await assert.rejects(parseProfile(bomb), (e) => e instanceof RangeError && /inflates to more than 67108864 bytes/.test(e.message));
  await assert.rejects(gunzip(gzipSync(Buffer.alloc(4096)), { maxBytes: 4095 }), /more than 4095 bytes/);
  assert.equal((await gunzip(gzipSync(Buffer.alloc(4096)), { maxBytes: 4096 })).length, 4096);
});

test('truncated or corrupt gzip has a clear error message', async () => {
  const gz = gzipSync(cpu);
  for (const bad of [gz.subarray(0, gz.length >> 1), gz.subarray(0, 12), Uint8Array.from([0x1f, 0x8b, 0, 0, 0])]) {
    await assert.rejects(parseProfile(bad), (e) => /invalid or truncated gzip data \(.+\)/.test(e.message));
  }
});

test('canvas sizes are validated: NaN, fractional, tiny and huge widths are refused', async () => {
  const p = await parseProfile(cpu);
  for (const view of [profileTable, flameGraph]) {
    for (const width of [NaN, Infinity, 'abc', 100, 1000.5, 1e5]) assert.throws(() => view(p, { width }), /width must be an integer from 320 to 8192/, `${view.name} ${width}`);
    for (const maxHeight of [NaN, 0, -1, 1e6]) assert.throws(() => view(p, { maxHeight }), /maxHeight must be a number/, `${view.name} ${maxHeight}`);
    assert.equal(view(p, { width: 8192 }).width, 8192);
  }
});
