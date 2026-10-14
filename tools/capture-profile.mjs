#!/usr/bin/env node
// Generate publishable demo artifacts from a deterministic synthetic trace and a
// local Node.js CPU profile. This tool never contacts Cloudflare or reads credentials.
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { Session } from 'node:inspector';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { openTrace } from '../otel-png.mjs';
import { synth } from './synth.mjs';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const WORKER_DIR = join(ROOT, 'worker-bench');
const INTERVAL_US = 100;
const SYNTHETIC_TRACE_ID = 'feedfacefeedfacefeedfacefeedface';
const SOURCE_FILES = ['worker-bench/worker.mjs', 'worker-bench/app-helpers.mjs', 'otel-png.mjs', 'otel-png-layout.mjs', 'otel-png-model.mjs', 'otel-png-raster.mjs', 'otel-png-deflate.mjs', 'otel-png-font.mjs', 'tools/synth.mjs'];
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
const stamp = () => new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');

// Retained as a small, independently tested utility for users importing older scripts.
// It parses text only and never evaluates shell syntax.
export function parseEnv(text) {
  const out = {};
  for (const line of text.split(/\r?\n/)) {
    const match = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (!match) continue;
    let value = match[2];
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    out[match[1]] = value;
  }
  return out;
}

export function sanitizeProfile(profile, tempRoot) {
  const cleanUrl = (url = '') => {
    const decoded = (() => { try { return decodeURIComponent(url); } catch { return url; } })();
    for (const file of SOURCE_FILES) if (decoded.endsWith(`/${file}`) || decoded.endsWith(file)) return `source://${file}`;
    if (decoded.startsWith('file:') || decoded.startsWith('/') || decoded.includes(tempRoot)) return `source://external/${basename(decoded) || 'anonymous'}`;
    return decoded.replaceAll(tempRoot, '<temp>');
  };
  const result = structuredClone(profile);
  for (const node of result.nodes ?? []) if (node.callFrame) node.callFrame.url = cleanUrl(node.callFrame.url);
  if (JSON.stringify(result).includes(tempRoot)) throw new Error('temporary path survived CPU profile sanitization');
  return result;
}

function inspectorCall(session, method, params = {}) {
  return new Promise((resolveCall, reject) => session.post(method, params, (error, result) => error ? reject(error) : resolveCall(result)));
}
function run(command, args) {
  const result = spawnSync(command, args, { cwd: ROOT, encoding: 'utf8' });
  if (result.status !== 0) throw new Error(`${command} ${args.join(' ')} failed (${result.status})\n${result.stdout}\n${result.stderr}`);
  return result;
}
async function sourceHashes() {
  return Object.fromEntries(await Promise.all(SOURCE_FILES.map(async (file) => [file, sha(await readFile(join(ROOT, file)))])));
}
async function writeBundle(metadata, files) {
  const entries = {};
  for (const [name, path] of Object.entries(files)) entries[name] = (await readFile(path)).toString('base64');
  const generated = `// Generated from a deterministic synthetic trace and local Node.js CPU profile.\n// Run: node tools/capture-profile.mjs\nconst decode = (text) => Uint8Array.from(atob(text), (c) => c.charCodeAt(0));\nconst encoded = ${JSON.stringify(entries)};\nexport const PROFILE_METADATA = Object.freeze(${JSON.stringify(metadata, null, 2)});\nexport const profileArtifact = (name) => encoded[name] ? decode(encoded[name]) : null;\n`;
  await writeFile(join(WORKER_DIR, 'profile-artifacts.mjs'), generated);
}

