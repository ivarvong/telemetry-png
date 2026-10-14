// Test helpers. Tests may use node: modules; the library may not.
import zlib from 'node:zlib';
import crypto from 'node:crypto';
import fs from 'node:fs';

export const BASE = 1760000000000000000n;
export const ns = (ms) => String(BASE + BigInt(Math.round(ms * 1e6)));

// tree(['svc', 'name', startMs, endMs, { ...extra }, [children]]) -> OTLP JSON
export function otlp(...roots) {
  const by = new Map();
  let id = 0;
  const walk = ([service, name, a, b, extra = {}, kids = []], parent) => {
    const spanId = extra.spanId ?? `s${++id}`;
    if (!by.has(service)) by.set(service, []);
    by.get(service).push({
      traceId: 'abc', spanId, parentSpanId: extra.parentSpanId ?? parent, name,
      startTimeUnixNano: extra.start ?? ns(a), endTimeUnixNano: extra.end ?? ns(b),
      attributes: Object.entries(extra.attrs ?? {}).map(([key, v]) => ({ key, value: { stringValue: String(v) } })),
      status: extra.error ? { code: 2, message: extra.error } : {},
    });
    kids.forEach((k) => walk(k, spanId));
  };
  roots.forEach((r) => walk(r, ''));
  return { resourceSpans: [...by].map(([svc, spans]) => ({ resource: { attributes: [{ key: 'service.name', value: { stringValue: svc } }] }, scopeSpans: [{ spans }] })) };
}

export const MS = 1e6;

// Parse a PNG: verify the signature and every chunk CRC, inflate IDAT, return scanlines.
export function decodePng(png) {
  const sig = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (!sig.every((b, i) => png[i] === b)) throw new Error('bad signature');
  const dv = new DataView(png.buffer, png.byteOffset, png.byteLength);
  const chunks = [];
  for (let o = 8; o < png.length;) {
    const n = dv.getUint32(o);
    const type = String.fromCharCode(...png.subarray(o + 4, o + 8));
    const crc = zlib.crc32(png.subarray(o + 4, o + 8 + n));
    if (crc !== dv.getUint32(o + 8 + n)) throw new Error(`bad CRC in ${type}`);
    chunks.push({ type, data: png.subarray(o + 8, o + 8 + n) });
    o += 12 + n;
  }
  const ihdr = chunks[0].data, hv = new DataView(ihdr.buffer, ihdr.byteOffset);
  const width = hv.getUint32(0), height = hv.getUint32(4);
  const raw = new Uint8Array(zlib.inflateSync(Buffer.concat(chunks.filter((c) => c.type === 'IDAT').map((c) => c.data))));
  return { width, height, bitDepth: ihdr[8], colorType: ihdr[9], types: chunks.map((c) => c.type), palette: chunks.find((c) => c.type === 'PLTE').data.length / 3, raw };
}

export const sha = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex').slice(0, 16);
export const inflate = (bytes) => new Uint8Array(zlib.inflateSync(bytes));
export const load = (path) => JSON.parse(fs.readFileSync(new URL(`../${path}`, import.meta.url), 'utf8'));
export const fixtures = () => ['sample-trace', ...fs.readdirSync(new URL('../examples', import.meta.url)).filter((f) => f.endsWith('.json')).sort().map((f) => `examples/${f.slice(0, -5)}`)];
