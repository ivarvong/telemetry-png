#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const PROJECT_ROOT = fileURLToPath(new URL('../..', import.meta.url));
const frame = (functionName, lineNumber) => ({ functionName, url: 'synthetic-eval-worker.mjs', lineNumber, columnNumber: 0 });

function span({ id, parent = '', name, startMs, endMs, attributes = [], error = false }) {
  return {
    traceId: '53594e5448455449434556414c303031',
    spanId: id.toString(16).padStart(16, '0'),
    parentSpanId: parent ? parent.toString(16).padStart(16, '0') : '',
    name,
    startTimeUnixNano: String(1_800_000_000_000_000_000n + BigInt(startMs) * 1_000_000n),
    endTimeUnixNano: String(1_800_000_000_000_000_000n + BigInt(endMs) * 1_000_000n),
    attributes,
    status: error ? { code: 2, message: 'synthetic failure' } : {},
  };
}

function trace(service, spans) {
  return { resourceSpans: [{
    resource: { attributes: [{ key: 'service.name', value: { stringValue: service } }] },
    scopeSpans: [{ scope: { name: 'synthetic-eval-generator' }, spans }],
  }] };
}

function cpuProfile(nodes, samples, intervalUs = 100) {
  return {
    startTime: 1_000_000,
    endTime: 1_000_000 + samples.length * intervalUs,
    nodes,
    samples,
    timeDeltas: samples.map(() => intervalUs),
  };
}

const root = { id: 1, callFrame: frame('(root)', -1) };

/** Generate deterministic, fictional profiles used only by the public evaluation. */
export function generateSyntheticProfiles(outDir) {
  fs.mkdirSync(outDir, { recursive: true });
  const profiles = {
    'root-self-elapsed.json': trace('synthetic-checkout', [
      span({ id: 1, name: 'synthetic checkout request', startMs: 0, endMs: 100 }),
      span({ id: 2, parent: 1, name: 'synthetic cache lookup', startMs: 10, endMs: 25 }),
      span({ id: 3, parent: 1, name: 'synthetic response encode', startMs: 70, endMs: 80 }),
    ]),
    'healthy.json': trace('synthetic-api', [
      span({ id: 1, name: 'synthetic healthy request', startMs: 0, endMs: 80 }),
      span({ id: 2, parent: 1, name: 'synthetic account lookup', startMs: 10, endMs: 45 }),
      span({ id: 3, parent: 1, name: 'synthetic preferences lookup', startMs: 20, endMs: 60 }),
      span({ id: 4, parent: 1, name: 'synthetic response encode', startMs: 62, endMs: 72 }),
    ]),
    'cpu-hotspot.cpuprofile': cpuProfile([
      { ...root, children: [2, 5] },
      { id: 2, callFrame: frame('renderSyntheticPage', 10), children: [3, 4] },
      { id: 3, callFrame: frame('syntheticScanlineHotspot', 24), children: [] },
      { id: 4, callFrame: frame('blendSyntheticPixel', 38), children: [] },
      { id: 5, callFrame: frame('serializeSyntheticResult', 52), children: [] },
    ], [...Array(80).fill(3), ...Array(15).fill(4), ...Array(5).fill(5)]),
    'sparse-profile.cpuprofile': cpuProfile([
      { ...root, children: [2, 3] },
      { id: 2, callFrame: frame('syntheticSingleSample', 70), children: [] },
      { id: 3, callFrame: frame('(idle)', -1), children: [] },
    ], [2, 3]),
  };

  for (const [name, profile] of Object.entries(profiles)) {
    fs.writeFileSync(path.join(outDir, name), `${JSON.stringify(profile, null, 2)}\n`);
  }
  for (const name of ['cpu-hotspot', 'sparse-profile']) {
    const result = spawnSync(process.execPath, [
      path.join(PROJECT_ROOT, 'pprof-render/tools/cpuprofile-to-pprof.mjs'),
      path.join(outDir, `${name}.cpuprofile`),
      path.join(outDir, `${name}.pprof`),
      '--interval-us', '100',
    ], { cwd: PROJECT_ROOT, encoding: 'utf8' });
    if (result.status !== 0) throw new Error(result.stderr || result.stdout || `failed to generate ${name}.pprof`);
  }
  return outDir;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  generateSyntheticProfiles(path.resolve(process.argv[2] ?? 'test/fixtures/eval/generated'));
}
