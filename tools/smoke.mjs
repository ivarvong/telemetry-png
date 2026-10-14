#!/usr/bin/env node
// Deployment acceptance: generate native trace workload, wait for telemetry
// ingestion, query that exact correlated platform trace, and save its PNG + evidence.
// Account telemetry requests use the separately configured application bearer secret.
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';

const base = (process.argv[2] ?? '').replace(/\/$/, '');
if (!base) throw new Error('usage: TELEMETRY_AUTH_SECRET=... node tools/smoke.mjs <base-url> [artifact-dir]');
const authSecret = process.env.TELEMETRY_AUTH_SECRET;
if (!authSecret) throw new Error('TELEMETRY_AUTH_SECRET is required for authenticated account telemetry smoke tests');
const out = process.argv[3] ?? `artifacts/${new Date().toISOString().replaceAll(':', '').replaceAll('.', '')}`;
const request = (pathname, init = {}) => fetch(`${base}${pathname}`, { ...init, headers: { authorization: `Bearer ${authSecret}`, ...init.headers }, signal: AbortSignal.timeout(30_000) });
const health = await (await request('/health')).json();
if (!health.ok || health.source !== 'cloudflare-workers-observability') throw new Error('health failed');
if (health.deploymentId !== null && typeof health.deploymentId !== 'string') throw new Error('health deployment id is invalid');
const [profileMetadataResponse, profileResponse, profileImageResponse] = await Promise.all([
  request('/profile/metadata.json'), request('/profile/otel-ping-worker.pprof'), request('/profile/flame.png'),
]);
if (!profileMetadataResponse.ok || !profileResponse.ok || !profileImageResponse.ok) throw new Error('captured profile routes failed');
const profileMetadata = await profileMetadataResponse.json();
const profileBytes = new Uint8Array(await profileResponse.arrayBuffer());
const profileImage = new Uint8Array(await profileImageResponse.arrayBuffer());
if (profileMetadata.scope !== 'SYNTHETIC TRACE; LOCAL NODE.JS CPU PROFILE; NOT A PRODUCTION MEASUREMENT' || profileMetadata.targetTrace?.synthetic !== true || !profileMetadata.provenance?.includes('No production telemetry') || profileMetadata.pprofNonIdleSamples <= 0 || !profileMetadata.sourceHashes?.['worker-bench/worker.mjs']) throw new Error('synthetic profile provenance/sample metadata invalid');
if (profileBytes.length < 1000 || profileImage.length < 8 || Buffer.from(profileImage.subarray(0, 8)).toString('hex') !== '89504e470d0a1a0a') throw new Error('captured profile artifacts invalid');
const before = Date.now();
const generatedResponse = await request('/api/workload', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ count: 3 }) });
if (!generatedResponse.ok) throw new Error(`workload failed: ${generatedResponse.status}`);
const generated = await generatedResponse.json();
if (!/^[a-f0-9]{16}$/.test(generated.workloadId)) throw new Error('workload correlation id missing');

