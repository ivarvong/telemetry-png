// pprof Profile decoder -> columnar, index-linked tables. This implementation is local.
// Schema reference (Apache-2.0), pinned for provenance:
// https://github.com/google/pprof/blob/101d87ff5bc37124090081eb492825d9439a6a53/proto/profile.proto
import { Reader, repeated } from './proto.js';

// Inflated size cap: a small gzip member can expand ~1000x (a 194 KB bomb is 200 MB).
export const MAX_INFLATED_BYTES = 64 * 2 ** 20;

/** gzip -> bytes, refusing more than maxBytes of output; non-gzip input is returned as is. */
export async function gunzip(bytes, { maxBytes = MAX_INFLATED_BYTES } = {}) {
  if (!(bytes[0] === 0x1f && bytes[1] === 0x8b)) return bytes;
  const reader = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip')).getReader();
  const parts = [];
  let size = 0;
  for (;;) {
    let step;
    try {
      step = await reader.read();
    } catch (e) { // Node reports a truncated member as a TypeError with an empty message
      const why = e?.message || e?.code || 'unexpected end of data';
      throw new Error(`invalid or truncated gzip data (${why})`, { cause: e });
    }
    if (step.done) break;
    size += step.value.length;
    if (size > maxBytes) {
      reader.cancel().catch(() => {});
      throw new RangeError(`gzip data inflates to more than ${maxBytes} bytes`);
    }
    parts.push(step.value);
  }
  const out = new Uint8Array(size);
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

const uint = (r) => r.uint(), int = (r) => r.int(), key = (r) => r.key();

function valueType(r, end) {
  const v = { type: 0, unit: 0 };
  while (r.pos < end) {
    const tag = r.uint();
    if (tag === 8) v.type = r.uint(); else if (tag === 16) v.unit = r.uint(); else r.skip(tag & 7);
  }
  return v;
}

export function decodeProfile(bytes) {
  const r = new Reader(bytes), utf8 = new TextDecoder();
  const strings = [], sampleTypes = [], comments = [], mappings = [];
  const sLocOff = [0], sLoc = [], sValOff = [0], sVal = [];
  const labels = [];                                   // {sample, key, str, num, unit}
  const lId = [], lMap = [], lAddr = [], lLineOff = [0], lineFn = [], lineNo = [], lFolded = [];
  const fId = [], fName = [], fSys = [], fFile = [], fStart = [];
  const meta = { dropFrames: 0, keepFrames: 0, timeNanos: 0n, durationNanos: 0, periodType: null,
    period: 0, defaultSampleType: 0, docUrl: 0 };

  while (r.pos < r.end) {
    const tag = r.uint(), field = tag >>> 3, wire = tag & 7;
    const isMessage = (field >= 1 && field <= 5) || field === 11;
    if ((isMessage || field === 6) && wire !== 2) throw new RangeError(`field ${field}: expected length-delimited, got wire type ${wire}`);
    if (!isMessage && field !== 6 && field !== 13 && field <= 15 && wire !== 0) { r.skip(wire); continue; }
    const end = isMessage ? r.limit() : 0;
    switch (field) {
      case 1: sampleTypes.push(valueType(r, end)); break;
      case 2: {
        const si = sLocOff.length - 1;
        while (r.pos < end) {
          const t = r.uint(), f = t >>> 3, w = t & 7;
          if (f === 1) repeated(r, w, key, sLoc);
          else if (f === 2) repeated(r, w, int, sVal);
          else if (f === 3) {
            const le = r.limit(), l = { sample: si, key: 0, str: 0, num: 0, unit: 0 };
            while (r.pos < le) {
              const lt = r.uint();
              if (lt === 8) l.key = r.uint(); else if (lt === 16) l.str = r.uint();
              else if (lt === 24) l.num = r.int(); else if (lt === 32) l.unit = r.uint();
              else r.skip(lt & 7);
            }
            labels.push(l);
          } else r.skip(w);
        }
        sLocOff.push(sLoc.length); sValOff.push(sVal.length);
        break;
      }
      case 3: {
        const m = { id: 0, start: 0n, limit: 0n, offset: 0n, filename: 0, buildId: 0,
          hasFunctions: false, hasFilenames: false, hasLineNumbers: false, hasInlineFrames: false };
        while (r.pos < end) {
          const t = r.uint();
          switch (t) {
            case 8: m.id = r.key(); break;
            case 16: m.start = r.big(); break;
            case 24: m.limit = r.big(); break;
            case 32: m.offset = r.big(); break;
            case 40: m.filename = r.uint(); break;
            case 48: m.buildId = r.uint(); break;
            case 56: m.hasFunctions = r.uint() !== 0; break;
            case 64: m.hasFilenames = r.uint() !== 0; break;
            case 72: m.hasLineNumbers = r.uint() !== 0; break;
            case 80: m.hasInlineFrames = r.uint() !== 0; break;
            default: r.skip(t & 7);
          }
        }
        mappings.push(m);
        break;
      }
      case 4: {
        let id = 0, map = 0, addr = 0n, folded = 0;
        while (r.pos < end) {
          const t = r.uint();
          if (t === 8) id = r.key();
          else if (t === 16) map = r.key();
          else if (t === 24) addr = r.big();
          else if (t === 34) {
            const le = r.limit(); let fn = 0, ln = 0;
            while (r.pos < le) {
              const lt = r.uint();
              if (lt === 8) fn = r.key(); else if (lt === 16) ln = r.int(); else r.skip(lt & 7);
            }
            lineFn.push(fn); lineNo.push(ln);
          } else if (t === 40) folded = r.uint();
          else r.skip(t & 7);
        }
        lId.push(id); lMap.push(map); lAddr.push(addr); lFolded.push(folded); lLineOff.push(lineFn.length);
        break;
      }
      case 5: {
        let id = 0, name = 0, sys = 0, file = 0, start = 0;
        while (r.pos < end) {
          const t = r.uint();
          if (t === 8) id = r.key(); else if (t === 16) name = r.uint(); else if (t === 24) sys = r.uint();
          else if (t === 32) file = r.uint(); else if (t === 40) start = r.int(); else r.skip(t & 7);
        }
        fId.push(id); fName.push(name); fSys.push(sys); fFile.push(file); fStart.push(start);
        break;
      }
      case 6: { const e = r.limit(); strings.push(utf8.decode(bytes.subarray(r.pos, e))); r.pos = e; break; }
      case 7: meta.dropFrames = r.uint(); break;
      case 8: meta.keepFrames = r.uint(); break;
      case 9: meta.timeNanos = r.sbig(); break;
      case 10: meta.durationNanos = r.int(); break;
      case 11: meta.periodType = valueType(r, end); break;
      case 12: meta.period = r.int(); break;
      case 13: repeated(r, wire, uint, comments); break;
      case 14: meta.defaultSampleType = r.uint(); break;
      case 15: meta.docUrl = r.uint(); break;
      default: r.skip(wire);
    }
  }

  // ---- validate + link: arbitrary uint64 ids -> dense array indices ----
  if (strings.length === 0 || strings[0] !== '') throw new Error('string_table[0] must be ""');
  const str = (i) => { if (i >= strings.length) throw new Error(`string index ${i} out of range`); return strings[i]; };
  const index = (ids, what) => {
    const m = new Map();
    ids.forEach((id, i) => {
      if (id === 0) throw new Error(`${what} id 0 is reserved`);
      if (m.has(id)) throw new Error(`duplicate ${what} id ${id}`);
      m.set(id, i);
    });
    return m;
  };
  const link = (m, id, what) => {
    if (id === 0) return -1;
    const i = m.get(id);
    if (i === undefined) throw new Error(`unknown ${what} id ${id}`);
    return i;
  };
  const fIdx = index(fId, 'function'), lIdx = index(lId, 'location'), mIdx = index(mappings.map((m) => m.id), 'mapping');

  const nValues = sampleTypes.length, nSamples = sLocOff.length - 1;
  for (let i = 0; i < nSamples; i++) {
    if (sValOff[i + 1] - sValOff[i] !== nValues) throw new Error(`sample ${i}: ${sValOff[i + 1] - sValOff[i]} values, expected ${nValues}`);
  }
  const named = (v) => v && { type: str(v.type), unit: str(v.unit) };

  return {
    strings,
    sampleTypes: sampleTypes.map(named),
    samples: {
      count: nSamples, nValues,
      locOffsets: Uint32Array.from(sLocOff),
      locs: Int32Array.from(sLoc, (id) => { const i = link(lIdx, id, 'location'); if (i < 0) throw new Error('sample references location 0'); return i; }),
      values: Float64Array.from(sVal),          // row-major: values[sample * nValues + type]
    },
    labels: labels.map((l) => ({ sample: l.sample, key: str(l.key), str: l.str ? str(l.str) : null, num: l.num, unit: str(l.unit) })),
    locations: {
      count: lId.length, ids: lId, addresses: lAddr,
      mapping: Int32Array.from(lMap, (id) => link(mIdx, id, 'mapping')),
      lineOffsets: Uint32Array.from(lLineOff),  // line[0] = innermost inlined frame, last = physical caller
      lineFn: Int32Array.from(lineFn, (id) => link(fIdx, id, 'function')),
      lineNo: Int32Array.from(lineNo),
      folded: Uint8Array.from(lFolded),
    },
    functions: {
      count: fId.length, ids: fId,
      names: fName.map(str), systemNames: fSys.map(str), filenames: fFile.map(str),
      startLine: Int32Array.from(fStart),
    },
    mappings: mappings.map((m) => ({ ...m, filename: str(m.filename), buildId: str(m.buildId) })),
    comments: comments.map(str),
    dropFrames: str(meta.dropFrames), keepFrames: str(meta.keepFrames), docUrl: str(meta.docUrl),
    timeNanos: meta.timeNanos, durationNanos: meta.durationNanos,
    periodType: named(meta.periodType), period: meta.period,
    defaultSampleType: str(meta.defaultSampleType),
  };
}

export const parseProfile = async (bytes, opts) => decodeProfile(await gunzip(bytes, opts));

/** Index of the value column to show: by name, else default_sample_type, else the last (pprof's convention). */
export function sampleIndex(p, name) {
  const want = name ?? (p.defaultSampleType || null);
  if (want !== null) {
    const i = p.sampleTypes.findIndex((t) => t.type === want);
    if (i >= 0) return i;
    if (name != null) throw new Error(`no sample type "${name}" (have ${p.sampleTypes.map((t) => t.type).join(', ')})`);
  }
  return p.sampleTypes.length - 1;
}
