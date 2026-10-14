#!/usr/bin/env node
// otel-png-cli.mjs — Node command line for otel-png. Kept out of the library so the
// library has no reference to node: modules and loads unchanged on Workers.
//
//   otel-png trace.json [out.png] [options]
//
// One page writes out.png (default trace.png); several write out-01.png, out-02.png, ...
// Usage errors exit 2, failures exit 1; both print one line, never a stack trace.
import fs from 'node:fs';
import { parseArgs } from 'node:util';
import { openTrace, createTracer, untraced } from './otel-png.mjs';

const USAGE = `usage: otel-png trace.json [out.png] [options]

Renders an OTLP/JSON trace as PNG. One page writes out.png (default trace.png);
several write out-01.png, out-02.png, ...

  --tall              one tall image instead of pages
  --max-height N      page height in logical pixels (default 960)
  --width N           logical width, 720..8192 (default 1280)
  --scale 1|2         device pixels per logical pixel (default 1)
  --fold N            fold N or more identical leaf siblings (default 5, 0 = off)
  --no-detail         omit attribute lines
  --compress stream|js  platform CompressionStream or pure-JS deflate (default stream)
  --trace self.json   write the renderer's own OTLP trace
  -h, --help          show this help
  --version           print the version`;

const usageError = (message) => {
  console.error(`otel-png: ${message}\n(run otel-png --help for usage)`);
  process.exit(2);
};

let parsed;
try {
  parsed = parseArgs({
    allowPositionals: true,
    options: {
      tall: { type: 'boolean' }, 'max-height': { type: 'string' }, width: { type: 'string' }, scale: { type: 'string' },
      fold: { type: 'string' }, 'no-detail': { type: 'boolean' }, compress: { type: 'string' }, trace: { type: 'string' },
      help: { type: 'boolean', short: 'h' }, version: { type: 'boolean' },
    },
  });
} catch (e) {
  usageError(e.message);
}
const { values: v, positionals } = parsed;
if (v.help) { console.log(USAGE); process.exit(0); }
if (v.version) {
  console.log(JSON.parse(fs.readFileSync(new URL('./package.json', import.meta.url), 'utf8')).version);
  process.exit(0);
}
const num = (name) => {
  const s = v[name];
  if (s === undefined) return undefined;
  const n = Number(s);
  if (s.trim() === '' || !Number.isFinite(n)) usageError(`--${name} expects a number, got ${JSON.stringify(s)}`);
  return n;
};
const opts = {
  compress: v.compress ?? 'stream',
  maxHeight: v.tall ? Infinity : num('max-height'),
  width: num('width'), scale: num('scale'), fold: num('fold'),
  detail: !v['no-detail'],
};
for (const k of Object.keys(opts)) if (opts[k] === undefined) delete opts[k];
if (positionals.length === 0) usageError('missing input trace.json');
if (positionals.length > 2) usageError(`unexpected argument ${JSON.stringify(positionals[2])}`);
const [input, output = 'trace.png'] = positionals;
const traceOut = v.trace;

try {
  const tracer = traceOut ? createTracer('otel-png') : null;
  const span = tracer?.span ?? untraced;
  await span(`otel-png ${input}`, async (span) => {
    const io = {};
    const otlp = span('read + JSON.parse', () => {
      const text = fs.readFileSync(input, 'utf8');
      io.json_bytes = text.length;
      try {
        return JSON.parse(text);
      } catch (e) {
        throw new Error(`${input}: not valid JSON (${e.message})`);
      }
    }, io);
    const t = openTrace(otlp, { ...opts, tracer: tracer && { span } });
    for (let i = 0; i < t.pages; i++) {
      const file = t.pages === 1 ? output : output.replace(/(\.png)?$/, `-${String(i + 1).padStart(2, '0')}.png`);
      const fd = fs.openSync(file, 'w');
      let bytes = 0;
      try {
        for await (const p of t.stream(i)) bytes += fs.writeSync(fd, p);
      } finally {
        fs.closeSync(fd);
      }
      console.log(`${file}: ${t.width}x${t.heights[i]}, ${bytes} bytes`);
    }
  });
  if (traceOut) fs.writeFileSync(traceOut, JSON.stringify(tracer.toOtlp(), null, 1));
} catch (e) {
  console.error(`otel-png: ${e?.message || e}`);
  process.exit(1);
}
