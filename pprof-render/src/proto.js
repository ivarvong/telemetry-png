// Minimal protobuf wire reader. Varints are decoded into two uint32 halves so
// no precision is lost; callers choose how to materialise them.
const TWO32 = 4294967296;

export class Reader {
  constructor(buf, pos = 0, end = buf.length) {
    this.buf = buf; this.pos = pos; this.end = end; this.lo = 0; this.hi = 0;
  }

  /** Decode one varint into this.lo / this.hi (both int32 bit patterns). */
  varint() {
    const b = this.buf;
    let p = this.pos, lo = 0, hi = 0, x = 0;
    done: {
      for (let s = 0; s < 28; s += 7) { x = b[p++]; lo |= (x & 0x7f) << s; if (x < 0x80) break done; }
      x = b[p++]; lo |= (x & 0x0f) << 28; hi = (x & 0x7f) >> 4; if (x < 0x80) break done;
      for (let s = 3; s < 32; s += 7) { x = b[p++]; hi |= (x & 0x7f) << s; if (x < 0x80) break done; }
      throw new RangeError(`malformed varint at ${this.pos}`);
    }
    if (p > this.end) throw new RangeError(`truncated varint at ${this.pos}`);
    this.pos = p; this.lo = lo; this.hi = hi;
  }

  /** uint64 as a Number (exact below 2^53). */
  uint() { this.varint(); return (this.hi >>> 0) * TWO32 + (this.lo >>> 0); }

  /** int64 (two's complement) as a Number (exact for |v| < 2^53). */
  int() {
    this.varint();
    if (this.hi >= 0) return this.hi * TWO32 + (this.lo >>> 0);
    return -((~this.hi >>> 0) * TWO32 + (~this.lo >>> 0) + 1);
  }

  /** uint64 as a Map key: Number when exact, BigInt otherwise. */
  key() {
    this.varint();
    return (this.hi >>> 0) < 0x200000
      ? (this.hi >>> 0) * TWO32 + (this.lo >>> 0)
      : (BigInt(this.hi >>> 0) << 32n) | BigInt(this.lo >>> 0);
  }

  big() { this.varint(); return (BigInt(this.hi >>> 0) << 32n) | BigInt(this.lo >>> 0); }
  sbig() { return BigInt.asIntN(64, this.big()); }

  /** Read a length prefix; returns the end offset of the delimited region. */
  limit() {
    const n = this.uint(), e = this.pos + n;
    if (e > this.end) throw new RangeError(`length ${n} overruns buffer at ${this.pos}`);
    return e;
  }

  skip(wire) {
    switch (wire) {
      case 0: this.varint(); break;
      case 1: this.pos += 8; break;
      case 2: this.pos = this.limit(); break;
      case 5: this.pos += 4; break;
      default: throw new RangeError(`unsupported wire type ${wire} at ${this.pos}`);
    }
    if (this.pos > this.end) throw new RangeError('truncated field');
  }
}

/** Repeated scalar: accepts both packed (wire 2) and unpacked (wire 0). */
export function repeated(r, wire, read, out) {
  if (wire === 2) { const e = r.limit(); while (r.pos < e) out.push(read(r)); }
  else if (wire === 0) out.push(read(r));
  else throw new RangeError(`bad wire type ${wire} for repeated scalar`);
}
