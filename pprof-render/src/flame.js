// Profile -> display list (the renderer-independent "AST"): flat rect/text ops
// in device pixels. Icicle orientation: root on top, callees below.
//
// The reader is a vision model, so the canvas is a fixed pixel budget that is
// never resampled, text is the primary channel, and anything that cannot be
// labelled is folded into an honest grey block instead of drawn as slivers.
import { FONTS } from './font.js';
import { buildTrie } from './aggregate.js';
import { sampleIndex } from './profile.js';

// Hues are the dataviz reference categorical order, tinted towards white so
// dark ink labels keep >= 7:1 contrast. Identity is also carried by the label
// text and the legend, never by hue alone.
const SURFACE = 0xfcfcfb, INK = 0x0b0b0b, INK2 = 0x52514e, OTHER = 0xdddcd6, ROOT = 0xc4c3bc;
const HUES = [0x2a78d6, 0xeb6834, 0x1baf7a, 0xeda100, 0xe87ba4, 0x008300, 0x6250d6]
  .map((c) => [16, 8, 0].reduce((o, s) => o | (Math.round(((c >> s) & 255) * 0.55 + 255 * 0.45) << s), 0));

// A location line whose function link is 0 decodes to function index -1; such
// frames are named and coloured as UNKNOWN instead of reading past the tables.
export const UNKNOWN = '(unknown)';
export const byFunction = (values) => Object.assign(values, { [-1]: UNKNOWN });

/** Canvas size checks shared by the views; widths outside this range are refused, not clamped. */
export const MIN_WIDTH = 320, MAX_WIDTH = 8192, MAX_HEIGHT = 32768;
export function checkCanvas(width, maxHeight) {
  if (typeof width !== 'number' || !Number.isInteger(width) || width < MIN_WIDTH || width > MAX_WIDTH) throw new RangeError(`width must be an integer from ${MIN_WIDTH} to ${MAX_WIDTH}, got ${String(width)}`);
  if (typeof maxHeight !== 'number' || !(maxHeight > 0 && maxHeight <= MAX_HEIGHT)) throw new RangeError(`maxHeight must be a number from 1 to ${MAX_HEIGHT}, got ${String(maxHeight)}`);
}

/** Anthropic vision cost model: one token per 28x28 patch. */
export const imageTokens = (w, h) => Math.ceil(w / 28) * Math.ceil(h / 28);

