#!/usr/bin/env node
// Convert a Chrome DevTools Protocol Profiler.stop CPUProfile to pprof protobuf.
// CPU values are sampled estimates (sample count × configured profiler interval),
// never request wall time or OTel span duration.
import { readFileSync, writeFileSync } from 'node:fs';

const [input, output, ...args] = process.argv.slice(2);
const usage = 'usage: cpuprofile-to-pprof in.cpuprofile out.pprof [--interval-us 100]';
if (!input || !output) { console.error(usage); process.exit(2); }
const at = args.indexOf('--interval-us');
const intervalUs = at < 0 ? 100 : Number(args[at + 1]);
if (!Number.isFinite(intervalUs) || intervalUs <= 0 || !Number.isInteger(intervalUs)) throw new Error('--interval-us must be a positive integer');

const profile = JSON.parse(readFileSync(input, 'utf8'));
if (!Array.isArray(profile.nodes) || !Array.isArray(profile.samples)) throw new Error('invalid CDP CPUProfile');

const bytes = [];
const raw = (data) => bytes.push(...data);
const varint = (value, out = bytes) => {
  let n = BigInt(value);
  if (n < 0n) n = BigInt.asUintN(64, n);
  while (n >= 0x80n) { out.push(Number(n & 0x7fn) | 0x80); n >>= 7n; }
  out.push(Number(n));
};
const tag = (field, wire, out = bytes) => varint(field * 8 + wire, out);
const scalar = (field, value, out = bytes) => { tag(field, 0, out); varint(value, out); };
const message = (field, body) => { tag(field, 2); varint(body.length); raw(body); };
const packed = (field, values, out) => {
  const body = []; for (const value of values) varint(value, body);
  tag(field, 2, out); varint(body.length, out); out.push(...body);
};
const msg = (build) => { const out = []; build(out); return out; };

const strings = [''];
const stringIds = new Map([['', 0]]);
const str = (value) => {
  const text = String(value ?? '');
  if (!stringIds.has(text)) { stringIds.set(text, strings.length); strings.push(text); }
  return stringIds.get(text);
};
const sampleType = (type, unit) => msg((out) => { scalar(1, str(type), out); scalar(2, str(unit), out); });
const comments = [
  str(`Converted from CDP CPUProfile; cpu/nanoseconds is sample count x configured ${intervalUs} us interval, not wall time.`),
  str('Samples whose leaf is (idle) are excluded.'),
];

const nodeById = new Map(profile.nodes.map((node) => [node.id, node]));
const parent = new Map();
for (const node of profile.nodes) for (const child of node.children ?? []) parent.set(child, node.id);
const usable = profile.nodes.filter((node) => node.callFrame?.functionName !== '(root)');
const functionId = new Map(), locationId = new Map();
usable.forEach((node, index) => { functionId.set(node.id, index + 1); locationId.set(node.id, index + 1); });

message(1, sampleType('samples', 'count'));
message(1, sampleType('cpu', 'nanoseconds'));
let kept = 0, idle = 0;
for (const leafId of profile.samples) {
  const leaf = nodeById.get(leafId);
  if (!leaf) throw new Error(`sample references unknown node ${leafId}`);
  if (leaf.callFrame?.functionName === '(idle)') { idle++; continue; }
  const stack = [];
  for (let id = leafId; locationId.has(id); id = parent.get(id)) stack.push(locationId.get(id));
  message(2, msg((out) => { packed(1, stack, out); packed(2, [1, intervalUs * 1000], out); }));
  kept++;
}
for (const node of usable) {
  const frame = node.callFrame ?? {};
  message(4, msg((out) => {
    scalar(1, locationId.get(node.id), out);
    messageInto(4, msg((line) => {
      scalar(1, functionId.get(node.id), line);
      if (Number.isInteger(frame.lineNumber) && frame.lineNumber >= 0) scalar(2, frame.lineNumber + 1, line);
      if (Number.isInteger(frame.columnNumber) && frame.columnNumber >= 0) scalar(3, frame.columnNumber + 1, line);
    }), out);
  }));
}
for (const node of usable) {
  const frame = node.callFrame ?? {}, name = frame.functionName || '(anonymous)', file = frame.url || '(native)';
  message(5, msg((out) => {
    scalar(1, functionId.get(node.id), out); scalar(2, str(name), out); scalar(3, str(name), out); scalar(4, str(file), out);
    if (Number.isInteger(frame.lineNumber) && frame.lineNumber >= 0) scalar(5, frame.lineNumber + 1, out);
  }));
}
function messageInto(field, body, out) { tag(field, 2, out); varint(body.length, out); out.push(...body); }
for (const text of strings) {
  const encoded = new TextEncoder().encode(text); tag(6, 2); varint(encoded.length); raw(encoded);
}
if (Number.isFinite(profile.endTime) && Number.isFinite(profile.startTime)) scalar(10, BigInt(Math.max(0, Math.trunc((profile.endTime - profile.startTime) * 1000))));
message(11, sampleType('cpu', 'nanoseconds'));
scalar(12, intervalUs * 1000);
for (const comment of comments) scalar(13, comment);
scalar(14, str('cpu'));

writeFileSync(output, Uint8Array.from(bytes));
console.error(`${output}: ${kept} CPU samples, ${idle} idle excluded, ${profile.nodes.length} CDP nodes, ${bytes.length} bytes`);
