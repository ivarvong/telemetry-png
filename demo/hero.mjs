import { openTrace, createTracer, renderTraceSync } from '../otel-png.mjs';
import { synth } from '../tools/synth.mjs';
import fs from 'node:fs';
const D = process.argv[2];
const tracer = createTracer('otel-png');
const t = openTrace(synth(1000), { tracer, compress: 'js' });
let n = 0; for (const c of t.chunks(0)) n += c.length;     // render page 1 of 22
const self = tracer.toOtlp();
fs.writeFileSync(`${D}/self-page1.json`, JSON.stringify(self));
const spans = self.resourceSpans.flatMap(r => r.scopeSpans.flatMap(s => s.spans));
console.log('spans', spans.length, 'png bytes', n);
fs.writeFileSync(`${D}/hero.png`, renderTraceSync(self, { maxHeight: Infinity, scale: 2 }));