/** "encoding/json.(*Decoder).Decode" -> "encoding/json"; best effort for non-Go names. */
export function packageOf(name) {
  const cut = name.search(/[[(]/), head = cut < 0 ? name : name.slice(0, cut);
  const slash = head.lastIndexOf('/'), dot = head.indexOf('.', slash + 1);
  return dot < 0 ? head || '(unknown)' : head.slice(0, dot);
}

/** Collapse generic instantiation noise: Foo[go.shape.struct {...}] -> Foo[…]. */
export function displayName(name) {
  let out = '', depth = 0;
  for (const ch of name) {
    if (ch === '[') { if (depth++ === 0) out += '[…'; } else if (ch === ']') { if (--depth === 0) out += ']'; } else if (depth === 0) out += ch;
  }
  return out;
}

export const shortName = (name) => { const cut = name.search(/[[(]/), slash = name.lastIndexOf('/', cut < 0 ? name.length : cut); return slash < 0 ? name : name.slice(slash + 1); };

/**
 * Best label that fits: keep the trailing facts (×N, %) while possible, then drop the path, then the
 * package (only where the fill colour still identifies it), then truncate.
 */
function fitLabel(name, mark, share, chars, keepPackage = false) {
  const short = shortName(name), pkg = packageOf(short), bare = !keepPackage && short.startsWith(pkg + '.') ? short.slice(pkg.length + 1) : short;
  for (const s of [`${name}${mark} ${share}`, `${short}${mark} ${share}`, `${name}${mark}`, `${short}${mark}`, `${bare}${mark} ${share}`, `${bare}${mark}`]) if (s.length <= chars) return s;
  return chars >= 5 ? bare.slice(0, chars - 1) + '…' : '';
}

const group = (n) => String(Math.round(n)).replace(/\B(?=(\d{3})+$)/g, ',');
export function formatValue(v, unit) {
  const a = Math.abs(v);
  if (unit === 'nanoseconds') return a >= 1e9 ? `${(v / 1e9).toFixed(2)}s` : a >= 1e6 ? `${(v / 1e6).toFixed(2)}ms` : `${(v / 1e3).toFixed(2)}us`;
  if (unit === 'bytes') return a >= 2 ** 30 ? `${(v / 2 ** 30).toFixed(2)}GB` : a >= 2 ** 20 ? `${(v / 2 ** 20).toFixed(2)}MB` : a >= 1024 ? `${(v / 1024).toFixed(2)}kB` : `${v}B`;
  return unit === 'count' ? group(v) : `${group(v)} ${unit}`;
}
export const pct = (v, total) => { const x = (100 * v) / total; return x >= 9.95 ? `${x.toFixed(0)}%` : x >= 0.05 ? `${x.toFixed(1)}%` : '<0.1%'; };

export function headline(p, st, total) {
  const facts = [`${formatValue(total, st.unit)} total`, `${group(p.samples.count)} samples`];
  if (p.durationNanos > 0) facts.push(`${formatValue(p.durationNanos, 'nanoseconds')} wall`);
  if (p.period > 0 && p.periodType) facts.push(`period ${formatValue(p.period, p.periodType.unit)}`);
  return { what: [p.mappings[0]?.filename.split('/').pop(), st.type].filter(Boolean).join('  '), facts: facts.join(' · ') };
}

export function flameGraph(p, { type, width = 2000, maxHeight = 1400, fontSize = 15, collapse = true, minChars = 3 } = {}) {
  checkCanvas(width, maxHeight);
  const font = FONTS[fontSize];
  if (!font) throw new Error(`no baked font at ${fontSize}px (have ${Object.keys(FONTS).join(', ')})`);
  const vi = sampleIndex(p, type), st = p.sampleTypes[vi], trie = buildTrie(p, vi, { collapse }), total = trie.total[0];
  if (!(total > 0)) throw new Error(`profile has no positive ${st.type} samples`);
  const names = byFunction(p.functions.names.map(displayName)), pkgs = byFunction(p.functions.names.map(packageOf));

  // Colour = package. The 7 heaviest by self value get a hue; the rest fold into "other".
  const selfByPkg = new Map();
  for (let n = 1; n < trie.size; n++) if (trie.self[n]) selfByPkg.set(pkgs[trie.fn[n]], (selfByPkg.get(pkgs[trie.fn[n]]) ?? 0) + trie.self[n]);
  const ranked = [...selfByPkg].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1));
  const hueOf = new Map(ranked.slice(0, HUES.length).map(([k], i) => [k, HUES[i]]));
  const otherSelf = ranked.slice(HUES.length).reduce((s, [, v]) => s + v, 0);

  const ops = [], M = 12, pad = 4, rowH = font.h + 6, lineH = font.h + 4, plotW = width - 2 * M;
  const text = (x, y, s, rgb = INK) => { ops.push({ op: 'text', x, y, text: s, size: fontSize, rgb }); return x + s.length * font.w; };
  const rect = (x, y, w, h, rgb) => ops.push({ op: 'rect', x, y, w, h, rgb });

  // Header: what, how much, how to read it, colour key. The image is self-describing.
  let y = M;
  const head = headline(p, st, total);
  text(text(M, y, head.what) + 2 * font.w, y, head.facts, INK2);
  y += lineH;
  const how = ['callers above, callees below', 'width and % = share of total including callees'];
  if (trie.collapsed) how.push('×N = recursion cycle collapsed, up to N repeats');
  how.push('grey +N = N narrower frames folded');
  text(M, y, how.join(' · '), INK2);
  y += lineH + 4;
  let x = text(M, y, 'self, by package', INK2) + 2 * font.w;
  const sw = font.h - 6;
  for (const [label, fill, v] of [...ranked.slice(0, HUES.length).map(([k, v]) => [k, hueOf.get(k), v]), ...(otherSelf > 0 ? [['other', OTHER, otherSelf]] : [])]) {
    const s = `${label} ${pct(v, total)}`, w = sw + 6 + (s.length + 3) * font.w;
    if (x + w > width - M && x > M) { x = M; y += lineH; }
    rect(x, y + 3, sw, sw, fill);
    text(x + sw + 6, y, s, INK2);
    x += w;
  }
  y += lineH + 8;

  // Frames. x positions are computed in value space and rounded once, so
  // siblings tile exactly and children never overhang their parent.
  const top = y, scale = plotW / total, minW = minChars * font.w + 2 * pad;
  const px = (v) => M + Math.round(v * scale);
  const rows = Math.floor((maxHeight - top - M) / rowH);
  if (rows < 3) throw new Error(`maxHeight ${maxHeight} leaves no room for frames`);
  const walk = (lastRow, emit) => {
    let deepest = 0;
    const stack = [[0, 0, 0]];
    while (stack.length) {
      const [node, v0, depth] = stack.pop();
      if (depth > deepest) deepest = depth;
      emit?.('frame', node, v0, trie.total[node], depth);
      const kids = trie.children[node];
      if (!kids.length) continue;
      if (depth >= lastRow) { emit?.('deeper', node, v0, trie.total[node] - trie.self[node], depth + 1); deepest = depth + 1; continue; }
      let cv = v0, folded = 0, foldedV = 0;
      for (const c of kids) {
        if (px(cv + trie.total[c]) - px(cv) >= minW) { stack.push([c, cv, depth + 1]); cv += trie.total[c]; } else { folded++; foldedV += trie.total[c]; }
      }
      if (folded) { emit?.('folded', folded, cv, foldedV, depth + 1); if (px(cv + foldedV) > px(cv)) deepest = Math.max(deepest, depth + 1); }
    }
    return deepest;
  };
  // If the whole (folded) tree fits, draw it all; otherwise keep the last row for "deeper" markers.
  const lastRow = walk(Infinity) < rows ? Infinity : rows - 2;
  const frames = [];
  const deepest = walk(lastRow, (kind, a, v0, v, depth) => {
    const xa = px(v0), xb = px(v0 + v), w = xb - xa, fy = top + depth * rowH, chars = Math.floor((w - 2 * pad) / font.w);
    if (w < 1) return;
    let fill = OTHER, label = '';
    if (kind === 'frame') {
      const f = trie.fn[a];
      fill = a === 0 ? ROOT : hueOf.get(pkgs[f]) ?? OTHER;
      label = a === 0 ? fitLabel('all', '', formatValue(total, st.unit), chars) : fitLabel(names[f], trie.rep[a] > 1 ? ` ×${trie.rep[a]}` : '', pct(v, total), chars, !hueOf.has(pkgs[f]));
      frames.push({ node: a, x: xa, y: fy, w, h: rowH - 1 });
    } else if (kind === 'folded') {
      label = [`+${a} ${pct(v, total)}`, `+${a}`].find((s) => s.length <= chars) ?? '';
    } else {
      const d = trie.height[a];
      label = [`… ${d} more level${d === 1 ? '' : 's'} ${pct(v, total)}`, `… +${d}`, '…'].find((s) => s.length <= chars) ?? '';
    }
    rect(xa, fy, w > 2 ? w - 1 : w, rowH - 1, fill);
    if (label) text(xa + pad, fy + 2, label, kind === 'frame' ? INK : INK2);
  });
  const height = top + (deepest + 1) * rowH + M;
  // frames: hit-test table (node index -> pixel box) for callers that want tooltips or image maps.
  return { width, height, background: SURFACE, ops, frames, trie, valueIndex: vi, tokens: imageTokens(width, height) };
}
