import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseProfile, flameGraph, rasterize, encodePNG, renderFlamePNG } from '../src/index.js';

const cpu = readFileSync(new URL('../fixtures/cpu.pprof', import.meta.url));

// Independent-enough PNG reader: walk chunks, verify layout, inflate, undo the Up filter.
async function decodePNG(png) {
  const dv = new DataView(png.buffer, png.byteOffset, png.byteLength), chunks = [];
  for (let o = 8; o < png.length;) { const n = dv.getUint32(o); chunks.push({ type: String.fromCharCode(...png.subarray(o + 4, o + 8)), data: png.subarray(o + 8, o + 8 + n) }); o += 12 + n; }
  const ihdr = new DataView(chunks[0].data.buffer, chunks[0].data.byteOffset), w = ihdr.getUint32(0), h = ihdr.getUint32(4);
  const idat = chunks.find((c) => c.type === 'IDAT').data;
  const raw = new Uint8Array(await new Response(new Blob([idat]).stream().pipeThrough(new DecompressionStream('deflate'))).arrayBuffer());
  const stride = w * 3, px = new Uint8Array(stride * h);
  for (let y = 0; y < h; y++) {
    const f = raw[y * (stride + 1)];
    assert.ok(f <= 2, 'filter None, Sub or Up');
    for (let i = 0; i < stride; i++) px[y * stride + i] = raw[y * (stride + 1) + 1 + i] + (f === 2 ? (y ? px[(y - 1) * stride + i] : 0) : f === 1 ? (i >= 3 ? px[y * stride + i - 3] : 0) : 0);
  }
  return { w, h, px, types: chunks.map((c) => c.type) };
}

test('display list: frames tile inside their parents and inside the canvas', async () => {
  const dl = flameGraph(await parseProfile(cpu)), box = new Map(dl.frames.map((f) => [f.node, f]));
  for (const f of dl.frames) {
    assert.ok(f.x >= 0 && f.x + f.w <= dl.width && f.y + f.h <= dl.height);
    if (f.node === 0) continue;
    const par = box.get(dl.trie.parent[f.node]);
    assert.ok(par, 'parent of a drawn frame is drawn');
    assert.ok(f.x >= par.x && f.x + f.w <= par.x + par.w, 'child within parent span');
    assert.ok(f.y > par.y);
  }
  for (const o of dl.ops) if (o.op === 'text') assert.ok(o.x >= 0 && o.x + o.text.length * 9 <= dl.width, `text fits: ${o.text}`);
});

test('png: round-trips pixels exactly and is deterministic', async () => {
  const dl = flameGraph(await parseProfile(cpu)), px = rasterize(dl), png = await encodePNG(px, dl.width, dl.height);
  const d = await decodePNG(png);
  assert.deepEqual(d.types, ['IHDR', 'sRGB', 'IDAT', 'IEND']);
  assert.deepEqual([d.w, d.h], [dl.width, dl.height]);
  assert.ok(Buffer.from(d.px).equals(Buffer.from(px)));
  assert.ok(Buffer.from(await renderFlamePNG(cpu)).equals(Buffer.from(png)));
});

import { collapseCycles, top, sampleIndex, imageTokens, summary, profileTable } from '../src/index.js';
const mem = readFileSync(new URL('../fixtures/mem.pprof', import.meta.url));

test('collapseCycles: tandem repeats only', () => {
  const c = (s) => { const r = collapseCycles([...s]); return r.frames.join('') + ' ' + r.reps.join(','); };
  assert.equal(c('ABCD'), 'ABCD 1,1,1,1');
  assert.equal(c('AAAA'), 'A 4');                          // direct recursion
  assert.equal(c('XABCABCABCY'), 'XABCY 1,3,3,3,1');       // mutual recursion
  assert.equal(c('ABCBCBCD'), 'ABCD 1,3,3,1');
  assert.equal(c('ABAC'), 'ABAC 1,1,1,1');                 // not a tandem repeat: untouched
  assert.equal(c('ABBABB'), 'AB 2,4');                     // nested
  assert.equal(c('DABCABCAB'), 'DABCAB 1,2,2,2,1,1');      // partial trailing cycle is kept
  assert.equal(c(''), ' ');
});

test('collapse leaves flat and cum per function unchanged', async () => {
  for (const bytes of [cpu, mem]) {
    const p = await parseProfile(bytes);
    for (let vi = 0; vi < p.sampleTypes.length; vi++) assert.deepEqual(top(p, vi, { collapse: true }), top(p, vi, { collapse: false }));
  }
});

test('layout respects the pixel budget, with and without room', async () => {
  const p = await parseProfile(cpu);
  for (const maxHeight of [1400, 300, 200]) {
    const dl = flameGraph(p, { maxHeight });
    assert.equal(dl.width, 2000);
    assert.ok(dl.height <= maxHeight, `${dl.height} <= ${maxHeight}`);
    assert.ok(dl.tokens === imageTokens(dl.width, dl.height) && dl.tokens <= 4784);
    for (const o of dl.ops) assert.ok(o.y >= 0 && o.y + (o.op === 'rect' ? o.h : 17) <= dl.height && o.x >= 0 && o.x + (o.op === 'rect' ? o.w : o.text.length * 9) <= dl.width);
  }
  assert.ok(flameGraph(p, { maxHeight: 300 }).ops.some((o) => o.op === 'text' && o.text.includes('more level')));
});

test('sidecar agrees with the oracle-checked top table', async () => {
  const p = await parseProfile(cpu), s = summary(p);
  assert.match(s, /50\.92s\s+24%\s+172\.19s\s+82%\s+runtime\.scanobject/);
  assert.match(s, /^all 100%$/m);
});

test('table view: fits the budget, stays on canvas, round-trips through PNG', async () => {
  for (const bytes of [cpu, mem]) {
    const p = await parseProfile(bytes);
    for (const maxHeight of [2000, 900]) {
      const dl = profileTable(p, { maxHeight });
      assert.ok(dl.width === 1600 && dl.height <= maxHeight && dl.tokens <= 4784, `${dl.width}x${dl.height} = ${dl.tokens} tokens`);
      for (const o of dl.ops) assert.ok(o.x >= 0 && o.y >= 0 && o.x + (o.op === 'rect' ? o.w : o.text.length * 9) <= dl.width && o.y + (o.op === 'rect' ? o.h : 17) <= dl.height, JSON.stringify(o));
      const px = rasterize(dl), d = await decodePNG(await encodePNG(px, dl.width, dl.height));
      assert.ok(Buffer.from(d.px).equals(Buffer.from(px)));
    }
    assert.ok(profileTable(p, { maxHeight: 900 }).threshold > profileTable(p).threshold, 'smaller budget raises the row threshold');
  }
});
