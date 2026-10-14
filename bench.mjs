// bench.mjs — warm timings from the renderer's own traces. Dev tool, not part of the library.
//   node --expose-gc bench.mjs <spans> [runs] [--tall] [--scale 2]
import { openTrace, createTracer } from './otel-png.mjs';
import { synth } from './tools/synth.mjs';

const args = process.argv.slice(2);
const tall = args.includes('--tall'), scale = args.includes('--scale') ? Number(args[args.indexOf('--scale') + 1]) : 1;
const [n = '1000', runs = '5'] = args.filter((a) => /^\d+$/.test(a));
const otlp = synth(+n);

async function once(compress) {
  const tracer = createTracer('bench');
  global.gc?.();
  const base = process.memoryUsage().arrayBuffers;
  let peak = 0, bytes = 0;
  const t0 = performance.now();
  const t = openTrace(otlp, { compress, scale, tracer, ...(tall ? { maxHeight: Infinity } : {}) });
  for (let i = 0; i < t.pages; i++) {
    for await (const p of t.stream(i)) { bytes += p.length; peak = Math.max(peak, process.memoryUsage().arrayBuffers - base); }
  }
  const wall = performance.now() - t0;
  const agg = {};
  for (const s of tracer.toOtlp().resourceSpans[0].scopeSpans[0].spans) {
    const k = /^deflate|^new Comp/.test(s.name) ? 'deflate' : s.name;
    agg[k] = (agg[k] ?? 0) + Number(BigInt(s.endTimeUnixNano) - BigInt(s.startTimeUnixNano)) / 1e6;
  }
  return { wall, bytes, peak, agg, pages: t.pages, px: t.heights.reduce((a, h) => a + h * t.width, 0), rows: t.trace.rows.length };
}

for (const compress of ['stream', 'js']) {
  await once(compress);
  const rs = [];
  for (let i = 0; i < +runs; i++) rs.push(await once(compress));
  rs.sort((a, b) => a.wall - b.wall);
  const m = rs[rs.length >> 1], f = (v) => (v ?? 0).toFixed(1).padStart(6);
  console.log(`spans=${n} rows=${m.rows} ${tall ? 'tall' : `pages=${m.pages}`} ${(m.px / 1e6).toFixed(1)}MP compress=${compress.padEnd(6)} | ${f(m.wall)} ms | png ${(m.bytes / 1024).toFixed(0)} KB | peak buffers ${(m.peak / 2 ** 20).toFixed(1)} MB | analyze ${f(m.agg.analyze)} layout ${f(m.agg.layout)} paint ${f(m.agg.paint)} deflate ${f(m.agg.deflate)} idat ${f(m.agg.idat)}`);
}
