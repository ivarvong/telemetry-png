// otel-png-deflate.mjs — a zlib encoder specialised for indexed-PNG scanlines.
// Synchronous and streaming: write(band) returns that band's compressed bytes.
//
// The data is sparse (mostly palette index 0) with strong row-to-row repetition, so:
//   - zero runs are found a 32-bit word at a time and coded as distance-1 matches
//   - elsewhere it takes the longest of "same as the row above", "same as the byte
//     to the left", and one hash-table candidate
//   - Adler-32 is computed in closed form over runs
//   - each band is one dynamic-Huffman block
// The hot loops are small functions called once per scanline (or per few thousand
// tokens) rather than one long loop, so the JIT optimises them within the first band.

const LBASE = [3,4,5,6,7,8,9,10,11,13,15,17,19,23,27,31,35,43,51,59,67,83,99,115,131,163,195,227,258];
const LEXTRA = [0,0,0,0,0,0,0,0,1,1,1,1,2,2,2,2,3,3,3,3,4,4,4,4,5,5,5,5,0];
const LSYM = new Uint16Array(259), LXN = new Uint8Array(259), LXV = new Uint8Array(259);
for (let len = 3; len <= 258; len++) {
  let k = 28;
  while (LBASE[k] > len) k--;
  LSYM[len] = 257 + k; LXN[len] = LEXTRA[k]; LXV[len] = len - LBASE[k];
}
const DSYM = new Uint8Array(32769), DBASE = new Uint16Array(30), DXN = new Uint8Array(30);
for (let c = 0, base = 1; c < 30; c++) {
  const xn = c < 4 ? 0 : (c >> 1) - 1;
  DBASE[c] = base; DXN[c] = xn;
  for (let d = base; d < base + (1 << xn) && d <= 32768; d++) DSYM[d] = c;
  base += 1 << xn;
}
const CL_ORDER = [16,17,18,0,8,7,9,6,10,5,11,4,12,3,13,2,14,1,15];
const MIN_FAR = 4; // a far match pays for distance bits, so three bytes is not worth it
const MOD = 65521;

// Huffman code lengths, capped at maxBits by flattening the weights until they fit.
function codeLengths(freq, maxBits) {
  const lens = new Uint8Array(freq.length);
  let f = Array.from(freq);
  for (;;) {
    const leaves = [];
    for (let i = 0; i < f.length; i++) if (f[i] > 0) leaves.push({ w: f[i], s: i, a: null, b: null });
    if (leaves.length === 1) { lens[leaves[0].s] = 1; return lens; }
    leaves.sort((p, q) => p.w - q.w);
    const inner = [];
    let i = 0, j = 0;
    const take = () => (j >= inner.length || (i < leaves.length && leaves[i].w <= inner[j].w) ? leaves[i++] : inner[j++]);
    while (leaves.length - i + inner.length - j > 1) { const a = take(), b = take(); inner.push({ w: a.w + b.w, s: -1, a, b }); }
    let max = 0;
    const stack = [[inner[inner.length - 1], 0]];
    while (stack.length) {
      const [nd, d] = stack.pop();
      if (nd.s >= 0) { lens[nd.s] = d; if (d > max) max = d; } else stack.push([nd.a, d + 1], [nd.b, d + 1]);
    }
    if (max <= maxBits) return lens;
    f = f.map((x) => (x > 0 ? (x >> 1) || 1 : 0));
    lens.fill(0);
  }
}

// Canonical codes, bit-reversed for LSB-first output.
function canonical(lens) {
  const count = new Uint16Array(16), next = new Uint16Array(16), codes = new Uint16Array(lens.length);
  for (const l of lens) count[l]++;
  count[0] = 0;
  for (let b = 1, c = 0; b < 16; b++) { c = (c + count[b - 1]) << 1; next[b] = c; }
  for (let s = 0; s < lens.length; s++) {
    const l = lens[s];
    if (!l) continue;
    let c = next[l]++, r = 0;
    for (let k = 0; k < l; k++) { r = (r << 1) | (c & 1); c >>= 1; }
    codes[s] = r;
  }
  return codes;
}

