// otel-png-layout.mjs — trace model -> pages of draw operations. Knows nothing about
// OTLP and nothing about bytes: it only places text runs and rectangles, in logical
// pixels, using the font cell size and ink names from the raster module.
//
//   layoutTrace(trace, { width, maxHeight, detail }) ->
//     { width, maxBand, pages: [{ height, from, to, bands() }] }
//
// A page is at most maxHeight tall (Infinity for one tall image). bands() lazily
// yields { name, y, h, ops() } top to bottom; ops() builds that band's operations on
// demand, so only one band of them exists at a time. Geometry contract (tested): every text run lies inside the page, and no two
// text runs on the same line overlap.

import { CELL, INK } from './otel-png-raster.mjs';
import { formatDuration as dur } from './otel-png-model.mjs';

const CW = CELL.w; // 8
const M = 20; // page margin
const ROW = 18; // span line
const DETAIL = 16; // attribute line
const INDENT = 9;
const GAP = 10;
const SVC_CHARS = 16;
const NUM = 10 * CW; // numeric column width
const HEAD_FULL = 162;
const HEAD_COMPACT = 56;
const FOOT = 23;
const BAND = 128; // target band height

const { BG, FG, MUTED, FAINT, ERR } = INK;
const len = (s) => [...s].length;
const fit = (s, max) => {
  if (max <= 0) return '';
  const cps = [...s];
  return cps.length <= max ? s : max === 1 ? '…' : cps.slice(0, max - 1).join('') + '…';
};
// Names keep both ends: the head says what it is, the tail usually says which one.
const fitMiddle = (s, max) => {
  const cps = [...s];
  if (cps.length <= max) return s;
  if (max < 8) return fit(s, max);
  const tail = Math.floor((max - 1) * 0.4);
  return cps.slice(0, max - 1 - tail).join('') + '…' + cps.slice(cps.length - tail).join('');
};
const pct = (x) => `${(x * 100).toFixed(1)}%`;
const label = (r) => (r.count > 1 ? `${r.count}× ${r.name}` : r.name);

// Tick spacing on a 1-2-5 progression, labelled in one unit chosen from the total.
function ticks(total) {
  const raw = total / 6;
  const p = 10 ** Math.floor(Math.log10(raw));
  const m = raw / p;
  const step = (m <= 1 ? 1 : m <= 2 ? 2 : m <= 5 ? 5 : 10) * p;
  const [div, unit] = total >= 1e9 ? [1e9, 's'] : total >= 1e6 ? [1e6, 'ms'] : total >= 1e3 ? [1e3, 'µs'] : [1, 'ns'];
  const decimals = Math.min(3, Math.max(0, -Math.floor(Math.log10(step / div))));
  const out = [];
  for (let t = 0; t <= total; t += step) out.push({ t, label: t === 0 ? '0' : `${(t / div).toFixed(decimals)} ${unit}` });
  return out;
}

