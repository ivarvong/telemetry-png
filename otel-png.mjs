// otel-png.mjs — render an OTLP JSON trace as PNG pages. Pure JS, zero dependencies.
//
//   import { renderTracePages, renderTrace, openTrace, createTracer } from './otel-png.mjs'
//   const pages = await renderTracePages(otlpJson)      // Uint8Array[], each sized for a vision model
//   const tall  = await renderTrace(otlpJson)           // one tall image, for people
//   const t = openTrace(otlpJson); new Response(t.stream(0))   // streamed, bounded memory
//
// Three stages with hard boundaries, each testable alone:
//   otel-png-model.mjs    OTLP -> trace model: forest, self time, critical path. No pixels.
//   otel-png-layout.mjs   model -> pages of draw operations. No OTLP, no bytes.
//   otel-png-raster.mjs   draw operations -> scanlines; this file frames them as PNG.
//
// Options: width (1280, clamped to 720..8192), maxHeight (960; Infinity for one tall
// image), scale (1 | 2), detail (true), fold (5; 0 = off), compress, tracer.
// Invalid values throw a RangeError before any work is done.
//
// Defaults target a vision model: one page is at most 1280 x 960 at 1x, about 1.2 MP,
// which models read at native resolution instead of downscaling.
//
// COMPRESSION IS FLAGGED: { compress: 'stream' | 'js' }, default 'stream'.
//   'stream'  the platform's CompressionStream. Native zlib; in workerd it runs outside
//             JS execution. Smaller output. Needs an async consumer.
//   'js'      otel-png-deflate.mjs. Synchronous, no platform APIs, larger output.
//             All of it is JS CPU. The *Sync functions and chunks() always use it.
// OPEN QUESTION, to be benchmarked on production Workers with CPU time as the metric:
// whether native CompressionStream time is billed to the Worker.

import { normalize, buildTrace } from './otel-png-model.mjs';
import { layoutTrace } from './otel-png-layout.mjs';
import { makeCanvas, PALETTE, fontsLoaded, loadFonts } from './otel-png-raster.mjs';
import { makeDeflater } from './otel-png-deflate.mjs';
import { createTracer, untraced } from './otel-png-tracer.mjs';

export { createTracer, untraced };

// ---------- PNG framing ----------

const CRC_TABLE = new Uint32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c;
});

// chunk = length(u32 BE) | type(4 ASCII) | data | CRC32(type + data)
function chunk(type, data) {
  const out = new Uint8Array(12 + data.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, data.length);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(data, 8);
  let c = ~0;
  for (let i = 4; i < 8 + data.length; i++) c = CRC_TABLE[(c ^ out[i]) & 0xff] ^ (c >>> 8);
  view.setUint32(8 + data.length, ~c >>> 0);
  return out;
}

function preamble(W, H) {
  const ihdr = new Uint8Array(13);
  const view = new DataView(ihdr.buffer);
  view.setUint32(0, W);
  view.setUint32(4, H);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 3; // colour type: indexed
  const plte = new Uint8Array(PALETTE.flatMap((c) => [c >> 16, (c >> 8) & 0xff, c & 0xff]));
  return [Uint8Array.of(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a), chunk('IHDR', ihdr), chunk('PLTE', plte)];
}

const concat = (parts) => {
  const all = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) { all.set(p, o); o += p.length; }
  return all;
};

// ---------- pipeline ----------

const COMPRESS = ['stream', 'js'];
function checkOptions({ width = 1280, maxHeight = 960, scale = 1, fold = 5, compress = 'stream' }) {
  const fail = (what, v) => { throw new RangeError(`${what}, got ${typeof v === 'string' ? JSON.stringify(v) : String(v)}`); };
  if (typeof width !== 'number' || !Number.isFinite(width)) fail('width must be a finite number', width);
  if (typeof maxHeight !== 'number' || !(maxHeight > 0)) fail('maxHeight must be a positive number or Infinity', maxHeight);
  if (scale !== 1 && scale !== 2) fail('scale must be 1 or 2', scale);
  if (typeof fold !== 'number' || !Number.isFinite(fold) || fold < 0) fail('fold must be a non-negative number', fold);
  if (!COMPRESS.includes(compress)) fail(`compress must be one of ${COMPRESS.map((c) => `'${c}'`).join(', ')}`, compress);
}

