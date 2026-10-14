#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { normalize, buildTrace } from '../../otel-png-model.mjs';
import { parseProfile, buildTrie, top, sampleIndex } from '../../pprof-render/src/index.js';
import { generateSyntheticProfiles } from './generate-synthetic-profiles.mjs';

const PROJECT_ROOT = fileURLToPath(new URL('../..', import.meta.url));
const projectFile = (relative) => path.join(PROJECT_ROOT, relative);

export const CASES = [
  { id: 'concurrent-straggler', kind: 'trace', source: projectFile('examples/02-fanout-straggler.json'), provenance: 'synthetic example trace', diagnosis: [['straggler'], ['model','inference']] },
  { id: 'retry-backoff', kind: 'trace', source: projectFile('examples/03-retry-backoff.json'), provenance: 'synthetic example trace', diagnosis: [['retry'], ['backoff']] },
  { id: 'error-cascade', kind: 'trace', source: projectFile('examples/07-timeout-cascade.json'), provenance: 'synthetic example trace', diagnosis: [['cascade','timeout'], ['stock','scan','database']] },
  { id: 'root-self-elapsed', kind: 'trace', generated: 'root-self-elapsed.json', provenance: 'reproducibly generated synthetic trace; no production data', diagnosis: [['root','self'], ['elapsed'], ['not cpu','unknown cpu']] },
  { id: 'multipage-deep', kind: 'trace', source: projectFile('examples/07-timeout-cascade.json'), provenance: 'synthetic example trace', diagnosis: [['deep','cascade'], ['timeout','error']] },
  { id: 'cpu-hotspot', kind: 'cpu', generated: 'cpu-hotspot.pprof', rawGenerated: 'cpu-hotspot.cpuprofile', provenance: 'reproducibly generated synthetic CPU profile; no production data', diagnosis: [['hotspot'], ['scanline']] },
  { id: 'sparse-profile', kind: 'cpu', generated: 'sparse-profile.pprof', rawGenerated: 'sparse-profile.cpuprofile', provenance: 'reproducibly generated sparse synthetic CPU profile; no production data', diagnosis: [['sparse','insufficient'], ['sample']] },
  { id: 'healthy', kind: 'trace', generated: 'healthy.json', provenance: 'reproducibly generated synthetic healthy trace; no production data', diagnosis: [['healthy','no error'], ['concurrent','overlap']] },
];

const round = (n, d = 6) => n == null ? null : Number(n.toFixed(d));
const sha = (p) => crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
const ensure = (p) => fs.mkdirSync(p, { recursive: true });

export async function traceAnalysis(file) {
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  const model = buildTrace(normalize(raw), { fold: 5 });
  const retries = model.rows.filter(r => /retry|attempt/i.test(`${r.name} ${r.attrs.flat().join(' ')}`)).length;
  const concurrent = model.rows.some((a, i) => model.rows.some((b, j) => j > i && a.depth === b.depth && a.off < b.end && b.off < a.end));
  const rootSelf = model.rows.filter(r => r.depth === 0).reduce((n, r) => n + r.self, 0) / 1e6;
  return {
    provenance_scope: 'values visible or geometrically encoded in the rendered trace PNG',
    summary: { span_count: model.spanCount, total_ms: round(model.total / 1e6), error_count: model.errors, max_depth: model.maxDepth, concurrent, retry_count: retries, root_self_ms: round(rootSelf), critical_hot_name: model.hot?.name ?? null, critical_hot_ms: round((model.hot?.critSelf ?? 0) / 1e6) },
    rows: model.rows.map(r => ({ name:r.name, service:r.service, depth:r.depth, start_ms:round(r.off/1e6), end_ms:round(r.end/1e6), duration_ms:round(r.dur/1e6), self_ms:round(r.self/1e6), critical_ms:round(r.critSelf/1e6), error:r.error, message:r.message, count:r.count })),
    caveats: ['self and critical values are elapsed interval computations, not CPU measurements']
  };
}

