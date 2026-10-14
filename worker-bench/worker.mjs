// Sample self-observation Worker using Cloudflare native Workers traces.
// Account telemetry routes require an application bearer secret in addition to
// Cloudflare API credentials. They fail closed when either is not configured.
import { tracing } from 'cloudflare:workers';
import { openTrace } from '../otel-png.mjs';
import { eventsToOtlp, fetchTraceEvents, recentTracesQuery, runQuery, traceSummaries } from '../otel-png-cf.mjs';
import { PROFILE_METADATA, profileArtifact } from './profile-artifacts.mjs';
import { BoundedCoalescingCache, createBlobUrlStore, createRequestScheduler, filterSummaries, finiteInteger, recentOptions, retryAfterMilliseconds } from './app-helpers.mjs';

const SERVICE = 'otel-png-observability-demo';
// Only attributes emitted by this application and safe to disclose in a public render.
// Platform source fields and all unknown/nested objects remain redacted by the adapter.
const RENDER_ATTRIBUTE_ALLOWLIST = Object.freeze([
  'bytes', 'count', 'events', 'ok', 'page', 'pages', 'status', 'step', 'steps',
  'target', 'wallMs', 'windowMs', 'workload_id', 'workload.id',
]);
const API_HEADERS = { 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' };
const RECENT_HEADERS = { ...API_HEADERS, 'cache-control': 'private, no-store, max-age=0' };
const PNG_HEADERS = { ...API_HEADERS, 'cache-control': 'private, no-store, max-age=0' };
const RECENT_CANDIDATE_LIMIT = 50;
const recentCache = new BoundedCoalescingCache({ maxEntries: 24, maxPending: 8, maxWeight: 24, ttlMs: 5_000 });
// Raw telemetry is shared across page renders but bounded independently from PNG bytes.
const telemetryCache = new BoundedCoalescingCache({ maxEntries: 12, maxPending: 4, maxWeight: 6_000, ttlMs: 30_000, weight: (value) => value.events.length });
const pngCache = new BoundedCoalescingCache({ maxEntries: 48, maxPending: 4, maxWeight: 24 * 1024 * 1024, ttlMs: 60_000, weight: (value) => value.bytes.byteLength });
const TARGETS = [
  'https://www.cloudflare.com/cdn-cgi/trace',
  'https://developers.cloudflare.com/cdn-cgi/trace',
  'https://one.one.one.one/cdn-cgi/trace',
];

function span(name, attrs, fn) {
  return tracing.enterSpan(name, (s) => {
    if (s.isTraced) s.setAttributes(attrs);
    return fn((more) => { if (s.isTraced) s.setAttributes(more); });
  });
}
function json(value, status = 200, headers = API_HEADERS) {
  return Response.json(value, { status, headers });
}
function problem(message, status = 400, headers) {
  return json({ error: message }, status, headers ? { ...API_HEADERS, ...headers } : API_HEADERS);
}
function capturedProfile(name, contentType, download = false) {
  const bytes = profileArtifact(name);
  if (!bytes) return problem('not found', 404);
  const headers = { ...API_HEADERS, 'cache-control': 'public, max-age=86400, immutable', 'content-type': contentType, 'x-otel-ping-profile-scope': 'synthetic-trace-local-node-profile-not-production-measurement' };
  if (download) headers['content-disposition'] = `attachment; filename="${name}"`;
  return new Response(bytes, { headers });
}
function credentials(env) {
  if (!env.CF_ACCOUNT_ID || !env.CF_API_TOKEN) throw new Error('observability credentials are not configured');
  return { accountId: env.CF_ACCOUNT_ID, token: env.CF_API_TOKEN };
}
async function telemetryAuthorization(request, env) {
  if (typeof env.TELEMETRY_AUTH_SECRET !== 'string' || env.TELEMETRY_AUTH_SECRET.length < 16) {
    return problem('account telemetry endpoints are disabled', 503);
  }
  const supplied = request.headers.get('authorization') ?? '';
  const expected = `Bearer ${env.TELEMETRY_AUTH_SECRET}`;
  const encode = (value) => new TextEncoder().encode(value);
  const [actualHash, expectedHash] = await Promise.all([
    crypto.subtle.digest('SHA-256', encode(supplied)),
    crypto.subtle.digest('SHA-256', encode(expected)),
  ]);
  const actual = new Uint8Array(actualHash), wanted = new Uint8Array(expectedHash);
  let difference = actual.length ^ wanted.length;
  for (let i = 0; i < Math.max(actual.length, wanted.length); i++) difference |= (actual[i] ?? 0) ^ (wanted[i] ?? 0);
  if (difference !== 0) return problem('authentication required', 401, { 'www-authenticate': 'Bearer realm="account-telemetry"' });
  return null;
}
function finiteInt(value, min, max, fallback) {
  return finiteInteger(value, { min, max, fallback });
}
async function expensiveAllowed(request, env) {
  const key = request.headers.get('cf-connecting-ip') ?? 'unknown';
  return env.EXPENSIVE_RATE_LIMITER ? await env.EXPENSIVE_RATE_LIMITER.limit({ key }) : { success: true };
}
function secureHtml(body) {
  return new Response(body, { headers: {
    'content-type': 'text/html; charset=utf-8',
    'cache-control': 'no-store',
    'content-security-policy': "default-src 'self'; img-src 'self' blob:; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
    'referrer-policy': 'no-referrer',
    'x-content-type-options': 'nosniff',
    'x-frame-options': 'DENY',
  } });
}

async function workload(request) {
  const length = Number(request.headers.get('content-length') ?? 0);
  if (!Number.isFinite(length) || length > 1024) return problem('body too large', 413);
  let body = {};
  if (length > 0) {
    const type = request.headers.get('content-type') ?? '';
    if (!type.startsWith('application/json')) return problem('content-type must be application/json', 415);
    try { body = await request.json(); } catch { return problem('invalid JSON'); }
  }
  const count = finiteInt(body.count, 1, 8, 3);
  const steps = finiteInt(body.steps, 0, 32, 0);
  if (count === null) return problem('count must be an integer from 1 to 8');
  if (steps === null) return problem('steps must be an integer from 0 to 32');
  const workloadId = crypto.randomUUID().replaceAll('-', '').slice(0, 16);
  const started = Date.now();
  const results = await span('workload.generate', { count, workload_id: workloadId }, async (set) => {
    const rows = await Promise.all(Array.from({ length: count }, (_, i) => span('workload.fetch', { target: i % TARGETS.length, workload_id: workloadId }, async (setFetch) => {
      const t0 = Date.now();
      const response = await fetch(`${TARGETS[i % TARGETS.length]}?otel-ping=${crypto.randomUUID()}`, {
        headers: { 'user-agent': 'otel-png-observability-demo' },
        signal: AbortSignal.timeout(5000),
      });
      const bytes = await span('workload.read', { workload_id: workloadId }, async (setRead) => {
        const size = (await response.arrayBuffer()).byteLength;
        setRead({ bytes: size });
        return size;
      });
      const row = { status: response.status, bytes, wallMs: Date.now() - t0 };
      setFetch(row);
      return row;
    })));
    // Optional bounded processing steps make it possible to exercise paged traces.
    for (let i = 0; i < steps; i++) await span(`workload.step.${i + 1}`, { workload_id: workloadId, step: i + 1 }, async () => {});
    set({ wallMs: Date.now() - started, ok: rows.filter((r) => r.status < 400).length, steps });
    return rows;
  });
  return json({ generatedAt: new Date().toISOString(), workloadId, count, steps, wallMs: Date.now() - started, results });
}

function cleanSummary(row) {
  if (!row || typeof row.traceId !== 'string' || !/^[a-f0-9]{32}$/i.test(row.traceId)) return null;
  const start = Number(row.traceStartMs), end = Number(row.traceEndMs), spans = Number(row.spans);
  if (![start, end, spans].every(Number.isFinite)) return null;
  return {
    traceId: row.traceId,
    // A trace may cross account services. This public app discloses only itself.
    services: [SERVICE],
    traceStartMs: start,
    // The render API requires a non-empty query window even for zero-duration spans.
    traceEndMs: Math.max(end, start + 1),
    traceDurationMs: Number(row.traceDurationMs) || Math.max(0, end - start),
    spans: Math.max(0, Math.trunc(spans)),
    errors: Array.isArray(row.errors) ? row.errors.length : Number(row.errors) || 0,
    // Root names may belong to another service in a distributed account trace.
    rootSpanName: null,
  };
}

async function recent(url, env) {
  let options;
  try { options = recentOptions(url.searchParams); } catch (error) { return problem(error.message); }
  // Five-second buckets make the bounded in-isolate cache useful without presenting old data as live.
  const to = Math.floor(Date.now() / 5_000) * 5_000, from = to - options.minutes * 60_000;
  const key = JSON.stringify({ ...options, to });
  const payload = await recentCache.get(key, async () => {
    const filters = options.scope === 'all' ? [] : [{ key: '$metadata.spanName', operation: 'eq', type: 'string', value: options.scope === 'workload' ? 'workload.generate' : 'observability.query.recent' }];
    const result = await span('observability.query.recent', { minutes: options.minutes, service: SERVICE, scope: options.scope }, async (set) => {
      const value = await runQuery({ ...credentials(env), body: recentTracesQuery({ from, to, limit: RECENT_CANDIDATE_LIMIT, service: SERVICE, filters }) });
      set({ traces: traceSummaries(value).length });
      return value;
    });
    const rows = traceSummaries(result).map(cleanSummary).filter(Boolean);
    return { platform: 'cloudflare-workers-observability', synthetic: false, from, to, filters: options, candidateLimit: RECENT_CANDIDATE_LIMIT, candidateCount: rows.length, traces: filterSummaries(rows, options) };
  });
  return json(payload, 200, RECENT_HEADERS);
}

async function renderSelected(url, env, traceId) {
  if (!/^[a-f0-9]{32}$/i.test(traceId)) return problem('invalid trace id');
  const from = finiteInt(url.searchParams.get('from'), 0, Number.MAX_SAFE_INTEGER, null);
  const to = finiteInt(url.searchParams.get('to'), 0, Number.MAX_SAFE_INTEGER, null);
  const now = Date.now();
  if (from === null || to === null || from >= to) return problem('valid from/to epoch milliseconds are required');
  if (to - from > 10 * 60_000 || from < now - 24 * 60 * 60_000 || to > now + 60_000) return problem('trace window is outside the allowed range');
  const page = finiteInt(url.searchParams.get('page'), 1, 100, 1);
  if (page === null) return problem('page must be an integer from 1 to 100');
  const traceKey = `${traceId}:${from}:${to}`;
  const cacheKey = `${traceKey}:${page}`;
  const rendered = await pngCache.get(cacheKey, async () => {
    const telemetry = await telemetryCache.get(traceKey, async () => {
      const events = await span('observability.query.trace', { windowMs: to - from }, async (set) => {
        const rows = await fetchTraceEvents({ ...credentials(env), traceId, from: from - 2000, to: to + 2000, limit: 501, maxPages: 2, maxEvents: 1001 });
        set({ events: rows.length });
        return rows;
      });
      if (events.length === 0) throw Object.assign(new Error('trace not found'), { publicStatus: 404 });
      if (events.length > 1000) throw Object.assign(new Error('trace exceeds the 1000 span render limit'), { publicStatus: 422 });
      if (events.some((e) => e?.$metadata?.traceId !== traceId || e?.$metadata?.type !== 'span')) throw Object.assign(new Error('trace not found'), { publicStatus: 404 });
      // Account traces can cross services. Render only this public app's spans;
      // unrelated service events must neither leak nor break an otherwise valid card.
      const serviceEvents = events.filter((e) => e?.$metadata?.service === SERVICE);
      if (serviceEvents.length === 0) throw Object.assign(new Error('trace not found'), { publicStatus: 404 });
      return {
        events: serviceEvents,
        otlp: eventsToOtlp(serviceEvents, { attributeMode: 'allowlist', attributeAllowlist: RENDER_ATTRIBUTE_ALLOWLIST, includeErrorMessage: false }),
        workloadIds: serviceEvents.filter((e) => e?.$metadata?.spanName === 'workload.fetch').map((e) => e?.source?.workload_id ?? e?.source?.workload?.id).filter(Boolean),
      };
    });
    return span('trace.render', { events: telemetry.events.length, page }, async (set) => {
      const opened = openTrace(telemetry.otlp, { compress: 'js', width: 1280, maxHeight: 960 });
      if (page > opened.pages) throw Object.assign(new Error('page is outside this trace'), { publicStatus: 404 });
      const chunks = [...opened.chunks(page - 1)];
      const bytes = new Uint8Array(chunks.reduce((n, chunk) => n + chunk.byteLength, 0));
      let offset = 0;
      for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
      if (!bytes.length) throw Object.assign(new Error('trace contained no renderable spans'), { publicStatus: 422 });
      set({ pages: opened.pages, bytes: bytes.byteLength });
      return { bytes, pages: opened.pages, spans: telemetry.events.length, workloadIds: telemetry.workloadIds };
    });
  }).catch((error) => error?.publicStatus ? error : Promise.reject(error));
  if (rendered instanceof Error) return problem(rendered.message, rendered.publicStatus, rendered.retryAfter ? { 'retry-after': String(rendered.retryAfter) } : undefined);
  const expectedWorkloadId = url.searchParams.get('workloadId');
  if (expectedWorkloadId !== null && !/^[a-f0-9]{16}$/.test(expectedWorkloadId)) return problem('invalid workload id');
  const workloadMatches = expectedWorkloadId === null ? 0 : rendered.workloadIds.filter((id) => id === expectedWorkloadId).length;
  const headers = { ...PNG_HEADERS, 'content-type': 'image/png', 'x-otel-png-source': 'cloudflare-workers-observability', 'x-otel-png-trace-id': traceId, 'x-otel-png-spans': String(rendered.spans), 'x-otel-png-pages': String(rendered.pages), 'x-otel-png-page': String(page), 'x-otel-png-workload-spans': String(rendered.workloadIds.length), 'x-otel-png-workload-match': String(workloadMatches) };
  if (url.searchParams.get('download') === '1') headers['content-disposition'] = `attachment; filename="otel-trace-${traceId}-page-${page}.png"`;
  return new Response(rendered.bytes, { headers });
}

const PROFILE_SOURCE_HASHES = JSON.stringify(PROFILE_METADATA.sourceHashes ?? {}).replace(/[&<>]/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[character]);
const PAGE = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>otel-ping</title><style>
:root{color-scheme:dark}*{box-sizing:border-box}body{background:#080808;color:#f5f5f5;font:14px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace;margin:0 auto;padding:24px;max-width:1600px}h1{font-size:22px;margin:0}h2{font-size:17px;margin:30px 0 10px}p{color:#aaa;max-width:110ch}a{color:#9cf}button,select,input{font:inherit;background:#fff;color:#000;border:1px solid #777;padding:7px 10px}button{cursor:pointer}button:disabled{opacity:.55;cursor:not-allowed}.controls{display:flex;flex-wrap:wrap;gap:9px;align-items:end;padding:12px;border:1px solid #333;background:#111;position:sticky;top:0;z-index:2}.controls label{display:grid;gap:3px;color:#bbb;font-size:12px}.controls button{height:35px}#cancel{background:#421;color:#fff}#status{color:#9cf;margin:10px 0;min-height:22px}#profiles,#traces{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:14px}.profile,.trace{min-width:0;border:1px solid #383838;padding:12px;background:#111;border-radius:5px}.profile{align-self:start}.profile>a{display:block;max-height:250px;overflow:auto;margin-top:7px}.profile img{margin-top:0}details{margin:8px 0;color:#999}summary{cursor:pointer}.trace-head{display:grid;gap:5px}.trace-id{font-size:12px;color:#ddd}.facts{display:flex;flex-wrap:wrap;gap:6px}.fact{background:#202020;border:1px solid #383838;padding:2px 6px;border-radius:10px;color:#ccc;font-size:12px}.pages,.actions{display:flex;flex-wrap:wrap;gap:7px;margin:8px 0}.pages button{background:#222;color:#fff;padding:4px 8px}.muted{color:#999}.error{color:#f99;min-height:22px}.error:empty{min-height:0}.viewport{min-height:220px;background:#0b0b0b;border:1px solid #333;display:grid;place-items:center;overflow:hidden}.loading{width:80%;height:12px;background:linear-gradient(90deg,#151515,#333,#151515);background-size:200% 100%;animation:pulse 1.2s infinite}.trace img,.profile img{display:block;width:100%;height:auto;border:1px solid #333;background:#080808}.trace img[hidden],.loading[hidden]{display:none}.actions a,.actions button{font-size:12px}.actions button{padding:2px 7px;background:#222;color:#fff}code{color:#ddd;overflow-wrap:anywhere}#more{margin-top:14px}.placeholder{height:310px}.placeholder .loading{margin:100px auto}@keyframes pulse{to{background-position:-200% 0}}@media(max-width:900px){#profiles,#traces{grid-template-columns:1fr}.controls{position:static}}@media(prefers-reduced-motion:reduce){.loading{animation:none}}
</style></head><body><h1>otel-png · authenticated platform trace sample</h1><p>This sample can generate bounded outbound Worker I/O to Cloudflare diagnostic endpoints (<code>www.cloudflare.com/cdn-cgi/trace</code>, <code>developers.cloudflare.com/cdn-cgi/trace</code>, and <code>one.one.one.one/cdn-cgi/trace</code>). Account telemetry listing and rendering require a separately configured application bearer secret and fail closed by default. Cloudflare credentials and the application secret stay in Worker secrets.</p><h2>CPU · pprof</h2><p><strong>Synthetic trace, local Node.js profile—not a production measurement.</strong> ${PROFILE_METADATA.pprofNonIdleSamples} non-idle samples · ${PROFILE_METADATA.estimatedSampledCpuMs} ms estimated sampled CPU · ${PROFILE_METADATA.profiledRenders} local renders. Click either image for full resolution. <a href="/profile/otel-ping-worker.pprof">Download pprof</a> · <a href="/profile/metadata.json">capture metadata</a>.</p><details><summary>Capture scope and source fingerprints</summary><p>Generated at ${PROFILE_METADATA.capturedAt} from deterministic <code>tools/synth.mjs</code> trace <code>${PROFILE_METADATA.targetTrace.traceId}</code>. No production telemetry or deployed Worker CPU was used. ${PROFILE_METADATA.configuredSamplingIntervalUs} µs configured sampling interval. OTel elapsed time is not CPU. <code>${PROFILE_SOURCE_HASHES}</code></p></details><div id="profiles"><article class="profile"><strong>pprof table</strong><a href="/profile/table.png" target="_blank"><img src="/profile/table.png" alt="Synthetic trace local Node.js CPU profile table"></a></article><article class="profile"><strong>pprof flame graph</strong><a href="/profile/flame.png" target="_blank"><img src="/profile/flame.png" alt="Synthetic trace local Node.js CPU profile flame graph"></a></article></div><h2>Authenticated account telemetry</h2><div class="controls"><label>Trace set<select id="scope"><option value="workload">Workload (default)</option><option value="observer">Observer traces (separate)</option><option value="all">All otel-ping</option></select></label><label>Minutes<input id="minutes" type="number" min="1" max="60" value="15"></label><label>Minimum spans<input id="minSpans" type="number" min="1" max="1000" value="3"></label><label>Errors<select id="errors"><option value="any">Any</option><option value="only">Errors only</option><option value="none">No errors</option></select></label><button id="generate">Generate workload</button><button id="refresh">Refresh gallery</button><button id="cancel" disabled>Cancel</button></div><div id="status" role="status" aria-live="polite">Ready.</div><div id="traces" aria-busy="false"></div><button id="more" hidden>Load 6 more</button><script>
const statusEl=document.querySelector('#status'),list=document.querySelector('#traces'),more=document.querySelector('#more'),cancel=document.querySelector('#cancel');
// Wrangler may preserve esbuild's function-name helper inside stringified helpers.
const __name=value=>value;
const createRequestScheduler=${createRequestScheduler.toString()},retryAfterMilliseconds=${retryAfterMilliseconds.toString()},createBlobUrlStore=${createBlobUrlStore.toString()};
const batchSize=6,pending=new Map(),imageJobs=[],blobs=createBlobUrlStore({maxEntries:50});let traces=[],shown=0,generation=0,activeImages=0,activeOperations=0,currentController=null;
const esc=s=>String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const sleep=(ms,signal)=>new Promise((resolve,reject)=>{const timer=setTimeout(resolve,ms);signal?.addEventListener('abort',()=>{clearTimeout(timer);reject(signal.reason??new DOMException('Cancelled','AbortError'));},{once:true});});
const scheduler=createRequestScheduler({onWait:(ms)=>{statusEl.textContent='Client budget is 18 requests per rolling minute; queued requests resume in '+Math.ceil(ms/1000)+'s…'}});
function busy(value){activeOperations=Math.max(0,activeOperations+(value?1:-1));const active=activeOperations>0;cancel.disabled=!active;document.querySelector('#refresh').disabled=active;document.querySelector('#generate').disabled=active;more.disabled=active;list.setAttribute('aria-busy',String(active))}function cancelBusy(){activeOperations=0;busy(false)}
async function api(url,options={},signal){for(let attempt=0;attempt<3;attempt++){await scheduler.permit(signal);let r;try{r=await fetch(url,{...options,signal})}catch(e){if(e.name==='AbortError'||attempt===2)throw e;const wait=Math.min(4000,500*2**attempt);statusEl.textContent='Network error; retry '+(attempt+2)+' of 3 in '+wait+' ms…';await sleep(wait,signal);continue}if(![429,502,503,504].includes(r.status)||attempt===2)return r;const wait=retryAfterMilliseconds(r.headers.get('retry-after'),Date.now(),Math.min(4000,500*2**attempt));statusEl.textContent='HTTP '+r.status+'; retry '+(attempt+2)+' of 3 in '+Math.ceil(wait/1000)+'s…';await sleep(wait,signal)}throw Error('Request retries exhausted')}
function traceKey(el){return el.dataset.id+':'+el.dataset.from+':'+el.dataset.to}function key(el,page){return traceKey(el)+':'+page}function owner(el){return el.dataset.owner}function releaseCards(){for(const el of list.querySelectorAll('.trace[data-owner]'))blobs.release(owner(el))}function revokeMissing(){const current=new Set(traces.map(t=>t.traceId+':'+t.traceStartMs+':'+t.traceEndMs));for(const [k,v] of blobs.entries)if(!current.has(v.traceKey))blobs.delete(k)}
function pngPath(el,page,download=false){return '/api/trace/'+encodeURIComponent(el.dataset.id)+'.png?from='+el.dataset.from+'&to='+el.dataset.to+'&page='+page+(download?'&download=1':'')}
function card(t){const when=new Date(t.traceStartMs);return '<article class="trace" data-owner="'+esc(t.traceId+':'+t.traceStartMs)+'" data-id="'+esc(t.traceId)+'" data-from="'+esc(t.traceStartMs)+'" data-to="'+esc(t.traceEndMs)+'"><div class="trace-head"><code class="trace-id">'+esc(t.traceId)+'</code><div class="facts"><span class="fact">'+esc(t.spans)+' spans</span><span class="fact">'+esc(t.errors)+' errors</span><span class="fact">'+esc(t.traceDurationMs)+' ms</span></div><time class="muted" datetime="'+esc(when.toISOString())+'">'+esc(when.toLocaleString())+' · '+esc(when.toISOString())+'</time></div><div class="pages"></div><div class="error">Queued to render page 1…</div><div class="viewport"><div class="loading" aria-label="Loading trace image"></div><img hidden alt="Rendered real Cloudflare platform trace '+esc(t.traceId)+'"></div><div class="actions"></div></article>'}
function showCached(el,page,v,cardGen,k){const img=el.querySelector('img'),loading=el.querySelector('.loading'),error=el.querySelector('.error'),path=pngPath(el,page);if(!v.owners.has(owner(el)))blobs.bind(owner(el),k);img.hidden=true;loading.hidden=false;img.onload=()=>{if(el.dataset.renderGeneration!==cardGen||!el.isConnected||img.src!==v.url)return;loading.hidden=true;error.textContent='';img.hidden=false};img.onerror=()=>{if(el.dataset.renderGeneration!==cardGen)return;img.hidden=true;loading.hidden=true;error.innerHTML='Image could not be displayed. <button data-retry="'+page+'">Retry</button>'};img.src=v.url;el.querySelector('.pages').innerHTML=Array.from({length:v.total},(_,i)=>'<button data-page="'+(i+1)+'"'+(i+1===page?' disabled':'')+'>Page '+(i+1)+' of '+v.total+'</button>').join('');el.querySelector('.actions').innerHTML='<a href="'+esc(v.url)+'" target="_blank">Open full resolution</a><a href="'+esc(path)+'" target="_blank">Direct PNG</a><a href="'+esc(path+'&download=1')+'" download>Download this page</a>'}
function pump(){while(activeImages<2&&imageJobs.length){const job=imageJobs.shift();if(job.signal.aborted){job.reject(job.signal.reason??new DOMException('Cancelled','AbortError'));continue}activeImages++;job.run().then(job.resolve,job.reject).finally(()=>{activeImages--;pump()})}}
function queued(run,signal){return new Promise((resolve,reject)=>{imageJobs.push({run,resolve,reject,signal});pump()})}
async function renderCard(el,page,gen,signal){const id=el.dataset.id,cardGen=String((Number(el.dataset.renderGeneration)||0)+1);el.dataset.renderGeneration=cardGen;const img=el.querySelector('img'),loading=el.querySelector('.loading'),errorEl=el.querySelector('.error'),hadImage=!img.hidden;img.onload=null;img.onerror=null;img.hidden=true;loading.hidden=false;const k=key(el,page),pendingKey=gen+':'+k,hit=blobs.get(k);if(hit){if(gen===generation&&el.dataset.renderGeneration===cardGen)showCached(el,page,hit,cardGen,k);return}errorEl.textContent='Querying telemetry and rendering page '+page+'…';let task=pending.get(pendingKey);if(!task){task=queued(async()=>{const r=await api(pngPath(el,page),{},signal);if(!r.ok){let x={};try{x=await r.json()}catch{}throw Error(x.error||'HTTP '+r.status)}const raw={traceKey:traceKey(el),url:URL.createObjectURL(await r.blob()),total:Number(r.headers.get('x-otel-png-pages'))||1};if(gen!==generation||!traces.some(t=>t.traceId===id)){URL.revokeObjectURL(raw.url);throw new DOMException('Cancelled','AbortError')}return blobs.put(k,raw,owner(el))},signal);pending.set(pendingKey,task);task.finally(()=>pending.delete(pendingKey)).catch(()=>{})}try{const value=await task;if(gen===generation&&el.isConnected&&el.dataset.renderGeneration===cardGen)showCached(el,page,value,cardGen,k)}catch(error){if(error.name==='AbortError'&&el.isConnected&&el.dataset.renderGeneration===cardGen){loading.hidden=true;img.hidden=!hadImage}else if(gen===generation&&el.isConnected&&el.dataset.renderGeneration===cardGen){img.hidden=true;loading.hidden=true;errorEl.innerHTML=esc(error.message)+' <button data-retry="'+page+'">Retry page</button>'}}}
async function showMore(gen=generation,signal=currentController?.signal){const end=Math.min(shown+batchSize,traces.length),added=traces.slice(shown,end);list.insertAdjacentHTML('beforeend',added.map(card).join(''));shown=end;more.hidden=shown>=traces.length;const cards=Array.from(list.querySelectorAll('.trace')).slice(-added.length);await Promise.allSettled(cards.map(el=>renderCard(el,1,gen,signal)));if(gen===generation)statusEl.textContent='Showing '+shown+' of '+traces.length+' real platform traces.'}
function query(){return new URLSearchParams({scope:document.querySelector('#scope').value,minutes:document.querySelector('#minutes').value,minSpans:document.querySelector('#minSpans').value,errors:document.querySelector('#errors').value})}
async function refresh(){currentController?.abort();releaseCards();currentController=new AbortController();const signal=currentController.signal,gen=++generation;busy(true);statusEl.textContent='Querying Cloudflare Observability…';list.innerHTML=Array.from({length:6},()=>'<article class="trace placeholder"><div class="loading" aria-label="Loading trace summary"></div></article>').join('');try{const r=await api('/api/traces?'+query(),{},signal),x=await r.json();if(!r.ok)throw Error(x.error||'HTTP '+r.status);if(gen!==generation)return;traces=x.traces;revokeMissing();shown=0;list.innerHTML='';more.hidden=true;if(!traces.length){list.innerHTML='<p>No matches in the bounded recent result (up to '+esc(x.candidateLimit)+' candidates). Workload is the default set; generate one, wait 15–60 seconds, or choose the separate observer set.</p>';statusEl.textContent='No matches among '+x.candidateCount+' bounded recent candidates.';return}await showMore(gen,signal);if(gen===generation)statusEl.textContent='Showing '+shown+' of '+traces.length+' matches from '+x.candidateCount+' bounded candidates.'}finally{if(gen===generation)busy(false)}}
async function generate(){currentController?.abort();currentController=new AbortController();const signal=currentController.signal;busy(true);try{statusEl.textContent='Generating traced workload…';const r=await api('/api/workload',{method:'POST',headers:{'content-type':'application/json'},body:'{"count":3}'},signal),x=await r.json();if(!r.ok)throw Error(x.error||r.status);statusEl.textContent='Generated '+x.count+' subrequests in '+x.wallMs+' ms; waiting 15 seconds for telemetry ingestion (Cancel is available)…';await sleep(15000,signal);await refresh()}finally{busy(false)}}
function operationSignal(){if(!currentController||currentController.signal.aborted)currentController=new AbortController();return currentController.signal}async function withControls(operation){const signal=operationSignal();busy(true);try{return await operation(signal)}finally{if(!signal.aborted)busy(false)}}
document.querySelector('#generate').onclick=()=>generate().catch(e=>{if(e.name!=='AbortError')statusEl.textContent=e.message});document.querySelector('#refresh').onclick=()=>refresh().catch(e=>{if(e.name!=='AbortError')statusEl.textContent=e.message});cancel.onclick=()=>{currentController?.abort();cancelBusy();statusEl.textContent='Cancelled. Existing rendered images remain available.'};more.onclick=()=>withControls(signal=>showMore(generation,signal)).catch(e=>{if(e.name!=='AbortError')statusEl.textContent=e.message});list.onclick=e=>{const b=e.target.closest('button[data-page],button[data-retry]');if(b){const page=Number(b.dataset.page??b.dataset.retry);withControls(signal=>renderCard(b.closest('.trace'),page,generation,signal)).catch(error=>{if(error.name!=='AbortError')statusEl.textContent=error.message})}};addEventListener('beforeunload',()=>{currentController?.abort();blobs.clear()});refresh().catch(e=>{if(e.name!=='AbortError')statusEl.textContent=e.message});
</script><p>Observer self-loop traces are kept separate from the default workload gallery.</p></body></html>`;

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    try {
      if (request.method === 'GET' && url.pathname === '/') return secureHtml(PAGE);
      if (request.method === 'GET' && url.pathname === '/health') return json({
        ok: true,
        service: SERVICE,
        source: 'cloudflare-workers-observability',
        deploymentId: env.CF_VERSION_METADATA?.id ?? null,
        deploymentTag: env.CF_VERSION_METADATA?.tag ?? null,
      });
      if (request.method === 'GET' && url.pathname === '/profile/otel-ping-worker.pprof') return capturedProfile('otel-ping-worker.pprof', 'application/octet-stream', true);
      if (request.method === 'GET' && url.pathname === '/profile/table.png') return capturedProfile('otel-ping-worker-table.png', 'image/png');
      if (request.method === 'GET' && url.pathname === '/profile/flame.png') return capturedProfile('otel-ping-worker-flame.png', 'image/png');
      if (request.method === 'GET' && url.pathname === '/profile/metadata.json') return json(PROFILE_METADATA);
      const traceList = request.method === 'GET' && url.pathname === '/api/traces';
      const match = request.method === 'GET' && url.pathname.match(/^\/api\/trace\/([a-f0-9]{32})\.png$/i);
      if (traceList || match) {
        const denied = await telemetryAuthorization(request, env);
        if (denied) return denied;
      }
      const expensive = (request.method === 'POST' && url.pathname === '/api/workload') || traceList || match;
      if (expensive && !(await expensiveAllowed(request, env)).success) return problem('rate limit exceeded', 429, { 'retry-after': '60' });
      if (request.method === 'POST' && url.pathname === '/api/workload') return await workload(request);
      if (traceList) return await recent(url, env);
      if (match) return await renderSelected(url, env, match[1]);
      return problem('not found', 404);
    } catch (error) {
      console.error('request failed', error instanceof Error ? error.message : 'unknown error');
      if (error?.publicStatus) return problem(error.message, error.publicStatus, error.retryAfter ? { 'retry-after': String(error.retryAfter) } : undefined);
      return problem('request failed', 502, { 'retry-after': '2' });
    }
  },
};