// Token: tl = 0 means literal td; otherwise a match of length tl at distance td + 1.
function match(st, len, dist) {
  while (len > 0) {
    const m = len > 258 ? (len - 258 < 3 ? 255 : 258) : len;
    st.tl[st.t] = m; st.td[st.t++] = dist - 1;
    st.ll[LSYM[m]]++; st.dd[DSYM[dist]]++;
    len -= m;
  }
}

// Tokenise one scanline, buf[r..end). `up` holds the row above at up[i + upOff], or is null.
function scanline(st, buf, u32, r, end, up, upOff, stride) {
  const { tl, td, ll, head } = st;
  let s1 = st.s1, s2 = st.s2, pend = 0;
  let i = r;
  while (i < end) {
    const v = buf[i];
    if (v === 0) { // zero run: scan by words, checksum in closed form
      let j = i + 1;
      while (j < end && (j & 3) !== 0 && buf[j] === 0) j++;
      if (u32 !== null && (j & 3) === 0) while (j + 4 <= end && u32[j >> 2] === 0) j += 4;
      while (j < end && buf[j] === 0) j++;
      let len = j - i;
      s1 %= MOD; s2 = (s2 % MOD + s1 * len) % MOD; pend = 0;
      if (i === 0 || buf[i - 1] !== 0) { tl[st.t] = 0; td[st.t++] = 0; ll[0]++; len--; } // distance 1 needs a zero before it
      if (len >= 3) match(st, len, 1);
      else for (; len > 0; len--) { tl[st.t] = 0; td[st.t++] = 0; ll[0]++; }
      i = j;
      continue;
    }
    let len = 0, dist = 0;
    if (up !== null) { // row above; stop at a stretch of zeros so those take the fast path
      let j = i;
      while (j < end && buf[j] === up[j + upOff] && (buf[j] !== 0 || buf[j + 1] !== 0 || buf[j + 2] !== 0 || buf[j + 3] !== 0)) j++;
      if (j - i >= MIN_FAR) { len = j - i; dist = stride; }
    }
    if (i > r) { // run of the byte to the left
      const w = buf[i - 1];
      let j = i;
      while (j < end && buf[j] === w) j++;
      if (j - i >= 3 && j - i >= len) { len = j - i; dist = 1; }
    }
    if (i + 2 < end) { // most recent place these three bytes appeared
      const h = ((v * 2654435761) ^ (buf[i + 1] * 40503) ^ (buf[i + 2] << 7)) & 32767, c = head[h];
      head[h] = i;
      if (len < 8 && c >= 0 && i - c <= 32768) {
        let j = i, k = c;
        const lim = Math.min(end, i + 258);
        while (j < lim && buf[j] === buf[k]) { j++; k++; }
        if (j - i > len && j - i >= MIN_FAR) { len = j - i; dist = i - c; }
      }
    }
    if (len >= 3) {
      if (dist === 1) { s1 %= MOD; s2 = (s2 % MOD + s1 * len + v * (len * (len + 1) / 2)) % MOD; s1 += v * len; pend = 0; } // one repeated value
      else { for (let k = i; k < i + len; k++) { s1 += buf[k]; s2 += s1; } pend += len; }
      match(st, len, dist);
      i += len;
    } else {
      s1 += v; s2 += s1; pend++;
      tl[st.t] = 0; td[st.t++] = v; ll[v]++;
      i++;
    }
    if (pend > 4000) { s1 %= MOD; s2 %= MOD; pend = 0; }
  }
  st.s1 = s1 % MOD; st.s2 = s2 % MOD;
}

// Write tokens [from, to) through the bit writer held in `st`.
function emit(st, from, to, llCode, llLen, dCode, dLen) {
  const { tl, td, out } = st;
  let acc = st.acc, nb = st.nb, o = st.o;
  for (let k = from; k < to; k++) {
    const m = tl[k];
    if (m === 0) { const v = td[k]; acc |= llCode[v] << nb; nb += llLen[v]; }
    else {
      const sym = LSYM[m], d = td[k] + 1, ds = DSYM[d];
      acc |= llCode[sym] << nb; nb += llLen[sym];
      while (nb >= 8) { out[o++] = acc & 255; acc >>>= 8; nb -= 8; }
      if (LXN[m]) { acc |= LXV[m] << nb; nb += LXN[m]; }
      acc |= dCode[ds] << nb; nb += dLen[ds];
      while (nb >= 8) { out[o++] = acc & 255; acc >>>= 8; nb -= 8; }
      if (DXN[ds]) { acc |= (d - DBASE[ds]) << nb; nb += DXN[ds]; }
    }
    while (nb >= 8) { out[o++] = acc & 255; acc >>>= 8; nb -= 8; }
  }
  st.acc = acc; st.nb = nb; st.o = o;
}

