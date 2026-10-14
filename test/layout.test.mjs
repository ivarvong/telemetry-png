// Geometry, independent of encoding: draw operations only, no pixels.
import test from 'node:test';
import assert from 'node:assert/strict';
import { normalize, buildTrace } from '../otel-png-model.mjs';
import { layoutTrace } from '../otel-png-layout.mjs';
import { CELL } from '../otel-png-raster.mjs';
import { synth } from '../tools/synth.mjs';
import { otlp, load, fixtures } from './helpers.mjs';

const model = (o, opts) => buildTrace(normalize(o), opts);
const long = 'x'.repeat(40) + ' → ' + 'é'.repeat(300);
const hostile = otlp(['svc-' + long, long, 0, 100, { attrs: { [long]: long, k: long }, error: long }, [
  ['a', long, 1, 99, { attrs: { a: 1 } }, Array.from({ length: 30 }, (_, i) => ['b', 'deep ' + long, 2 + i, 90 - i, { attrs: { i } }]).reduceRight((kid, me) => [[...me.slice(0, 5), kid]], [])],
]]);
const cases = [...fixtures().map((f) => [f, load(`${f}.json`)]), ['synth 300', synth(300)], ['hostile strings, depth 32', hostile]];

function check(name, doc) {
  for (const [p, page] of doc.pages.entries()) {
    let y = 0;
    for (const band of page.bands()) {
      assert.equal(band.y, y, `${name} p${p} ${band.name}: bands must tile`);
      assert.ok(band.h <= doc.maxBand, `${name} ${band.name}: taller than maxBand`);
      const lines = new Map();
      for (const o of band.ops()) {
        if (o.op !== 'text') continue;
        const x1 = o.x + [...o.str].length * CELL.w;
        assert.ok(o.x >= 0 && x1 <= doc.width, `${name} p${p} ${band.name}: "${o.str.slice(0, 30)}" spans ${o.x}..${x1}, page is ${doc.width}`);
        assert.ok(o.y >= 0 && o.y + CELL.h <= band.h + 1, `${name} ${band.name}: text at y=${o.y} leaves a band ${band.h} tall`);
        if (!lines.has(o.y)) lines.set(o.y, []);
        lines.get(o.y).push([o.x, x1, o.str]);
      }
      for (const runs of lines.values()) {
        runs.sort((a, b) => a[0] - b[0]);
        for (let i = 1; i < runs.length; i++) assert.ok(runs[i][0] >= runs[i - 1][1], `${name} p${p} ${band.name}: "${runs[i - 1][2].slice(0, 24)}" overlaps "${runs[i][2].slice(0, 24)}"`);
      }
      y += band.h;
    }
    assert.equal(y, page.height, `${name} p${p}: bands must add up to the page height`);
  }
}

for (const [name, o] of cases) {
  test(`text stays in bounds and never overlaps: ${name}`, () => {
    for (const opts of [{}, { maxHeight: Infinity }, { width: 720 }, { width: 2000, detail: false }]) check(name, layoutTrace(model(o), opts));
  });
}

test('pagination covers every row once and respects maxHeight', () => {
  const t = model(synth(300));
  const doc = layoutTrace(t, { maxHeight: 960 });
  assert.ok(doc.pages.length > 1);
  assert.equal(doc.pages[0].from, 0);
  for (let p = 1; p < doc.pages.length; p++) assert.equal(doc.pages[p].from, doc.pages[p - 1].to);
  assert.equal(doc.pages.at(-1).to, t.rows.length);
  for (const page of doc.pages) assert.ok(page.height <= 960);
  assert.equal(layoutTrace(t, { maxHeight: Infinity }).pages.length, 1);
});

test('a page always takes at least one row, even if it cannot fit', () => {
  const doc = layoutTrace(model(synth(20)), { maxHeight: 50 });
  assert.equal(doc.pages.length, model(synth(20)).rows.length);
});

test('layoutTrace rejects non-finite widths and clamps the rest to 720..8192', () => {
  const t = model(synth(20));
  for (const width of [NaN, Infinity, 'abc']) assert.throws(() => layoutTrace(t, { width }), RangeError);
  assert.throws(() => layoutTrace(t, { maxHeight: NaN }), RangeError);
  assert.equal(layoutTrace(t, { width: 1e7 }).width, 8192);
  assert.equal(layoutTrace(t, { width: 1 }).width, 720);
});