export function layoutTrace(trace, { width = 1280, maxHeight = 960, detail = true } = {}) {
  const W = Math.max(720, Math.round(width));
  const inner = W - 2 * M, right = W - M;
  // With a single service the SERVICE column would say the same thing on every row,
  // so it is dropped and its width goes to span names.
  const oneService = trace.services.length === 1;
  const nameW = Math.min((oneService ? 60 : 40) * CW, Math.max(18 * CW, Math.round(inner * (oneService ? 0.4 : 0.27))));
  const xSvc = M + nameW + GAP;
  const xDurR = (oneService ? M + nameW : xSvc + GAP + SVC_CHARS * CW) + GAP + NUM; // right edges: numbers are right-aligned
  const xSelfR = xDurR + GAP + NUM;
  const xPathR = xSelfR + GAP + NUM;
  const plotX = xPathR + 15;
  const plotW = right - plotX;
  const xOf = (t) => plotX + Math.round((t / trace.total) * plotW);
  const grid = ticks(trace.total);
  const slot = new Map(trace.legend.map((e, i) => [e.key, i]));
  const inks = (key) => {
    const i = slot.get(key);
    return i !== undefined && i < INK.SERIES.length ? [INK.SERIES[i], INK.SERIES_DIM[i]] : [INK.OTHER, INK.OTHER_DIM];
  };

  const T = (ops, x, y, str, ink = FG, paper = BG, bold = false) => { if (str) ops.push({ op: 'text', x, y, str, ink, paper, bold }); };
  const TR = (ops, xr, y, str, ink = FG, paper = BG) => T(ops, xr - len(str) * CW, y, str, ink, paper);
  const R = (ops, x, y, w, h, ink) => ops.push({ op: 'rect', x, y, w, h, ink });

  // ----- one span line: name, service, numbers, bars. Shared by the ranking and the tree. -----
  function spanLine(ops, r, y, nameX, name) {
    for (const g of grid) if (g.t > 0) ops.push({ op: 'dotsV', x: xOf(g.t), y, h: ROW, ink: FAINT });
    T(ops, nameX, y, fitMiddle(name, Math.floor((M + nameW - nameX) / CW)), r.gap ? MUTED : FG);

    const [solid, dim] = r.gap ? [FAINT, FAINT] : inks(r.key);
    if (!r.gap) {
      if (!oneService) {
        R(ops, xSvc, y + 6, 6, 6, solid);
        T(ops, xSvc + GAP, y, fit(r.service, SVC_CHARS));
      }
      TR(ops, xDurR, y, dur(r.dur));
      TR(ops, xSelfR, y, dur(r.self), r.self > 0 ? FG : MUTED);
    }
    // Time on the critical path. The largest is the first thing to optimise, so it is inverted.
    if (r.critSelf > 0) {
      const v = dur(r.critSelf);
      if (r === trace.hot && trace.rows.length > 1) {
        R(ops, xPathR - len(v) * CW - 3, y, len(v) * CW + 6, 17, FG);
        TR(ops, xPathR, y, v, BG, FG);
      } else TR(ops, xPathR, y, v);
    }

    // Bars: solid where the span itself was working, dim where it waited on children.
    for (const [a, b] of r.gap ? r.crit : r.bars) R(ops, xOf(a), y + 4, Math.max(1, xOf(b) - xOf(a)), 9, r.leaf ? solid : dim);
    if (!r.leaf) for (const [a, b] of r.segs) if (xOf(b) > xOf(a)) R(ops, xOf(a), y + 4, xOf(b) - xOf(a), 9, solid);
    // The white line marks exactly when this span was the critical path.
    for (const [a, b] of r.crit) R(ops, xOf(a), y + 1, Math.max(1, xOf(b) - xOf(a)), 2, FG);
    for (const e of r.events) R(ops, xOf(e.t), y + 2, 1, 13, FG);

    // Errors: red underline and an ERR tag beside the bar. The message is on the detail line.
    if (r.error) {
      const x0 = xOf(r.off), x1 = Math.max(x0 + 1, xOf(r.end));
      R(ops, x0, y + 14, x1 - x0, 2, ERR);
      const tagW = 3 * CW + 6;
      const tx = x1 + 5 + tagW <= right ? x1 + 5 : x0 - 5 - tagW;
      if (tx >= plotX) {
        R(ops, tx - 2, y, tagW + 4, ROW, BG); // clear gridlines under the tag
        R(ops, tx, y + 2, tagW, 13, ERR);
        T(ops, tx + 3, y, 'ERR', BG, ERR);
      }
    }
  }

  // ----- a tree row: guides, span line, then attributes on a second line -----
  const nameX = (r) => M + Math.min(r.depth, 16) * INDENT;
  const truncated = (r) => len(label(r)) > Math.floor((M + nameW - nameX(r)) / CW);
  const hasDetail = (r) => detail && (r.error || r.attrs.length > 0 || r.events.length > 0 || truncated(r));
  const rowH = (r) => ROW + (hasDetail(r) ? DETAIL : 0);

  function treeRow(ops, r, y) {
    const d = Math.min(r.depth, 16), h = rowH(r);
    const col = (k) => M + k * INDENT + 3;
    for (let k = 1; k < d; k++) if (r.guides & (1 << k)) R(ops, col(k - 1), y, 1, h, FAINT);
    if (d > 0) {
      R(ops, col(d - 1), y, 1, r.last ? ROW / 2 : h, FAINT);
      R(ops, col(d - 1), y + ROW / 2, INDENT - 4, 1, FAINT);
    }
    spanLine(ops, r, y, nameX(r), label(r));
    if (!hasDetail(r)) return;

    // The error message, a truncated name spelled out, then attributes and events, as key=value.
    if (!r.leaf && d < 16) R(ops, col(d), y + ROW, 1, h - ROW, FAINT);
    const pairs = [
      ...(r.error ? [['error', fit(r.message || 'true', 80)]] : []),
      ...(truncated(r) ? [['name', fit(r.name, 120)]] : []),
      ...r.attrs.map(([k, v]) => [k, fit(v, 60)]),
      ...r.events.map((e) => [`event:${e.name}`, `+${dur(e.t - r.off)}`]),
    ];
    let x = nameX(r) + INDENT;
    for (let k = 0; k < pairs.length; k++) {
      const [key, value] = pairs[k];
      const rest = pairs.length - k - 1;
      const reserve = rest ? (len(`+${rest} more`) + 2) * CW : 0;
      const room = Math.floor((right - reserve - x) / CW) - len(key) - 1;
      if (room < Math.min(len(value), 8)) { T(ops, x, y + ROW - 1, `+${rest + 1} more`, MUTED); break; }
      const v = fit(value, room);
      T(ops, x, y + ROW - 1, `${key}=`, MUTED);
      T(ops, x + (len(key) + 1) * CW, y + ROW - 1, v, FG, BG);
      x += (len(key) + 1 + len(v) + 2) * CW;
    }
  }

  // ----- headers -----
  function columnHeads(ops, y) {
    T(ops, M, y, 'SPAN', MUTED);
    if (!oneService) T(ops, xSvc + GAP, y, 'SERVICE', MUTED);
    TR(ops, xDurR, y, 'DURATION', MUTED);
    TR(ops, xSelfR, y, 'SELF', MUTED);
    TR(ops, xPathR, y, 'ON PATH', MUTED);
    let free = plotX; // a tick is labelled only if the label clears the previous one and the page edge
    for (const g of grid) {
      const x = xOf(g.t), x1 = x + 4 + len(g.label) * CW;
      R(ops, x, y + 14, 1, 5, FG);
      if (x + 4 >= free && x1 <= right) { T(ops, x + 4, y, g.label, MUTED); free = x1 + CW; }
    }
    R(ops, M, y + 19, inner, 1, FG);
  }

  function title(ops, note) {
    const name = label(trace.rows[0]);
    T(ops, M, 10, fitMiddle(name, Math.floor((inner - (len(note) + 3) * CW) / CW)), FG, BG, true);
    TR(ops, right, 10, note, MUTED);
  }

  function fullHeader(ops, note) {
    title(ops, note);

    // Stat strip: one ruled row of label-over-value cells.
    const SY = 36, SH = 40, cellW = 12 * CW;
    const stats = [
      ['DURATION', dur(trace.total)], ['SPANS', String(trace.spanCount)], ['SERVICES', String(trace.services.length)],
      ['DEPTH', String(trace.maxDepth)], ['ERRORS', String(trace.errors)],
      ...(trace.invalid ? [['INVALID', String(trace.invalid)]] : []),
    ];
    R(ops, M, SY, inner, 1, FG); R(ops, M, SY + SH - 1, inner, 1, FG);
    R(ops, M, SY, 1, SH, FG); R(ops, right - 1, SY, 1, SH, FG);
    stats.forEach(([name, value], i) => {
      const x = M + i * cellW;
      R(ops, x + cellW, SY, 1, SH, FG);
      T(ops, x + 7, SY + 2, name, MUTED);
      if ((name === 'ERRORS' || name === 'INVALID') && value !== '0') {
        R(ops, x + 5, SY + 20, len(value) * CW + 4, 17, ERR);
        T(ops, x + 7, SY + 20, value, BG, ERR);
      } else T(ops, x + 7, SY + 20, value);
    });
    const tx = M + stats.length * cellW + 7;
    T(ops, tx, SY + 2, 'TRACE ID', MUTED);
    T(ops, tx, SY + 20, fit(trace.traceId || 'unknown', Math.floor((right - 7 - tx) / CW)));

    // Self time by colour key: one stacked bar, then the legend that names each segment.
    T(ops, M, 84, `SELF TIME BY ${trace.colorBy.toUpperCase()}`, MUTED);
    let x = M, acc = 0;
    for (const e of trace.legend) {
      acc += e.self;
      const end = M + Math.round((acc / trace.totalSelf) * inner);
      if (end - x > 1) R(ops, x, 104, end - x - 1, 10, inks(e.key)[0]);
      x = end;
    }
    x = M;
    for (let i = 0; i < trace.legend.length; i++) {
      const e = trace.legend[i];
      const entry = `${fit(e.key, 28)} ${dur(e.self)} ${pct(e.self / trace.totalSelf)}`;
      const rest = trace.legend.length - i;
      if (x + GAP + (len(entry) + 2) * CW > right - (rest > 1 ? 10 * CW : 0)) { T(ops, x, 118, `+${rest} more`, MUTED); break; }
      R(ops, x, 124, 6, 6, inks(e.key)[0]);
      T(ops, x + GAP, 118, entry);
      x += GAP + (len(entry) + 3) * CW;
    }

    columnHeads(ops, HEAD_FULL - 22);

    // Ranking: the spans whose own time the wall time is made of, as ordinary span
    // lines under the same column heads, each prefixed with its share of the trace.
    // A name that occurs more than once is followed by '< parent', so the line stands alone.
    trace.top.forEach((r, i) => {
      const y = HEAD_FULL + i * ROW;
      const share = pct(r.critSelf / trace.total).padStart(6);
      T(ops, M, y, share, MUTED);
      spanLine(ops, r, y, M + 7 * CW, names.get(r.name) > 1 && r.parentName ? `${label(r)} < ${r.parentName}` : label(r));
    });
    if (trace.top.length) ops.push({ op: 'dotsH', x: M, y: HEAD_FULL + trace.top.length * ROW + 3, w: inner, ink: MUTED });
  }
  const names = new Map();
  for (const r of trace.rows) names.set(r.name, (names.get(r.name) ?? 0) + 1);
  const fullH = HEAD_FULL + (trace.top.length ? trace.top.length * ROW + 7 : 0);

  // ----- pagination -----
  const started = new Date(trace.startMs).toISOString();
  const when = `${started.slice(0, 10)} ${started.slice(11, 23)} UTC`;
  const rows = trace.rows;
  const spans = [];
  for (let i = 0; i < rows.length;) {
    const head = spans.length === 0 ? fullH : HEAD_COMPACT;
    let y = head;
    const from = i;
    while (i < rows.length && (i === from || y + rowH(rows[i]) + FOOT <= maxHeight)) y += rowH(rows[i++]);
    spans.push({ from, to: i, head, height: y + FOOT });
  }

  const pages = spans.map(({ from, to, head, height }, p) => ({
    height, from, to,
    *bands() {
      const where = spans.length > 1 ? `page ${p + 1}/${spans.length} · rows ${from + 1}-${to} of ${rows.length} · ` : '';
      yield {
        name: 'header', y: 0, h: head,
        ops() {
          const ops = [];
          if (p === 0) fullHeader(ops, where + when);
          else { title(ops, where + when); columnHeads(ops, HEAD_COMPACT - 22); }
          return ops;
        },
      };
      let y = head;
      for (let i = from; i < to;) {
        const first = i;
        let h = 0;
        while (i < to && (i === first || h + rowH(rows[i]) <= BAND)) h += rowH(rows[i++]);
        const last = i;
        yield {
          name: `rows ${first}-${last - 1}`, y, h,
          ops() {
            const ops = [];
            for (let k = first, ry = 0; k < last; ry += rowH(rows[k++])) treeRow(ops, rows[k], ry);
            return ops;
          },
        };
        y += h;
      }
      yield { name: 'footer', y, h: FOOT, ops: () => [{ op: 'rect', x: M, y: 2, w: inner, h: 1, ink: FG }] };
    },
  }));

  const tallestRow = rows.reduce((h, r) => Math.max(h, rowH(r)), 0);
  return { width: W, maxBand: Math.max(fullH, BAND, tallestRow), pages };
}
