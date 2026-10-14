#!/usr/bin/env node
// otel-png-cli.mjs — Node command line for otel-png. Kept out of the library so the
// library has no reference to node: modules and loads unchanged on Workers.
//
//   node otel-png-cli.mjs trace.json [out.png] [options]
//     --tall              one tall image instead of pages
//     --max-height N      page height in logical pixels (default 960)
//     --width N           logical width (default 1280)
//     --scale 1|2         device pixels per logical pixel (default 1)
//     --fold N            fold N or more identical leaf siblings (default 5, 0 = off)
//     --no-detail         omit attribute lines
//     --compress stream|js
//     --trace self.json   write the renderer's own OTLP trace
//
// One page writes out.png; several write out-01.png, out-02.png, ...
import fs from 'node:fs';
import { openTrace, createTracer, untraced } from './otel-png.mjs';

const args = process.argv.slice(2);
const flag = (name) => { const i = args.indexOf(name); return i >= 0 ? args.splice(i, 2)[1] : undefined; };
const has = (name) => { const i = args.indexOf(name); return i >= 0 ? (args.splice(i, 1), true) : false; };
const num = (name) => { const v = flag(name); return v === undefined ? undefined : Number(v); };
const traceOut = flag('--trace');
const opts = {
  compress: flag('--compress') ?? 'stream',
  maxHeight: has('--tall') ? Infinity : num('--max-height'),
  width: num('--width'), scale: num('--scale'), fold: num('--fold'),
  detail: !has('--no-detail'),
};
for (const k of Object.keys(opts)) if (opts[k] === undefined) delete opts[k];
const [input, output = 'trace.png'] = args;
if (!input) {
  console.error('usage: node otel-png-cli.mjs trace.json [out.png] [--tall] [--max-height N] [--width N] [--scale 1|2] [--fold N] [--no-detail] [--compress stream|js] [--trace self.json]');
  process.exit(1);
}

const tracer = traceOut ? createTracer('otel-png') : null;
const span = tracer?.span ?? untraced;
await span(`otel-png ${input}`, async (span) => {
  const io = {};
  const otlp = span('read + JSON.parse', () => {
    const text = fs.readFileSync(input, 'utf8');
    io.json_bytes = text.length;
    return JSON.parse(text);
  }, io);
  const t = openTrace(otlp, { ...opts, tracer: tracer && { span } });
  for (let i = 0; i < t.pages; i++) {
    const file = t.pages === 1 ? output : output.replace(/(\.png)?$/, `-${String(i + 1).padStart(2, '0')}.png`);
    const fd = fs.openSync(file, 'w');
    let bytes = 0;
    for await (const p of t.stream(i)) bytes += fs.writeSync(fd, p);
    fs.closeSync(fd);
    console.log(`${file}: ${t.width}x${t.heights[i]}, ${bytes} bytes`);
  }
});
if (traceOut) fs.writeFileSync(traceOut, JSON.stringify(tracer.toOtlp(), null, 1));
