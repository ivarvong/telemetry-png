// Cold renders: N fresh processes per trace, medians read from the renderer's own traces.
//   node tools/measure.mjs [runs] [--compress js|stream]
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const args = process.argv.slice(2);
const compress = args.includes('--compress') ? args[args.indexOf('--compress') + 1] : 'stream';
const runs = Number(args.find((a) => /^\d+$/.test(a)) ?? 7);
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'otel-png-'));
const root = new URL('..', import.meta.url).pathname;
const files = ['sample-trace.json', ...fs.readdirSync(root + 'examples').filter((f) => f.endsWith('.json')).sort().map((f) => 'examples/' + f)];
const med = (a) => a.sort((x, y) => x - y)[a.length >> 1];
console.log(`compress=${compress}, ${runs} fresh processes each\ntrace                  | pages |  px (MP) | total ms | prepare | paint | compress | png KB`);
for (const f of files) {
  const rs = [];
  for (let i = 0; i < runs; i++) {
    for (const old of fs.readdirSync(dir)) fs.rmSync(path.join(dir, old));
    execFileSync('node', [root + 'otel-png-cli.mjs', root + f, path.join(dir, 'o.png'), '--compress', compress, '--trace', path.join(dir, 't.json')]);
    const spans = JSON.parse(fs.readFileSync(path.join(dir, 't.json'))).resourceSpans[0].scopeSpans[0].spans;
    const d = (s) => Number(BigInt(s.endTimeUnixNano) - BigInt(s.startTimeUnixNano)) / 1e6;
    const sum = (re) => spans.filter((s) => re.test(s.name)).reduce((a, s) => a + d(s), 0);
    const attr = (s, k) => Number(s.attributes?.find((a) => a.key === k)?.value.intValue ?? 0);
    const pages = spans.filter((s) => /^page \d+$/.test(s.name));
    rs.push({ total: d(spans.find((s) => !s.parentSpanId)), prepare: sum(/^prepare$/), paint: sum(/^paint$/), z: sum(/^deflate|^new Comp/), pages: pages.length, px: pages.reduce((a, p) => a + attr(p, 'width') * attr(p, 'height'), 0), png: pages.reduce((a, p) => a + attr(p, 'png_bytes'), 0) });
  }
  const f1 = (k) => med(rs.map((r) => r[k])).toFixed(1).padStart(7);
  console.log(`${path.basename(f, '.json').padEnd(22)} | ${String(rs[0].pages).padStart(5)} | ${(rs[0].px / 1e6).toFixed(2).padStart(8)} | ${f1('total')}  | ${f1('prepare')} |${f1('paint')}|  ${f1('z')} | ${(rs[0].png / 1024).toFixed(0).padStart(5)}`);
}
fs.rmSync(dir, { recursive: true });