export async function cpuAnalysis(file) {
  const p = await parseProfile(fs.readFileSync(file));
  const vi = sampleIndex(p), trie = buildTrie(p, vi, { collapse:true }), t = top(p, vi), total = trie.total[0];
  const ranked = [...t.flat.keys()].filter(i => t.flat[i] > 0).sort((a,b)=>t.flat[b]-t.flat[a] || t.cum[b]-t.cum[a]);
  const rows = ranked.slice(0, 8).map(i => ({ name:p.functions.names[i], self:round(t.flat[i]), self_pct:round(100*t.flat[i]/total), cumulative:round(t.cum[i]), cumulative_pct:round(100*t.cum[i]/total) }));
  return { provenance_scope:'same aggregate computations rendered in table/flame PNGs', summary:{ sample_count:p.samples.count, sample_type:p.sampleTypes[vi], period:p.period, period_type:p.periodType, total:round(total), total_ms:round(total/1e6), hotspot_name:rows[0]?.name??null, hotspot_pct:rows[0]?.self_pct??null }, top_rows:rows, caveats:['sampled CPU estimate, not elapsed time or exact accounting','profile is reproducibly generated synthetic evaluation data, not a real capture'] };
}

export async function build(outRoot) {
  const syntheticDir = fs.mkdtempSync(path.join(os.tmpdir(), 'otel-png-eval-synthetic-'));
  ensure(outRoot);
  try {
    generateSyntheticProfiles(syntheticDir);
    const manifest = { version:1, created_at:new Date().toISOString(), cases:[] };
    for (const c of CASES) {
      const source = c.source ?? path.join(syntheticDir, c.generated);
      const rawSource = c.rawGenerated ? path.join(syntheticDir, c.rawGenerated) : source;
      const dir=path.join(outRoot,c.id); ensure(dir);
      const rawExt=c.kind==='cpu'?'.cpuprofile':'.json', raw=path.join(dir,`raw${rawExt}`);
      fs.copyFileSync(rawSource,raw);
      const analysis=c.kind==='trace'?await traceAnalysis(source):await cpuAnalysis(source);
      fs.writeFileSync(path.join(dir,'analyzed.json'),JSON.stringify(analysis,null,2)+'\n');
      if(c.kind==='trace') {
        const h=c.id==='multipage-deep'?320:700;
        const r=spawnSync(process.execPath,[projectFile('otel-png-cli.mjs'),source,path.join(dir,'view.png'),'--max-height',String(h),'--fold','0'],{cwd:PROJECT_ROOT,encoding:'utf8'});
        if(r.status) throw new Error(r.stderr||r.stdout);
      } else {
        for(const view of ['table','flame']) { const r=spawnSync(process.execPath,[projectFile('pprof-render/bin/pprof-png.mjs'),source,path.join(dir,`${view}.png`),'--view',view],{cwd:PROJECT_ROOT,encoding:'utf8'}); if(r.status) throw new Error(r.stderr||r.stdout); }
      }
      const pngs=fs.readdirSync(dir).filter(x=>x.endsWith('.png')).sort();
      const s=analysis.summary;
      const facts=c.kind==='trace'?{total_ms:s.total_ms,error_count:s.error_count,concurrent:s.concurrent,retry_count:s.retry_count,root_self_ms:s.root_self_ms,primary_name:s.critical_hot_name,cpu_total_ms:null,cpu_hotspot_name:null,cpu_hotspot_pct:null}:{total_ms:null,error_count:null,concurrent:null,retry_count:null,root_self_ms:null,primary_name:null,cpu_total_ms:s.total_ms,cpu_hotspot_name:s.hotspot_name,cpu_hotspot_pct:s.hotspot_pct};
      const key={case_id:c.id,provenance:c.provenance,facts,diagnosis_keyword_groups:c.diagnosis};
      fs.writeFileSync(path.join(dir,'answer-key.json'),JSON.stringify(key,null,2)+'\n');
      const files=[path.basename(raw),'analyzed.json','answer-key.json',...pngs];
      manifest.cases.push({id:c.id,kind:c.kind,provenance:c.provenance,raw:path.basename(raw),analyzed:'analyzed.json',pngs,files:Object.fromEntries(files.map(f=>[f,{bytes:fs.statSync(path.join(dir,f)).size,sha256:sha(path.join(dir,f))}]))});
    }
    fs.writeFileSync(path.join(outRoot,'manifest.json'),JSON.stringify(manifest,null,2)+'\n');
    return manifest;
  } finally {
    fs.rmSync(syntheticDir, { recursive:true, force:true });
  }
}
if(process.argv[1] && path.resolve(process.argv[1])===fileURLToPath(import.meta.url)) await build(path.resolve(process.argv[2]??path.join(PROJECT_ROOT,'artifacts/png-json-pilot/inputs')));