function put(st, v, n) {
  st.acc |= v << st.nb; st.nb += n;
  while (st.nb >= 8) { st.out[st.o++] = st.acc & 255; st.acc >>>= 8; st.nb -= 8; }
}

export function makeDeflater(stride) {
  const canUp = stride <= 32768; // the row above must be inside deflate's window
  const above = new Uint8Array(stride);
  let haveAbove = false, started = false;
  const st = {
    tl: new Uint16Array(8 * stride), td: new Uint16Array(8 * stride), t: 0,
    ll: null, dd: null, head: new Int32Array(1 << 15),
    s1: 1, s2: 0, acc: 0, nb: 0, out: new Uint8Array(0), o: 0,
  };

  return {
    write(buf) {
      const n = buf.length;
      const u32 = (buf.byteOffset & 3) === 0 ? new Uint32Array(buf.buffer, buf.byteOffset, n >> 2) : null;
      st.ll = new Uint32Array(286); st.dd = new Uint32Array(30); st.t = 0; st.o = 0;
      st.head.fill(-1);

      for (let r = 0; r < n; r += stride) {
        if (st.t + stride > st.tl.length) { // a scanline adds at most one token per byte
          const grow = (old) => { const a = new Uint16Array(old.length * 2 + stride); a.set(old); return a; };
          st.tl = grow(st.tl); st.td = grow(st.td);
        }
        const up = !canUp ? null : r > 0 ? buf : haveAbove ? above : null;
        scanline(st, buf, u32, r, r + stride, up, r > 0 ? -stride : -r, stride);
      }
      above.set(buf.subarray(n - stride));
      haveAbove = true;

      const t = st.t;
      if (st.out.length < t * 6 + 2048) st.out = new Uint8Array(t * 6 + 2048); // a token is at most 48 bits
      if (!started) { st.out[st.o++] = 0x78; st.out[st.o++] = 0x01; started = true; } // zlib header

      // Block header: dynamic Huffman, code lengths sent plainly (no run-length symbols).
      const { ll, dd } = st;
      ll[256]++; ll[0]++; dd[0]++; dd[1]++; // end-of-block, and keep both trees complete
      const llLen = codeLengths(ll, 15), dLen = codeLengths(dd, 15);
      const all = [...llLen, ...dLen], cf = new Uint32Array(19);
      for (const l of all) cf[l]++;
      const clLen = codeLengths(cf, 7), clCode = canonical(clLen);
      put(st, 4, 3); put(st, 29, 5); put(st, 29, 5); put(st, 15, 4); // BFINAL=0, BTYPE=10, HLIT=286, HDIST=30, HCLEN=19
      for (const s of CL_ORDER) put(st, clLen[s], 3);
      for (const l of all) put(st, clCode[l], clLen[l]);

      const llCode = canonical(llLen), dCode = canonical(dLen);
      for (let k = 0; k < t; k += 2048) emit(st, k, Math.min(t, k + 2048), llCode, llLen, dCode, dLen);
      put(st, llCode[256], llLen[256]);
      return st.out.slice(0, st.o);
    },

    end() {
      if (st.out.length < 16) st.out = new Uint8Array(16);
      st.o = 0;
      put(st, 3, 3); put(st, 0, 7); // a final fixed block holding only end-of-block
      if (st.nb) put(st, 0, 8 - st.nb);
      const { s1, s2, out } = st;
      out[st.o++] = s2 >>> 8; out[st.o++] = s2 & 255; out[st.o++] = s1 >>> 8; out[st.o++] = s1 & 255;
      return out.slice(0, st.o);
    },
  };
}
