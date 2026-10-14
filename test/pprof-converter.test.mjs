import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { parseProfile, top } from '../pprof-render/src/index.js';

test('CDP CPU profile converter emits CPU samples without idle or wall-time weighting', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'otel-ping-cpuprofile-'));
  try {
    const input = join(dir, 'in.cpuprofile'), output = join(dir, 'out.pprof');
    await writeFile(input, JSON.stringify({
      startTime: 1_000_000,
      endTime: 9_000_000,
      nodes: [
        { id: 1, callFrame: { functionName: '(root)', url: '', lineNumber: -1, columnNumber: -1 }, children: [2, 4] },
        { id: 2, callFrame: { functionName: 'renderSelected', url: 'worker.js', lineNumber: 10, columnNumber: 1 }, children: [3] },
        { id: 3, callFrame: { functionName: 'scanline', url: 'worker.js', lineNumber: 20, columnNumber: 2 }, children: [] },
        { id: 4, callFrame: { functionName: '(idle)', url: '', lineNumber: -1, columnNumber: -1 }, children: [] },
      ],
      samples: [3, 3, 4],
      timeDeltas: [100, 100, 7_999_800],
    }));
    const run = spawnSync(process.execPath, ['pprof-render/tools/cpuprofile-to-pprof.mjs', input, output, '--interval-us', '100'], { cwd: new URL('..', import.meta.url), encoding: 'utf8' });
    assert.equal(run.status, 0, run.stderr);
    const profile = await parseProfile(await readFile(output));
    assert.deepEqual(profile.sampleTypes, [{ type: 'samples', unit: 'count' }, { type: 'cpu', unit: 'nanoseconds' }]);
    assert.equal(profile.samples.count, 2, 'idle sample excluded');
    assert.equal(top(profile, 1).total, 200_000, 'CPU is sample count × interval, not eight seconds of wall time');
    assert.match(profile.comments.join('\n'), /not wall time/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
