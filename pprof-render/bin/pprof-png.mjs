#!/usr/bin/env node
// usage: pprof-png in.pprof out.png [--view table|flame] [--text out.txt] [--type alloc_space] [--width 2000]
//                  [--max-height 1400] [--font 15] [--no-collapse]
import { readFileSync, writeFileSync } from 'node:fs';
import { parseProfile, flameGraph, profileTable, rasterize, encodePNG, summary } from '../src/index.js';

const [input, output, ...rest] = process.argv.slice(2);
if (!input || !output) { console.error('usage: pprof-png in.pprof out.png [--view table|flame] [--text out.txt] [--type T] [--width N] [--max-height N] [--font N] [--no-collapse]'); process.exit(2); }
const flag = (n) => { const i = rest.indexOf(`--${n}`); return i < 0 ? undefined : rest[i + 1]; };
const t0 = performance.now(), collapse = !rest.includes('--no-collapse'), type = flag('type');
const p = await parseProfile(readFileSync(input));
const view = flag('view') ?? 'table', num = (n) => (flag(n) === undefined ? undefined : +flag(n));
if (view !== 'table' && view !== 'flame') { console.error(`unknown --view ${view} (table | flame)`); process.exit(2); }
const dl = (view === 'table' ? profileTable : flameGraph)(p, { type, collapse, width: num('width'), maxHeight: num('max-height'), fontSize: num('font') });
const png = await encodePNG(rasterize(dl), dl.width, dl.height);
writeFileSync(output, png);
let note = '';
if (flag('text')) { const s = summary(p, { type, collapse }); writeFileSync(flag('text'), s); note = `, sidecar ${s.length} chars`; }
console.error(`${output}: ${dl.width}x${dl.height}, ${dl.tokens} image tokens, ${png.length} bytes${note}, ${(performance.now() - t0).toFixed(0)}ms`);
