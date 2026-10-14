// Profile -> display list, table view: a text-first sheet for a vision model.
// Every row carries exact numbers as text; the bar beside it is the row's
// frame in the flame graph (same x position and width), so shape survives.
import { FONTS } from './font.js';
import { buildTrie, top, stackOf } from './aggregate.js';
import { sampleIndex } from './profile.js';
import { byFunction, checkCanvas, displayName, formatValue, imageTokens, packageOf, pct, shortName } from './flame.js';

// Dark surface; hues are the dataviz reference categorical order, dark-mode steps.
const BG = 0x000000, FG = 0xf0efec, DIM = 0x96958e, RULE = 0x5c5b56, OTHER = 0x77766f;
const HUES = [0x3987e5, 0xd95926, 0x199e70, 0xc98500, 0xd55181, 0x008300, 0x9085e9];
const dim = (c, k = 0.32) => [16, 8, 0].reduce((o, s) => o | (Math.round(((c >> s) & 255) * k) << s), 0);
const group = (n) => String(Math.round(n)).replace(/\B(?=(\d{3})+$)/g, ',');
const clip = (s, n) => (s.length <= n ? s : n >= 2 ? s.slice(0, n - 1) + '…' : '');
const fitName = (name, n) => (name.length <= n ? name : clip(shortName(name), n));

