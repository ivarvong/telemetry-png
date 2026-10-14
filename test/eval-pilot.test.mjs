import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { factMatch, scoreRecord } from '../eval/png-json-pilot/score-results.mjs';
import { traceAnalysis, build } from '../eval/png-json-pilot/build-inputs.mjs';

const projectRoot = fileURLToPath(new URL('..', import.meta.url));
const expectedCaseFacts = {
  'concurrent-straggler': { total_ms: 318, primary_name: 'model inference' },
  'retry-backoff': { retry_count: 6, error_count: 8 },
  'error-cascade': { total_ms: 8000, error_count: 8 },
  'root-self-elapsed': { total_ms: 100, root_self_ms: 75 },
  'multipage-deep': { total_ms: 8000, error_count: 8 },
  'cpu-hotspot': { cpu_total_ms: 10, cpu_hotspot_name: 'syntheticScanlineHotspot', cpu_hotspot_pct: 80 },
  'sparse-profile': { cpu_total_ms: 0.1, cpu_hotspot_name: 'syntheticSingleSample', cpu_hotspot_pct: 100 },
  healthy: { total_ms: 80, error_count: 0, concurrent: true },
};

test('eval fact scorer applies numeric tolerance and exact booleans', () => {
  assert.equal(factMatch(100, 101.9), true);
  assert.equal(factMatch(100, 103), false);
  assert.equal(factMatch(true, true), true);
  assert.equal(factMatch(true, false), false);
});

test('eval scorer uses frozen fact and diagnosis criteria', () => {
  const record = { parsed: { facts: { total_ms: 100, error_count: 2 }, diagnosis: 'retry with backoff', evidence: [] } };
  const key = { facts: { total_ms: 100, error_count: 2, unused: null }, diagnosis_keyword_groups: [['retry'], ['backoff']] };
  const score = scoreRecord(record, key);
  assert.equal(score.fact_score, 1);
  assert.equal(score.diagnosis_score, 1);
});

test('score CLI runs from a checkout path containing URL-encoded characters', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'otel eval checkout '));
  try {
    const checkoutDir = path.join(dir, 'checkout with space');
    const scriptDir = path.join(checkoutDir, 'eval/png-json-pilot');
    const artifactDir = path.join(dir, 'artifacts');
    const inputDir = path.join(artifactDir, 'inputs', 'case-1');
    fs.mkdirSync(scriptDir, { recursive: true });
    fs.mkdirSync(inputDir, { recursive: true });
    const script = path.join(scriptDir, 'score-results.mjs');
    fs.copyFileSync(path.join(projectRoot, 'eval/png-json-pilot/score-results.mjs'), script);

    const baseRecord = {
      case_id: 'case-1', repeat: 1, valid: true, model: 'test', thinking: 'test',
      latency_ms: 1, usage: {}, image_count: 0, image_bytes: 0,
      hybrid_json_requested: false,
      parsed: { facts: { total_ms: 10 }, diagnosis: 'healthy', evidence: [] },
    };
    const records = ['raw', 'analyzed', 'png', 'hybrid'].map(format => ({ ...baseRecord, format }));
    fs.writeFileSync(path.join(artifactDir, 'trial-index.json'), JSON.stringify(records));
    fs.writeFileSync(path.join(inputDir, 'answer-key.json'), JSON.stringify({
      facts: { total_ms: 10 }, diagnosis_keyword_groups: [['healthy']],
    }));

    const result = spawnSync(process.execPath, [script, artifactDir], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(JSON.parse(fs.readFileSync(path.join(artifactDir, 'summary.json'), 'utf8')).trial_count, 4);
    assert.equal(JSON.parse(fs.readFileSync(path.join(artifactDir, 'scored-trials.json'), 'utf8')).length, 4);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('trace analysis independently computes synthetic straggler facts', async () => {
  const file = path.join(projectRoot, 'examples/02-fanout-straggler.json');
  const analysis = await traceAnalysis(file);
  assert.equal(analysis.summary.span_count, 16);
  assert.equal(analysis.summary.total_ms, 318);
  assert.equal(analysis.summary.concurrent, true);
  assert.equal(analysis.summary.critical_hot_name, 'model inference');
});

test('input builder freezes and scores all eight wholly synthetic cases', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'otel-eval-'));
  try {
    const manifest = await build(dir);
    assert.equal(manifest.cases.length, 8);
    assert.deepEqual(manifest.cases.map(c => c.id).sort(), Object.keys(expectedCaseFacts).sort());

    for (const c of manifest.cases) {
      assert.match(c.provenance, /synthetic/i);
      assert.doesNotMatch(c.provenance, /real|production capture/i);
      assert.ok(c.pngs.length >= 1);
      for (const [file, metadata] of Object.entries(c.files)) {
        assert.equal(metadata.sha256.length, 64);
        assert.ok(fs.existsSync(path.join(dir, c.id, file)));
      }

      const key = JSON.parse(fs.readFileSync(path.join(dir, c.id, 'answer-key.json'), 'utf8'));
      assert.deepEqual(Object.fromEntries(Object.keys(expectedCaseFacts[c.id]).map(name => [name, key.facts[name]])), expectedCaseFacts[c.id]);
      const diagnosis = key.diagnosis_keyword_groups.map(group => group[0]).join(' ');
      const score = scoreRecord({ parsed: { facts: key.facts, diagnosis, evidence: [] } }, key);
      assert.equal(score.fact_score, 1, `${c.id} fact rubric`);
      assert.equal(score.diagnosis_score, 1, `${c.id} diagnosis rubric`);
    }

    assert.ok(manifest.cases.find(c => c.id === 'multipage-deep').pngs.length > 1);
    assert.equal(manifest.cases.find(c => c.id === 'cpu-hotspot').raw, 'raw.cpuprofile');
    assert.equal(manifest.cases.find(c => c.id === 'sparse-profile').raw, 'raw.cpuprofile');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