// Parse, analyse and lay out once; then render any page, as chunks or as a stream.
export function openTrace(otlp, opts = {}) {
  checkOptions(opts);
  const { scale = 1, compress = 'stream', tracer } = opts;
  const span = tracer?.span ?? untraced;
  const info = {};
  const { trace, doc } = span('prepare', (span) => {
    const normal = span('normalize', () => normalize(otlp));
    const trace = span('analyze', () => buildTrace(normal, opts), { spans: normal.spans.length, invalid: normal.invalid });
    const doc = span('layout', () => layoutTrace(trace, opts));
    if (!fontsLoaded()) span('font.decode', loadFonts);
    Object.assign(info, { spans: trace.spanCount, rows: trace.rows.length, pages: doc.pages.length, width: doc.width * scale });
    return { trace, doc };
  }, info);
  const W = doc.width * scale;

  // Shared by both back ends: open the page's span and paint its bands one at a time
  // into a single reused buffer.
  const begin = (i, mode) => {
    const page = doc.pages[i];
    if (!page) throw new RangeError(`page ${i} of ${doc.pages.length}`);
    const H = page.height * scale;
    const stats = { page: i + 1, compress: mode, width: W, height: H, raw_bytes: (W + 1) * H, png_bytes: 0 };
    const root = span.open(`page ${i + 1}`, stats);
    const canvas = makeCanvas(doc.width, doc.maxBand, scale);
    const paint = (span, band) => {
      const a = {};
      return span('paint', () => {
        const view = canvas.paint({ y: band.y, h: band.h, ops: band.ops() });
        Object.assign(a, { scanlines: band.h * scale, bytes: view.length, ...canvas.stats });
        return view;
      }, a);
    };
    return { page, H, stats, root, paint };
  };

  // compress 'js': a synchronous generator of PNG chunks. Each next() is one band.
  function* chunks(i) {
    const { page, H, stats, root, paint } = begin(i, 'js');
    const span = root.span;
    const out = (bytes) => { stats.png_bytes += bytes.length; return bytes; };
    let failure;
    try {
      const deflater = makeDeflater(W + 1);
      for (const p of preamble(W, H)) yield out(p);
      for (const band of page.bands()) {
        yield out(span(band.name, (span) => {
          const view = paint(span, band);
          const d = {};
          const z = span('deflate', () => {
            const z = deflater.write(view);
            Object.assign(d, { bytes_in: view.length, bytes_out: z.length });
            return z;
          }, d);
          return span('idat', () => chunk('IDAT', z));
        }));
      }
      yield out(chunk('IDAT', deflater.end()));
      yield out(chunk('IEND', new Uint8Array(0)));
    } catch (e) {
      failure = e;
      throw e;
    } finally {
      root.end(failure);
    }
  }

  // compress 'stream': bands go to a CompressionStream; its output is framed as IDAT.
  // Each band is copied before it is written: Node's CompressionStream can still be
  // reading a chunk after write() resolves, so handing it the reused buffer corrupts
  // scanlines (seen in practice; test/png.test.mjs holds both back ends to equal pixels).
  function viaPlatform(i) {
    const { page, H, stats, root, paint } = begin(i, 'stream');
    const span = root.span;
    try {
      const deflate = span('new CompressionStream', () => new CompressionStream('deflate'));
      const writer = deflate.writable.getWriter();
      const emit = (c, bytes) => { stats.png_bytes += bytes.length; c.enqueue(bytes); };
      const out = deflate.readable.pipeThrough(new TransformStream({
        start: (c) => preamble(W, H).forEach((p) => emit(c, p)),
        transform: (z, c) => emit(c, span('idat', () => chunk('IDAT', z), { bytes: z.length })),
        flush: (c) => { emit(c, chunk('IEND', new Uint8Array(0))); root.end(); },
      }));
      (async () => {
        for (const band of page.bands()) {
          await span(band.name, async (span) => {
            const view = paint(span, band);
            await span('deflate.write', () => writer.write(view.slice()), { bytes_in: view.length });
          });
        }
        await span('deflate.close', () => writer.close());
      })().catch((e) => { root.end(e); writer.abort(e).catch(() => {}); });
      return out;
    } catch (e) {
      root.end(e);
      throw e;
    }
  }

  function stream(i) {
    if (compress === 'stream') return viaPlatform(i);
    const it = chunks(i);
    return new ReadableStream({
      pull(c) { const { done, value } = it.next(); if (done) c.close(); else c.enqueue(value); },
      cancel() { it.return(); },
    });
  }

  return {
    trace,
    pages: doc.pages.length,
    width: W,
    heights: doc.pages.map((p) => p.height * scale),
    chunks,
    stream,
  };
}

async function collect(stream) {
  const parts = [];
  const reader = stream.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return concat(parts);
    parts.push(value);
  }
}

const tall = (opts) => ({ ...opts, maxHeight: Infinity });

// Pages sized for a vision model.
export function renderTracePagesSync(otlp, opts) {
  const t = openTrace(otlp, opts);
  return Array.from({ length: t.pages }, (_, i) => concat([...t.chunks(i)]));
}
export async function renderTracePages(otlp, opts) {
  const t = openTrace(otlp, opts);
  const out = [];
  for (let i = 0; i < t.pages; i++) out.push(await collect(t.stream(i)));
  return out;
}

// One tall image.
export const renderTraceSync = (otlp, opts) => renderTracePagesSync(otlp, tall(opts))[0];
export const renderTrace = async (otlp, opts) => (await renderTracePages(otlp, tall(opts)))[0];
export const renderTraceStream = (otlp, opts) => openTrace(otlp, tall(opts)).stream(0);