export function profileTable(p, { type, width = 1600, maxHeight = 2000, fontSize = 15, collapse = true, topN = 8 } = {}) {
  checkCanvas(width, maxHeight);
  const font = FONTS[fontSize];
  if (!font) throw new Error(`no baked font at ${fontSize}px (have ${Object.keys(FONTS).join(', ')})`);
  const vi = sampleIndex(p, type), st = p.sampleTypes[vi], trie = buildTrie(p, vi, { collapse }), t = top(p, vi), total = trie.total[0];
  if (!(total > 0)) throw new Error(`profile has no positive ${st.type} samples`);
  const names = byFunction(p.functions.names.map(displayName)), pkgs = byFunction(p.functions.names.map(packageOf)), fmt = (v) => formatValue(v, st.unit);

  const byPkg = new Map();
  t.flat.forEach((v, f) => { if (v) byPkg.set(pkgs[f], (byPkg.get(pkgs[f]) ?? 0) + v); });
  const ranked = [...byPkg].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1));
  const hueOf = new Map(ranked.slice(0, HUES.length).map(([k], i) => [k, HUES[i]]));
  const colour = (f) => hueOf.get(pkgs[f]) ?? OTHER;

  const ops = [], cw = font.w, M = 20, rowH = font.h + 3, right = width - M;
  const rect = (x, y, w, h, rgb) => { if (w > 0 && h > 0) ops.push({ op: 'rect', x, y, w, h, rgb }); };
  const text = (x, y, s, rgb = FG) => { if (s) ops.push({ op: 'text', x, y, text: s, size: fontSize, rgb }); return x + s.length * cw; };
  const textR = (xr, y, s, rgb = FG) => text(xr - s.length * cw, y, s, rgb);
  const hline = (y, rgb = RULE) => rect(M, y, right - M, 1, rgb);

  // ---- title + stat boxes ----
  let y = M;
  const binary = p.mappings[0]?.filename.split('/').pop();
  text(M, y, [binary, st.type].filter(Boolean).join(' · '));
  if (p.timeNanos > 0n) textR(right, y, new Date(Number(p.timeNanos / 1000000n)).toISOString().replace('T', ' ').replace(/\.\d+Z$/, ' UTC'), DIM);
  y += rowH + 6;
  let maxDepth = 0;
  for (let i = 0; i < p.samples.count; i++) maxDepth = Math.max(maxDepth, stackOf(p, i).length);
  const stats = [['TOTAL', fmt(total)], ['SAMPLES', group(p.samples.count)]];
  if (p.durationNanos > 0) stats.push(['WALL', formatValue(p.durationNanos, 'nanoseconds')]);
  if (p.period > 0 && p.periodType) stats.push(['PERIOD', formatValue(p.period, p.periodType.unit)]);
  stats.push(['FUNCTIONS', group(t.cum.reduce((n, v) => n + (v !== 0), 0))], ['MAX DEPTH', String(maxDepth)], ['SAMPLE TYPE', `${st.type}/${st.unit}`]);
  if (p.mappings[0]?.buildId) stats.push(['BUILD ID', p.mappings[0].buildId]);
  const boxH = 2 * rowH + 8;
  rect(M, y, right - M, 1, FG); rect(M, y + boxH - 1, right - M, 1, FG); rect(M, y, 1, boxH, FG); rect(right - 1, y, 1, boxH, FG);
  let x = M;
  stats.forEach(([k, v], i) => {
    const last = i === stats.length - 1, w = last ? right - x : (Math.max(k.length, v.length) + 3) * cw;
    if (i) rect(x, y, 1, boxH, FG);
    text(x + cw, y + 4, k, DIM);
    text(x + cw, y + 4 + rowH, clip(v, Math.floor((w - 2 * cw) / cw)));
    x += w;
  });
  y += boxH + 10;

  // ---- self by package: one stacked bar + key ----
  text(M, y, 'SELF BY PACKAGE', DIM);
  y += rowH + 1;
  const segs = [...ranked.slice(0, HUES.length).map(([k, v]) => [k, v, hueOf.get(k)])];
  const restV = ranked.slice(HUES.length).reduce((s, [, v]) => s + v, 0);
  if (restV > 0) segs.push([`+${ranked.length - HUES.length} more`, restV, OTHER]);
  let acc = 0;
  for (const [, v, c] of segs) { const xa = M + Math.round((acc / total) * (right - M)), xb = M + Math.round(((acc + v) / total) * (right - M)); rect(xa, y, xb - xa > 1 ? xb - xa - 1 : xb - xa, 9, c); acc += v; }
  y += 15;
  x = M;
  for (const [k, v, c] of segs) {
    const s = `${k} ${fmt(v)} ${pct(v, total)}`, w = (s.length + 4) * cw;
    if (x + w > right && x > M) { x = M; y += rowH; }
    rect(x, y + 5, 8, 8, c); text(x + 13, y, k, FG); text(x + 13 + (k.length + 1) * cw, y, `${fmt(v)} ${pct(v, total)}`, DIM);
    x += w;
  }
  y += rowH + 8;

  // ---- columns ----
  const NAME = 70, cSelf = M + (NAME + 11) * cw, cSelfP = cSelf + 8 * cw, cCum = cSelfP + 12 * cw, cCumP = cCum + 8 * cw, bar0 = cCumP + 3 * cw, barW = right - bar0;
  const bx = (v) => bar0 + Math.round((v / total) * barW);
  text(M, y, 'FUNCTION', DIM); textR(cSelf, y, 'SELF', DIM); textR(cSelfP, y, 'SELF%', DIM); textR(cCum, y, 'CUM', DIM); textR(cCumP, y, 'CUM%', DIM);
  for (const q of [0, 25, 50, 75]) { rect(bx((q / 100) * total), y, 1, rowH - 2, RULE); text(bx((q / 100) * total) + 5, y, `${q}%`, DIM); }
  rect(right - 1, y, 1, rowH - 2, RULE);
  y += rowH;
  hline(y - 2);
  const numbers = (yy, self, cum, hot) => {
    textR(cSelf, yy, self ? fmt(self) : '0', self ? FG : DIM); textR(cSelfP, yy, self ? pct(self, total) : '0%', self ? FG : DIM); textR(cCum, yy, fmt(cum));
    const s = pct(cum, total);
    if (hot) { rect(cCumP - (s.length + 1) * cw, yy, (s.length + 2) * cw, font.h, FG); textR(cCumP, yy, s, BG); } else textR(cCumP, yy, s);
  };

  // ---- top by self, across all call paths ----
  const callers = new Map();                                 // fn -> Map(caller fn -> value)
  for (let n = 1; n < trie.size; n++) {
    const f = trie.fn[n], c = trie.parent[n] ? trie.fn[trie.parent[n]] : -1;
    let m = callers.get(f); if (!m) callers.set(f, (m = new Map()));
    m.set(c, (m.get(c) ?? 0) + trie.total[n]);
  }
  y += 3;
  const order = [...t.flat.keys()].filter((f) => t.flat[f] > 0).sort((a, b) => t.flat[b] - t.flat[a] || t.cum[b] - t.cum[a]).slice(0, topN);
  text(M, y, `TOP ${order.length} BY SELF, ALL CALL PATHS (name < main caller; bar from 0: bright = self, dim = cum)`, DIM);
  y += rowH;
  for (const f of order) {
    const main = [...callers.get(f)].sort((a, b) => b[1] - a[1])[0][0];
    const nm = fitName(names[f], NAME), tail = main >= 0 ? ` < ${shortName(names[main])}` : '';
    const xe = text(M, y, nm, FG);
    if (nm.length + tail.length <= NAME) text(xe, y, tail, DIM);
    numbers(y, t.flat[f], t.cum[f], false);
    rect(bar0, y + 4, bx(t.cum[f]) - bar0, font.h - 8, dim(colour(f)));
    rect(bar0, y + 4, Math.max(1, bx(t.flat[f]) - bar0), font.h - 8, colour(f));
    y += rowH;
  }
  y += 2;
  for (let xx = M; xx < right; xx += 4) rect(xx, y, 2, 1, RULE);
  y += 6;

  // ---- call tree: as many rows as the height budget allows, heaviest first ----
  const noteH = 2 * rowH + 6;
  const budget = Math.floor((maxHeight - y - rowH - noteH - M) / rowH);
  if (budget < 4) throw new Error(`maxHeight ${maxHeight} leaves no room for the call tree`);
  const rowsAt = (tau) => { let r = 0; for (let n = 0; n < trie.size; n++) if (n === 0 || trie.total[n] >= tau) { r++; const k = trie.children[n]; if (k.length && trie.total[k.at(-1)] < tau) r++; } return r; };
  const cuts = [...new Set(trie.total)].sort((a, b) => b - a);  // candidate thresholds, descending
  let lo = 0, hi = cuts.length - 1;                              // rowsAt(cuts[i]) is non-decreasing in i
  while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (rowsAt(cuts[mid]) <= budget) lo = mid; else hi = mid - 1; }
  const tau = cuts[lo], complete = lo === cuts.length - 1;
  const hot = new Set([0]);
  for (let n = 0; trie.children[n].length;) { n = trie.children[n][0]; hot.add(n); }
  text(M, y, `CALL TREE${complete ? '' : `, FRAMES >= ${pct(tau, total)} OF TOTAL`} (bar = the frame's position and width in the flame graph: bright = self, dim = callees)`, DIM);
  y += rowH;
  const open = [];                                             // open[d]: the ancestor at depth d has more rows below
  const lines = (d, last) => {
    for (let k = 1; k < d; k++) if (open[k]) rect(M + (k - 1) * cw + 4, y, 1, rowH, RULE);
    if (d) { const lx = M + (d - 1) * cw + 4; rect(lx, y, 1, last ? 9 : rowH, RULE); rect(lx, y + 9, 4, 1, RULE); }
  };
  const stack = [[0, 0, 0, true]];
  let shown = 0;
  while (stack.length) {
    const [n, v0, d, last, foldedCount] = stack.pop();
    lines(d, last); open[d] = !last;
    const nx = M + d * cw, room = NAME - d;
    if (foldedCount) {                                         // synthetic "+N smaller" row: v0 = offset, n = value
      text(nx, y, clip(`+${foldedCount} smaller`, room), DIM);
      textR(cCum, y, fmt(n), DIM); textR(cCumP, y, pct(n, total), DIM);
      rect(bx(v0), y + 4, Math.max(1, bx(v0 + n) - bx(v0)), font.h - 8, dim(OTHER, 0.55));
      y += rowH; continue;
    }
    shown++;
    const f = trie.fn[n], mark = trie.rep[n] > 1 ? ` ×${trie.rep[n]}` : '';
    const xe = text(nx, y, n === 0 ? 'all' : fitName(names[f], room - mark.length), FG);
    text(xe, y, mark, DIM);
    numbers(y, trie.self[n], trie.total[n], hot.has(n) && n !== 0);
    const c = n === 0 ? OTHER : colour(f), xa = bx(v0), xb = bx(v0 + trie.total[n]), xs = bx(v0 + trie.total[n] - trie.self[n]);
    rect(xa, y + 4, Math.max(1, xb - xa), font.h - 8, dim(c));
    if (trie.self[n] > 0) rect(Math.min(xs, xb - 1), y + 4, Math.max(1, xb - xs), font.h - 8, c);
    if (hot.has(n) && n !== 0) rect(xa, y + 1, Math.max(1, xb - xa), 1, FG);
    y += rowH;
    const kids = trie.children[n], vis = kids.filter((k) => trie.total[k] >= tau), hidden = kids.length - vis.length;
    let cv = v0;
    const offs = vis.map((k) => { const o = cv; cv += trie.total[k]; return o; });
    if (hidden) stack.push([kids.slice(vis.length).reduce((s, k) => s + trie.total[k], 0), cv, d + 1, true, hidden]);
    for (let i = vis.length - 1; i >= 0; i--) stack.push([vis[i], offs[i], d + 1, !hidden && i === vis.length - 1]);
  }
  hline(y + 2);
  y += 8;
  const notes = ['SELF = time in the function itself', 'CUM = including callees, each function counted once per stack', 'indent = call depth, callers above callees', 'highlighted CUM% = hottest path'];
  if (trie.collapsed) notes.push('×N = recursion cycle collapsed, up to N repeats');
  let nx = M;
  notes.forEach((s, i) => { const str = s + (i < notes.length - 1 ? ' · ' : ''); if (nx + str.length * cw > right) { nx = M; y += rowH; } nx = text(nx, y, str, DIM); });
  y += rowH;
  const height = y + M;
  return { width, height, background: BG, ops, trie, valueIndex: vi, tokens: imageTokens(width, height), threshold: tau / total, rows: shown };
}