async function main() {
  if (process.argv.includes('--help')) { console.log('usage: node tools/capture-profile.mjs [artifact-directory]'); return; }
  const artifactDir = resolve(process.argv[2] ?? join(ROOT, 'artifacts', `synthetic-local-capture-${stamp()}`));
  await mkdir(artifactDir, { recursive: false });
  const temp = await mkdtemp(join(tmpdir(), 'otel-png-synthetic-profile-'));
  try {
    const trace = synth(600, 42);
    await writeFile(join(artifactDir, 'synthetic-trace.otlp.json'), `${JSON.stringify(trace, null, 2)}\n`);
    const session = new Session();
    session.connect();
    await inspectorCall(session, 'Profiler.enable');
    await inspectorCall(session, 'Profiler.setSamplingInterval', { interval: INTERVAL_US });
    await inspectorCall(session, 'Profiler.start');
    let renderedPages = 0, renderedBytes = 0;
    // Repeated local renders provide a useful sample profile without claiming to
    // represent deployed Worker performance.
    for (let iteration = 0; iteration < 24; iteration++) {
      const opened = openTrace(trace, { compress: 'js', width: 1280, maxHeight: 960 });
      for (let page = 0; page < opened.pages; page++) {
        for (const chunk of opened.chunks(page)) renderedBytes += chunk.byteLength;
        renderedPages++;
      }
    }
    const { profile } = await inspectorCall(session, 'Profiler.stop');
    session.disconnect();
    const sanitized = sanitizeProfile(profile, temp);
    const nodeById = new Map(sanitized.nodes.map((node) => [node.id, node]));
    const idleSamples = sanitized.samples.filter((id) => nodeById.get(id)?.callFrame?.functionName === '(idle)').length;
    const nonIdleSamples = sanitized.samples.length - idleSamples;
    const cpuProfile = join(artifactDir, 'synthetic-local.cpuprofile');
    const pprof = join(artifactDir, 'synthetic-local.pprof');
    const table = join(artifactDir, 'synthetic-local-table.png');
    const flame = join(artifactDir, 'synthetic-local-flame.png');
    await writeFile(cpuProfile, `${JSON.stringify(sanitized, null, 2)}\n`);
    run(process.execPath, ['pprof-render/tools/cpuprofile-to-pprof.mjs', cpuProfile, pprof, '--interval-us', String(INTERVAL_US)]);
    run(process.execPath, ['pprof-render/bin/pprof-png.mjs', pprof, table, '--view', 'table']);
    run(process.execPath, ['pprof-render/bin/pprof-png.mjs', pprof, flame, '--view', 'flame']);
    const files = { 'otel-ping-worker.pprof': pprof, 'otel-ping-worker-table.png': table, 'otel-ping-worker-flame.png': flame };
    const metadata = {
      title: 'Synthetic trace renderer local CPU profile',
      provenance: 'Generated locally from tools/synth.mjs. No production telemetry, account data, deployed Worker, or production CPU measurement was used.',
      scope: 'SYNTHETIC TRACE; LOCAL NODE.JS CPU PROFILE; NOT A PRODUCTION MEASUREMENT',
      captureTool: 'Node.js inspector CPU profiler',
      conversion: 'CDP samples converted to pprof; estimated sampled CPU is non-idle sample count multiplied by the configured interval. Trace elapsed time and wall time are not CPU weights.',
      capturedAt: new Date().toISOString(),
      targetTrace: { traceId: SYNTHETIC_TRACE_ID, synthetic: true, generator: 'tools/synth.mjs', seed: 42, spans: 600 },
      profiledRenders: 24,
      renderedPages,
      renderedBytes,
      cdpSamples: sanitized.samples.length,
      pprofNonIdleSamples: nonIdleSamples,
      configuredSamplingIntervalUs: INTERVAL_US,
      estimatedSampledCpuMs: nonIdleSamples * INTERVAL_US / 1000,
      sourceHashes: await sourceHashes(),
      sourceHashExclusions: { 'worker-bench/profile-artifacts.mjs': 'Generated output is excluded to avoid self-reference.' },
      hashes: Object.fromEntries(await Promise.all(Object.entries(files).map(async ([name, file]) => [name, sha(await readFile(file))]))),
      artifactDirectory: 'caller-selected local output directory (selected artifacts embedded in worker-bench/profile-artifacts.mjs)',
    };
    await writeFile(join(artifactDir, 'metadata.json'), `${JSON.stringify(metadata, null, 2)}\n`);
    await writeBundle(metadata, files);
    const checksumNames = ['metadata.json', 'synthetic-trace.otlp.json', 'synthetic-local.cpuprofile', 'synthetic-local.pprof', 'synthetic-local-table.png', 'synthetic-local-flame.png'];
    await writeFile(join(artifactDir, 'SHA256SUMS'), `${(await Promise.all(checksumNames.map(async (name) => `${sha(await readFile(join(artifactDir, name)))}  ${name}`))).join('\n')}\n`);
    console.log(JSON.stringify({ artifactDir, syntheticTraceId: SYNTHETIC_TRACE_ID, spans: 600, nonIdleSamples, renderedPages }, null, 2));
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch((error) => { console.error(error.stack || error); process.exitCode = 1; });