let selected, listing, pngResponse, png;
const attempted = new Set();
for (let attempt = 1; attempt <= 12 && !selected; attempt++) {
  await new Promise((resolve) => setTimeout(resolve, 5000));
  const response = await request('/api/traces?minutes=15');
  if (!response.ok) throw new Error(`trace list failed: ${response.status}`);
  listing = await response.json();
  if (listing.synthetic !== false || listing.platform !== 'cloudflare-workers-observability') throw new Error('trace list did not attest platform source');
  const candidates = listing.traces.filter((trace) => trace.traceStartMs >= before - 2000 && trace.services.includes('otel-ping') && trace.spans >= 4 && !attempted.has(trace.traceId));
  process.stderr.write(`telemetry poll ${attempt}: ${listing.traces.length} traces, ${candidates.length} new candidate(s)\n`);
  for (const candidate of candidates) {
    attempted.add(candidate.traceId);
    const rendered = await request(`/api/trace/${candidate.traceId}.png?from=${candidate.traceStartMs}&to=${candidate.traceEndMs}&workloadId=${generated.workloadId}`);
    if (!rendered.ok) continue;
    const bytes = new Uint8Array(await rendered.arrayBuffer());
    if (Number(rendered.headers.get('x-otel-png-workload-match')) >= 3) {
      selected = candidate;
      pngResponse = rendered;
      png = bytes;
      break;
    }
  }
}
if (!selected || !listing || !pngResponse || !png) throw new Error('no correlated otel-ping platform workload trace after 60 seconds');
if (pngResponse.headers.get('x-otel-png-source') !== 'cloudflare-workers-observability') throw new Error('PNG source header missing');
if (Number(pngResponse.headers.get('x-otel-png-workload-spans')) < 3) throw new Error('selected platform trace does not contain workload spans');
if (png.length < 8 || Buffer.from(png.subarray(0, 8)).toString('hex') !== '89504e470d0a1a0a') throw new Error('invalid PNG');
await fs.mkdir(out, { recursive: true });
const pngFile = `${selected.traceId}.png`;
await fs.writeFile(path.join(out, pngFile), png);
await fs.writeFile(path.join(out, 'otel-ping-worker.pprof'), profileBytes);
await fs.writeFile(path.join(out, 'otel-ping-worker-flame.png'), profileImage);
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const sourceFiles = [
  'otel-png.mjs', 'otel-png-cf.mjs', 'otel-png-deflate.mjs', 'otel-png-font.mjs',
  'otel-png-layout.mjs', 'otel-png-model.mjs', 'otel-png-raster.mjs',
  'worker-bench/worker.mjs', 'worker-bench/profile-artifacts.mjs', 'worker-bench/wrangler.toml',
];
const sourceManifest = {
  algorithm: 'sha256',
  files: Object.fromEntries(await Promise.all(sourceFiles.map(async (file) => [file, sha256(await fs.readFile(file))]))),
};
const manifestText = `${JSON.stringify(sourceManifest, null, 2)}\n`;
await fs.writeFile(path.join(out, 'source-manifest.json'), manifestText);
const evidence = {
  checkedAt: new Date().toISOString(), url: base, health,
  deployment: { id: health.deploymentId ?? null, tag: health.deploymentTag ?? null },
  sourceManifest: { file: 'source-manifest.json', sha256: sha256(manifestText) },
  workload: { workloadId: generated.workloadId, count: generated.count, wallMs: generated.wallMs },
  listing: { platform: listing.platform, synthetic: listing.synthetic, from: listing.from, to: listing.to, candidateLimit: listing.candidateLimit, candidateCount: listing.candidateCount, count: listing.traces.length },
  selected,
  png: { bytes: png.length, spansHeader: pngResponse.headers.get('x-otel-png-spans'), workloadSpansHeader: pngResponse.headers.get('x-otel-png-workload-spans'), workloadMatchHeader: pngResponse.headers.get('x-otel-png-workload-match'), pagesHeader: pngResponse.headers.get('x-otel-png-pages'), sourceHeader: pngResponse.headers.get('x-otel-png-source') },
  capturedProfile: { metadata: profileMetadata, pprofBytes: profileBytes.length, flamePngBytes: profileImage.length },
};
await fs.writeFile(path.join(out, 'evidence.json'), `${JSON.stringify(evidence, null, 2)}\n`);
// Hash every evidence artifact except the checksum file itself, which cannot hash
// itself without a circular definition. Sort paths for reproducible manifests.
const artifactFiles = [pngFile, 'evidence.json', 'source-manifest.json', 'otel-ping-worker.pprof', 'otel-ping-worker-flame.png'].sort();
const checksums = await Promise.all(artifactFiles.map(async (file) => `${sha256(await fs.readFile(path.join(out, file)))}  ${file}`));
await fs.writeFile(path.join(out, 'SHA256SUMS'), `${checksums.join('\n')}\n`);
console.log(JSON.stringify({ ok: true, traceId: selected.traceId, png: path.join(out, pngFile), evidence: path.join(out, 'evidence.json'), checksums: path.join(out, 'SHA256SUMS'), bytes: png.length }));
