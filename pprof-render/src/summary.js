// Text sidecar for the same aggregation the image shows: exact numbers the
// pixels can only approximate. Meant to be sent to the model next to the PNG.
import { buildTrie, top } from './aggregate.js';
import { sampleIndex } from './profile.js';
import { byFunction, displayName, formatValue, headline, packageOf, pct } from './flame.js';

export function summary(p, { type, collapse = true, topN = 25, treeMin = 0.01 } = {}) {
  const vi = sampleIndex(p, type), st = p.sampleTypes[vi], t = top(p, vi), trie = buildTrie(p, vi, { collapse });
  const total = trie.total[0], names = byFunction(p.functions.names.map(displayName)), fmt = (v) => formatValue(v, st.unit), head = headline(p, st, total);
  const out = [`${head.what}: ${head.facts}`, '', `Top ${topN} functions by self (cum = including callees, counted once per stack):`, '    self  self%        cum   cum%  function'];
  const order = [...t.flat.keys()].sort((a, b) => t.flat[b] - t.flat[a] || t.cum[b] - t.cum[a]).slice(0, topN);
  for (const f of order) out.push(`${fmt(t.flat[f]).padStart(8)} ${pct(t.flat[f], total).padStart(6)} ${fmt(t.cum[f]).padStart(10)} ${pct(t.cum[f], total).padStart(6)}  ${names[f]}`);
  const byPkg = new Map();
  t.flat.forEach((v, f) => { if (v) { const k = packageOf(p.functions.names[f]); byPkg.set(k, (byPkg.get(k) ?? 0) + v); } });
  const pk = [...byPkg].sort((a, b) => b[1] - a[1]);
  out.push('', `Self by package: ${pk.slice(0, 10).map(([k, v]) => `${k} ${pct(v, total)}`).join(', ')}${pk.length > 10 ? `, +${pk.length - 10} more ${pct(pk.slice(10).reduce((s, [, v]) => s + v, 0), total)}` : ''}`);
  out.push('', `Call tree, frames >= ${pct(treeMin * total, total)} of total; one space of indent per call depth; "name cum% (self%)"${trie.collapsed ? '; xN = recursion cycle collapsed, up to N repeats' : ''}:`);
  const stack = [[0, 0]];
  while (stack.length) {
    const [n, d] = stack.pop();
    const self = trie.self[n] > 0 ? ` (${pct(trie.self[n], total)})` : '';
    out.push(`${' '.repeat(d)}${n === 0 ? 'all' : names[trie.fn[n]]}${trie.rep[n] > 1 ? ` x${trie.rep[n]}` : ''} ${pct(trie.total[n], total)}${self}`);
    const kids = trie.children[n].filter((c) => trie.total[c] >= treeMin * total);
    const rest = trie.children[n].length - kids.length;
    if (rest) { const v = trie.children[n].reduce((s, c) => s + (trie.total[c] < treeMin * total ? trie.total[c] : 0), 0); stack.push([-1, d + 1, rest, v]); }
    for (let i = kids.length - 1; i >= 0; i--) stack.push([kids[i], d + 1]);
    while (stack.length && stack.at(-1)[0] === -1) { const [, dd, r, v] = stack.pop(); out.push(`${' '.repeat(dd)}+${r} smaller ${pct(v, total)}`); }
  }
  return out.join('\n') + '\n';
}
