// Encoding and the public API: valid PNGs, both compressors agree, goldens hold.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { openTrace, renderTrace, renderTraceSync, renderTracePages, renderTracePagesSync, renderTraceStream, createTracer } from '../otel-png.mjs';
import { PALETTE } from '../otel-png-raster.mjs';
import { synth } from '../tools/synth.mjs';
import { decodePng, sha, load, fixtures } from './helpers.mjs';

const sample = load('sample-trace.json');

test('a page is a structurally valid indexed PNG', () => {
  for (const scale of [1, 2]) {
    const png = decodePng(renderTraceSync(sample, { scale }));
    assert.deepEqual(png.types.slice(0, 2), ['IHDR', 'PLTE']);
    assert.equal(png.types.at(-1), 'IEND');
    assert.ok(png.types.slice(2, -1).every((t) => t === 'IDAT'));
    assert.deepEqual([png.bitDepth, png.colorType, png.palette], [8, 3, PALETTE.length]);
    assert.equal(png.width, 1280 * scale);
    assert.equal(png.raw.length, (png.width + 1) * png.height);
    for (let o = 0; o < png.raw.length; o += png.width + 1) assert.equal(png.raw[o], 0, 'filter byte');
    assert.ok(png.raw.every((v) => v < PALETTE.length), 'palette index in range');
  }
  assert.ok(PALETTE.length <= 256);
});

test('scale 2 is exactly twice scale 1', () => {
  const a = decodePng(renderTraceSync(sample)), b = decodePng(renderTraceSync(sample, { scale: 2 }));
  assert.deepEqual([b.width, b.height], [a.width * 2, a.height * 2]);
});

test("'stream' and 'js' compression decode to identical pixels", async () => {
  for (const [o, opts] of [[sample, {}], [sample, { scale: 2 }], [synth(400), {}], [synth(400), { scale: 2, maxHeight: 2000 }]]) {
    const viaStream = await renderTracePages(o, { ...opts, compress: 'stream' });
    const viaJs = await renderTracePages(o, { ...opts, compress: 'js' });
    assert.equal(viaStream.length, viaJs.length);
    viaStream.forEach((p, i) => assert.equal(sha(decodePng(p).raw), sha(decodePng(viaJs[i]).raw), `page ${i + 1}`));
  }
  const tallStream = await renderTrace(synth(400)), tallJs = renderTraceSync(synth(400));
  assert.equal(sha(decodePng(tallStream).raw), sha(decodePng(tallJs).raw));
});

test('sync, async, chunked and streamed outputs agree; js output is deterministic', async () => {
  const a = renderTraceSync(sample);
  assert.deepEqual(renderTraceSync(sample), a);
  assert.deepEqual(await renderTrace(sample, { compress: 'js' }), a);
  assert.deepEqual(new Uint8Array(await new Response(renderTraceStream(sample, { compress: 'js' })).arrayBuffer()), a);
  const t = openTrace(sample, { maxHeight: Infinity });
  assert.deepEqual(Buffer.concat([...t.chunks(0)]), Buffer.from(a));
});

test('pages fit the default vision-model budget', () => {
  const pages = renderTracePagesSync(synth(300));
  assert.ok(pages.length > 3);
  for (const p of pages) {
    const { width, height } = decodePng(p);
    assert.equal(width, 1280);
    assert.ok(height <= 960 && width * height <= 1.25e6);
  }
  assert.throws(() => openTrace(sample).chunks(99).next(), RangeError);
});

test('bad input fails clearly; a cancelled stream does not throw', async () => {
  assert.throws(() => renderTraceSync({}), /no valid spans/);
  await assert.rejects(renderTrace({ resourceSpans: [] }), /no valid spans/);
  assert.throws(() => renderTraceSync(sample, { scale: 3 }), /scale/);
  for (const compress of ['js', 'stream']) {
    const reader = renderTraceStream(synth(200), { compress }).getReader();
    await reader.read();
    await reader.cancel();
  }
});

