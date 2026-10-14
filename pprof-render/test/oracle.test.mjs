// Ground truth: text dumps from `go tool pprof` (-raw, -top) for the same files.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseProfile, sampleIndex } from '../src/profile.js';
import { top, buildTrie } from '../src/aggregate.js';

const fx = (n) => new URL(`../fixtures/${n}`, import.meta.url);
const load = (n) => parseProfile(readFileSync(fx(n)));

function parseRaw(text) {
  const lines = text.split('\n'), samples = [], locations = [];
  let mode = '', types = [];
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    if (l === 'Samples:') { mode = 's'; types = lines[++i].trim().split(/\s+/).map((t) => t.replace('[dflt]', '')); continue; }
    if (l === 'Locations') { mode = 'l'; continue; }
    if (l === 'Mappings') { mode = 'm'; continue; }
    if (mode === 's') {
      const m = /^\s*((?:-?\d+\s+)*-?\d+): ?([\d ]*)$/.exec(l);
      if (m) samples.push({ values: m[1].trim().split(/\s+/).map(Number), locs: m[2].trim().split(/\s+/).filter(Boolean).map(Number), labels: [] });
      else if (l.trim()) samples.at(-1).labels.push(l.trim());
    } else if (mode === 'l') {
      // pprof prints its own simplified name, then "(original)" when they differ; compare the original.
      const m = /^\s*(\d+): (0x[0-9a-f]+) (?:M=\d+ )?(.*)$/.exec(l);
      const frame = (s) => { const f = /^(.*) (\S+):(-?\d+):(-?\d+) s=(-?\d+)(?:\((.*)\))?$/.exec(s); return f && { fn: f[6] ?? f[1], file: f[2], line: +f[3] }; };
      if (m) locations.push({ id: +m[1], addr: BigInt(m[2]), lines: [frame(m[3])].filter(Boolean) });
      else if (l.trim()) locations.at(-1).lines.push(frame(l.trim()));
    }
  }
  return { types, samples, locations };
}

const UNIT = { ns: 1, us: 1e3, ms: 1e6, s: 1e9, mins: 60e9, hrs: 3600e9, B: 1, kB: 1024, MB: 1024 ** 2, GB: 1024 ** 3, '': 1 };
function parseTop(text) {
  const rows = [], q = (s) => { const m = /^(-?[\d.]+)([a-zA-Z]*)$/.exec(s); const d = (m[1].split('.')[1] ?? '').length; return { v: +m[1] * UNIT[m[2]], tol: 0.5001 * 10 ** -d * UNIT[m[2]] }; };
  let on = false;
  for (const l of text.split('\n')) {
    if (/^\s*flat\s+flat%/.test(l)) { on = true; continue; }
    const m = on && /^\s*(\S+)\s+\S+%\s+\S+%\s+(\S+)\s+\S+%\s+(.*?)(?: \(inline\))?$/.exec(l);
    if (m) rows.push({ flat: q(m[1]), cum: q(m[2]), name: m[3] });
  }
  return rows;
}

for (const name of ['cpu', 'mem']) {
  test(`${name}: decoder matches pprof -raw`, async () => {
    const p = await load(`${name}.pprof`), raw = parseRaw(readFileSync(fx(`${name}.raw.txt`), 'utf8'));
    assert.deepEqual(p.sampleTypes.map((t) => `${t.type}/${t.unit}`), raw.types);
    assert.equal(p.samples.count, raw.samples.length);
    const { locOffsets, locs, values, nValues } = p.samples;
    raw.samples.forEach((s, i) => {
      assert.deepEqual([...values.subarray(i * nValues, (i + 1) * nValues)], s.values, `sample ${i} values`);
      assert.deepEqual([...locs.subarray(locOffsets[i], locOffsets[i + 1])].map((x) => p.locations.ids[x]), s.locs, `sample ${i} stack`);
    });
    assert.equal(p.labels.length, raw.samples.reduce((n, s) => n + s.labels.length, 0), 'label count');
    assert.equal(p.locations.count, raw.locations.length);
    raw.locations.forEach((l, i) => {
      assert.equal(p.locations.ids[i], l.id);
      assert.equal(p.locations.addresses[i], l.addr);
      const got = [];
      for (let k = p.locations.lineOffsets[i]; k < p.locations.lineOffsets[i + 1]; k++) {
        const f = p.locations.lineFn[k];
        got.push({ fn: p.functions.names[f], file: p.functions.filenames[f], line: p.locations.lineNo[k] });
      }
      assert.deepEqual(got, l.lines, `location ${l.id}`);
    });
  });
}

for (const [name, topFile, type] of [['cpu', 'cpu.top.txt', undefined], ['mem', 'mem.top.alloc_space.txt', 'alloc_space']]) {
  test(`${name}: flat/cum match pprof -top`, async () => {
    const p = await load(`${name}.pprof`), vi = sampleIndex(p, type), t = top(p, vi);
    const rows = parseTop(readFileSync(fx(topFile), 'utf8'));
    assert.ok(rows.length > 20, `parsed ${rows.length} rows`);
    const byName = new Map(p.functions.names.map((n, i) => [n, i]));
    assert.equal(byName.size, p.functions.count, 'function names are unique in this fixture');
    for (const r of rows) {
      const f = byName.get(r.name);
      assert.ok(f !== undefined, `function ${r.name}`);
      assert.ok(Math.abs(t.flat[f] - r.flat.v) <= r.flat.tol, `${r.name} flat ${t.flat[f]} vs ${r.flat.v}`);
      assert.ok(Math.abs(t.cum[f] - r.cum.v) <= r.cum.tol, `${r.name} cum ${t.cum[f]} vs ${r.cum.v}`);
    }
    // Trie invariants: total = self + children; root total = sum of all values.
    const tr = buildTrie(p, vi);
    assert.equal(tr.total[0], t.total);
    for (let n = 0; n < tr.size; n++) assert.equal(tr.total[n], tr.self[n] + tr.children[n].reduce((s, c) => s + tr.total[c], 0));
  });
}
