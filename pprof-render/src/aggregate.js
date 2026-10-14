// Aggregations over a decoded profile. Node identity is the function
// (all lines/addresses of a function merge), which is pprof's default too.

/** Function indices of sample i's stack, root first, inlined frames expanded. */
export function stackOf(p, i) {
  const { locOffsets, locs } = p.samples, { lineOffsets, lineFn } = p.locations, out = [];
  for (let j = locOffsets[i + 1] - 1; j >= locOffsets[i]; j--) {
    const loc = locs[j];
    for (let k = lineOffsets[loc + 1] - 1; k >= lineOffsets[loc]; k--) out.push(lineFn[k]);
  }
  return out;
}

/**
 * Collapse exact tandem repeats in a stack: A B C B C B C D -> A B C D with
 * reps [1, 3, 3, 1]. Handles direct recursion (period 1) and mutual recursion
 * (period n). Only frames that are exact duplicates of a neighbouring block
 * are removed, so the set of functions on the stack and the leaf are
 * unchanged: flat and cumulative values per function are invariant.
 */
export function collapseCycles(frames) {
  let f = frames, reps = frames.map(() => 1), changed = true;
  const same = (a, b, n) => { for (let j = 0; j < n; j++) if (f[a + j] !== f[b + j]) return false; return true; };
  while (changed) {
    changed = false;
    const out = [], outR = [], n = f.length;
    for (let i = 0; i < n;) {
      let period = 0;
      for (let q = 1; i + 2 * q <= n; q++) if (same(i, i + q, q)) { period = q; break; }
      if (!period) { out.push(f[i]); outR.push(reps[i]); i++; continue; }
      let k = 2;
      while (i + (k + 1) * period <= n && same(i, i + k * period, period)) k++;
      for (let j = 0; j < period; j++) {
        let inner = 1;
        for (let c = 0; c < k; c++) inner = Math.max(inner, reps[i + c * period + j]);
        out.push(f[i + j]); outR.push(inner * k);
      }
      i += k * period; changed = true;
    }
    f = out; reps = outR;
  }
  return { frames: f, reps };
}

/**
 * Call trie, columnar. Node 0 is the synthetic root. children[n] is sorted by
 * descending total (ties by name). rep[n] > 1 marks a frame that stood for up
 * to rep[n] repeats of a recursion cycle; height[n] is the subtree depth below n.
 */
export function buildTrie(p, valueIndex, { collapse = true } = {}) {
  const { count, nValues, values } = p.samples, nf = p.functions.count + 1;
  const fn = [-1], parent = [-1], self = [0], total = [0], rep = [1], lookup = new Map();
  for (let i = 0; i < count; i++) {
    const v = values[i * nValues + valueIndex];
    if (v === 0) continue;
    let frames = stackOf(p, i), reps = null;
    if (collapse) ({ frames, reps } = collapseCycles(frames));
    let node = 0;
    total[0] += v;
    for (let d = 0; d < frames.length; d++) {
      const key = node * nf + frames[d] + 1;
      let c = lookup.get(key);
      if (c === undefined) { c = fn.length; lookup.set(key, c); fn.push(frames[d]); parent.push(node); self.push(0); total.push(0); rep.push(1); }
      total[c] += v; node = c;
      if (reps && reps[d] > rep[c]) rep[c] = reps[d];
    }
    self[node] += v;
  }
  const children = fn.map(() => []), height = fn.map(() => 0);
  for (let n = 1; n < fn.length; n++) children[parent[n]].push(n);
  for (let n = fn.length - 1; n > 0; n--) height[parent[n]] = Math.max(height[parent[n]], height[n] + 1);
  const name = (n) => (fn[n] < 0 ? '' : p.functions.names[fn[n]]);
  for (const c of children) c.sort((a, b) => total[b] - total[a] || (name(a) < name(b) ? -1 : 1));
  return { fn, parent, self, total, rep, height, children, size: fn.length, collapsed: collapse && rep.some((r) => r > 1) };
}

/**
 * Flat and cumulative value per function. Cumulative counts a function at
 * most once per sample, so recursion does not inflate it.
 */
export function top(p, valueIndex, { collapse = false } = {}) {
  const { count, nValues, values } = p.samples, nf = p.functions.count;
  const flat = new Float64Array(nf), cum = new Float64Array(nf), seen = new Int32Array(nf);
  let total = 0;
  for (let i = 0; i < count; i++) {
    const v = values[i * nValues + valueIndex];
    const frames = collapse ? collapseCycles(stackOf(p, i)).frames : stackOf(p, i);
    for (const f of frames) if (f >= 0 && seen[f] !== i + 1) { seen[f] = i + 1; cum[f] += v; }
    const leaf = frames.at(-1) ?? -1;
    if (leaf >= 0) flat[leaf] += v;
    total += v;
  }
  return { flat, cum, total };
}