test('invalid options throw a RangeError before any work; width is clamped to 720..8192', () => {
  const bad = [
    [{ width: NaN }, /width/], [{ width: 'abc' }, /width/], [{ width: Infinity }, /width/], [{ width: '1280' }, /width/],
    [{ maxHeight: NaN }, /maxHeight/], [{ maxHeight: 0 }, /maxHeight/], [{ maxHeight: -5 }, /maxHeight/],
    [{ scale: 3 }, /scale/], [{ scale: '2' }, /scale/], [{ scale: NaN }, /scale/],
    [{ fold: NaN }, /fold/], [{ fold: -1 }, /fold/],
    [{ compress: 'gzip' }, /compress must be one of 'stream', 'js', got "gzip"/], [{ compress: null }, /compress/],
  ];
  for (const [opts, re] of bad) assert.throws(() => openTrace(sample, opts), (e) => e instanceof RangeError && re.test(e.message), JSON.stringify(opts));
  assert.equal(openTrace(sample, { width: 1e7 }).width, 8192);
  assert.equal(openTrace(sample, { width: 1e7, scale: 2 }).width, 16384);
  assert.equal(openTrace(sample, { width: 10 }).width, 720);
  assert.equal(decodePng(renderTracePagesSync(sample, { width: 1e9 })[0]).width, 8192);
});

test('a trace starting at the last representable uint64 nanosecond renders', () => {
  const t = (ns) => String(2n ** 64n - 1n - BigInt(ns));
  const o = { resourceSpans: [{ scopeSpans: [{ spans: [{ spanId: 'a', name: 'late', startTimeUnixNano: t(1000), endTimeUnixNano: t(0) }, { spanId: 'b', name: 'beyond', startTimeUnixNano: '18446744073709551616', endTimeUnixNano: '18446744073709551617' }] }] }] };
  const [png] = renderTracePagesSync(o);
  assert.equal(decodePng(png).width, 1280);
  assert.equal(openTrace(o).trace.invalid, 1);
});

test('peak buffer memory is bounded by the band, not the image', () => {
  const t = openTrace(synth(3000), { maxHeight: Infinity });
  const raw = (t.width + 1) * t.heights[0];
  assert.ok(raw > 60e6, 'the image itself is large');
  global.gc?.();
  const base = process.memoryUsage().arrayBuffers;
  let peak = 0;
  for (const _ of t.chunks(0)) peak = Math.max(peak, process.memoryUsage().arrayBuffers - base);
  assert.ok(peak < 16e6, `peak ${(peak / 2 ** 20).toFixed(1)} MB for ${(raw / 2 ** 20).toFixed(0)} MB of scanlines`);
});

test('the renderer traces itself: one well-formed span tree with attributes', async () => {
  const tracer = createTracer('otel-png');
  for (const compress of ['js', 'stream']) await renderTracePages(sample, { compress, tracer });
  const spans = tracer.toOtlp().resourceSpans[0].scopeSpans[0].spans;
  const ids = new Set(spans.map((s) => s.spanId));
  for (const s of spans) {
    assert.ok(!s.parentSpanId || ids.has(s.parentSpanId), `${s.name} has a parent`);
    assert.ok(BigInt(s.endTimeUnixNano) >= BigInt(s.startTimeUnixNano));
  }
  const names = new Set(spans.map((s) => s.name));
  for (const n of ['prepare', 'normalize', 'analyze', 'layout', 'page 1', 'header', 'paint', 'deflate', 'idat', 'deflate.write', 'footer']) assert.ok(names.has(n), n);
  const page = spans.find((s) => s.name === 'page 1');
  assert.ok(page.attributes.some((a) => a.key === 'png_bytes' && Number(a.value.intValue) > 1000));
});

// Image goldens: a hash of the decoded pixels per page. A visual change must be
// looked at and then recorded with UPDATE_GOLDEN=1.
test('image goldens', () => {
  const file = new URL('./golden.json', import.meta.url);
  const actual = {};
  for (const f of fixtures()) actual[f] = renderTracePagesSync(load(`${f}.json`)).map((p) => { const d = decodePng(p); return `${d.width}x${d.height}:${sha(d.raw)}`; });
  if (process.env.UPDATE_GOLDEN) fs.writeFileSync(file, JSON.stringify(actual, null, 1) + '\n');
  assert.deepEqual(actual, JSON.parse(fs.readFileSync(file, 'utf8')));
});
