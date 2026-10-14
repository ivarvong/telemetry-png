// The encoder alone: whatever goes in must inflate back out, byte for byte.
// zlib's inflate also verifies the Adler-32 trailer, so that is covered too.
import test from 'node:test';
import assert from 'node:assert/strict';
import { makeDeflater } from '../otel-png-deflate.mjs';
import { inflate } from './helpers.mjs';

const prng = (seed) => () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32);

function roundTrip(data, stride, bandRows) {
  const d = makeDeflater(stride);
  const parts = [];
  for (let i = 0; i < data.length; i += stride * bandRows) parts.push(d.write(data.subarray(i, Math.min(data.length, i + stride * bandRows))));
  parts.push(d.end());
  const z = Buffer.concat(parts);
  assert.deepEqual(inflate(z), data);
  return z.length;
}

// Scanline-like data: mostly zero, some runs, some rows equal to the one above.
function sparse(stride, rows, seed, density = 0.03) {
  const rnd = prng(seed), data = new Uint8Array(stride * rows);
  for (let r = 0; r < rows; r++) {
    const o = r * stride;
    if (r > 0 && rnd() < 0.3) { data.copyWithin(o, o - stride, o); continue; }
    for (let i = 1; i < stride; i++) {
      if (rnd() < density) { const v = 1 + Math.floor(rnd() * 70), n = 1 + Math.floor(rnd() * rnd() * 40); for (let k = 0; k < n && i < stride; k++, i++) data[o + i] = rnd() < 0.7 ? v : 1 + Math.floor(rnd() * 70); }
    }
  }
  return data;
}

test('all zeros', () => {
  const size = roundTrip(new Uint8Array(1281 * 200), 1281, 16);
  assert.ok(size < 2000, `256 KB of zeros took ${size} bytes`);
});

test('sparse scanlines, single and multiple bands', () => {
  for (const [stride, rows, bands] of [[1281, 300, 300], [1281, 300, 17], [2561, 120, 1], [9, 500, 7], [2, 50, 50]]) roundTrip(sparse(stride, rows, stride + rows), stride, bands);
});

test('incompressible noise', () => {
  const rnd = prng(42), data = new Uint8Array(701 * 64).map(() => Math.floor(rnd() * 256));
  roundTrip(data, 701, 8);
});

test('run lengths around the 258-byte match limit', () => {
  for (const n of [1, 2, 3, 4, 257, 258, 259, 260, 261, 515, 516, 517, 518, 519, 1000]) {
    for (const v of [0, 7]) {
      const data = new Uint8Array(2000);
      data[0] = 9; data.fill(v, 1, 1 + n); data[1 + n] = 9;
      roundTrip(data, 2000, 1);
      roundTrip(data, 1000, 1);
    }
  }
});

test('stride wider than the deflate window: the row above is out of reach', () => {
  roundTrip(sparse(40001, 6, 3), 40001, 2);
});

test('high byte values use 9-bit and long codes correctly', () => {
  const rnd = prng(9), data = new Uint8Array(513 * 40).map(() => (rnd() < 0.5 ? 0 : 128 + Math.floor(rnd() * 128)));
  roundTrip(data, 513, 5);
});

test('a view into a larger buffer at an unaligned offset', () => {
  const big = new Uint8Array(3 + 1281 * 20);
  big.set(sparse(1281, 20, 5), 3);
  roundTrip(big.subarray(3), 1281, 4);
});

test('deterministic: the same input gives the same bytes', () => {
  const data = sparse(1281, 100, 11);
  const run = () => { const d = makeDeflater(1281); return Buffer.concat([d.write(data), d.end()]); };
  assert.deepEqual(run(), run());
});
