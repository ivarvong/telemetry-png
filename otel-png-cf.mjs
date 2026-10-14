// otel-png-cf.mjs — Cloudflare Workers Observability telemetry -> OTLP JSON.
// Zero dependencies; `fetch` is injectable so this runs in Workers, Node and tests.
//
//   const events = await fetchTraceEvents({ accountId, token, traceId, from, to });
//   const png = await renderTrace(eventsToOtlp(events));
//
// The event schema below is verified against a sanitized real `otel` dataset
// response captured from Cloudflare Workers Observability (2026-10-12).

const API = 'https://api.cloudflare.com/client/v4';

// Where each OTLP field is read from. First non-empty candidate wins.
export const FIELD = {
  traceId: ['$metadata.traceId'], // documented
  spanId: ['$metadata.spanId'], // documented
  parentSpanId: ['$metadata.parentSpanId', 'source.parentSpanId'],
  name: ['$metadata.spanName', 'source.name'],
  start: ['$metadata.startTimeNs', '$metadata.startTime', 'source.startTime'],
  end: ['$metadata.endTimeNs', '$metadata.endTime', 'source.endTime'],
  service: ['$metadata.service', 'source.service.name'],
  error: ['source.error', 'source.exception.message'],
};

const get = (obj, path) => path.split('.').reduce((o, k) => (o == null ? o : o[k]), obj);
const pick = (obj, paths) => {
  for (const p of paths) {
    // `$metadata.x` contains a dot only as a separator; keys themselves never do.
    const v = get(obj, p);
    if (v !== undefined && v !== null && v !== '') return v;
  }
  return undefined;
};

// Epoch time in unknown units -> nanoseconds as a decimal string (OTLP's uint64 form).
// Epoch milliseconds are about 1.8e12, microseconds 1.8e15, nanoseconds 1.8e18.
export function toUnixNano(t) {
  if (t == null || t === '') return null;
  let n;
  try {
    if (typeof t === 'bigint') n = t;
    else if (typeof t === 'string' && /^\d+$/.test(t)) n = BigInt(t);
    else {
      const number = Number(t);
      if (!Number.isFinite(number)) return null;
      n = BigInt(Math.round(number));
    }
  } catch { return null; }
  if (n <= 0n) return null;
  if (n < 10n ** 14n) return String(n * 1_000_000n); // ms
  if (n < 10n ** 17n) return String(n * 1_000n); // us
  return String(n); // ns
}

// ---------- querying ----------

// The request body for "all events of one trace". Cursor pagination is added by the caller.
export function traceEventsQuery({ traceId, from, to, limit = 1000 }) {
  return {
    queryId: `otel-png-${traceId}`,
    view: 'events',
    limit,
    timeframe: { from, to }, // epoch milliseconds, from < to
    dry: true,
    parameters: {
      datasets: ['otel'],
      filters: [
        { key: '$metadata.traceId', operation: 'eq', type: 'string', value: traceId },
        { key: '$metadata.type', operation: 'eq', type: 'string', value: 'span' },
      ],
      filterCombination: 'and',
    },
  };
}

// The summaries of recent traces, to choose one to render.
export function recentTracesQuery({ from, to, limit = 50, service, filters = [] }) {
  const allFilters = service ? [{ key: '$metadata.service', operation: 'eq', type: 'string', value: service }, ...filters] : filters;
  return { queryId: 'otel-png-recent', view: 'traces', limit, dry: true, timeframe: { from, to }, parameters: { datasets: ['otel'], filters: allFilters, filterCombination: 'and' } };
}

export function traceSummaries(result) {
  const rows = Array.isArray(result?.traces) ? result.traces : result?.traces?.traces;
  return Array.isArray(rows) ? rows : [];
}

export async function runQuery({ accountId, token, body, fetch: f = globalThis.fetch, signal = AbortSignal.timeout(10_000) }) {
  const res = await f(`${API}/accounts/${accountId}/workers/observability/telemetry/query`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal,
  });
  const json = await res.json();
  if (!res.ok || json.success === false) {
    throw new Error(`telemetry query failed: ${res.status} ${JSON.stringify(json.errors ?? json).slice(0, 300)}`);
  }
  return json.result;
}

// All events of a trace. Cursor pagination: offset = the last event's $metadata.id.
// Stops on a short page, an empty page, or a repeated cursor; never loops forever.
export async function fetchTraceEvents({ accountId, token, traceId, from, to, limit = 1000, maxPages = 50, maxEvents = 1000, fetch: f, signal }) {
  const events = [];
  let offset;
  for (let page = 0; page < maxPages && events.length < maxEvents; page++) {
    const pageLimit = Math.min(limit, maxEvents - events.length);
    const body = traceEventsQuery({ traceId, from, to, limit: pageLimit });
    if (offset) Object.assign(body, { offset, offsetDirection: 'next' });
    const result = await runQuery({ accountId, token, body, fetch: f, signal });
    const batch = result?.events?.events ?? [];
    events.push(...batch.slice(0, pageLimit));
    const next = batch.at(-1)?.$metadata?.id;
    if (batch.length < pageLimit || !next || next === offset) break;
    offset = next;
  }
  return events;
}

// ---------- mapping ----------

const attrValue = (v) =>
  typeof v === 'number' ? (Number.isInteger(v) ? { intValue: String(v) } : { doubleValue: v })
  : typeof v === 'boolean' ? { boolValue: v }
  : { stringValue: v };

// Conservative defaults retain useful operation/result measurements, but no identifiers,
// URLs, hosts, headers, object keys, hashes, account data, or arbitrary nested source data.
// Callers may replace this list with app-owned fields they have reviewed.
export const SAFE_ATTRIBUTE_PATHS = Object.freeze([
  'cloudflare.execution_model', 'cloudflare.handler_type', 'cloudflare.outcome',
  'cloudflare.r2.operation', 'cloudflare.r2.request.size',
  'cloudflare.r2.response.size', 'cloudflare.r2.response.success',
  'http.request.method', 'http.response.status_code', 'http.response.body.size',
  'network.protocol.name', 'network.protocol.version',
  'cpu_time_ms', 'wall_time_ms', 'durationMS',
]);

// Extract exact, explicitly reviewed scalar paths. This deliberately does not recurse:
// objects and arrays can hide credentials or user data and are therefore redacted.
function attributes(source, allowlist) {
  if (source == null || typeof source !== 'object') return [];
  const out = [];
  for (const key of allowlist) {
    if (typeof key !== 'string' || !key) continue;
    const value = get(source, key);
    if (typeof value === 'string' || typeof value === 'boolean' || (typeof value === 'number' && Number.isFinite(value))) {
      out.push({ key, value: attrValue(value) });
    }
  }
  return out;
}

// Cloudflare events -> OTLP JSON. Source attributes use allowlist mode only. Error
// presence is preserved, while its potentially sensitive message is redacted by default.
// Events with no spanId or no usable times are counted in `dropped`, not guessed at.
export function eventsToOtlp(events, { onDrop, attributeMode = 'allowlist', attributeAllowlist = SAFE_ATTRIBUTE_PATHS, includeErrorMessage = false } = {}) {
  if (attributeMode !== 'allowlist') throw new TypeError('Cloudflare source attributes require allowlist mode');
  if (!Array.isArray(attributeAllowlist)) throw new TypeError('attributeAllowlist must be an array');
  const byService = new Map();
  let dropped = 0;
  for (const e of events) {
    const spanId = pick(e, FIELD.spanId);
    const start = toUnixNano(pick(e, FIELD.start));
    const end = toUnixNano(pick(e, FIELD.end));
    if (!spanId || !start || !end) { dropped++; onDrop?.(e); continue; }
    const service = String(pick(e, FIELD.service) ?? 'unknown');
    const error = pick(e, FIELD.error);
    const span = {
      traceId: String(pick(e, FIELD.traceId) ?? ''),
      spanId: String(spanId),
      parentSpanId: String(pick(e, FIELD.parentSpanId) ?? ''),
      name: String(pick(e, FIELD.name) ?? '(span)'),
      startTimeUnixNano: start,
      endTimeUnixNano: end,
      attributes: attributes(e.source, attributeAllowlist),
      status: error ? { code: 2, ...(includeErrorMessage ? { message: typeof error === 'string' ? error : JSON.stringify(error) } : {}) } : {},
    };
    if (!byService.has(service)) byService.set(service, []);
    byService.get(service).push(span);
  }
  const otlp = {
    resourceSpans: [...byService].map(([svc, spans]) => ({
      resource: { attributes: [{ key: 'service.name', value: { stringValue: svc } }] },
      scopeSpans: [{ spans }],
    })),
  };
  Object.defineProperty(otlp, 'dropped', { value: dropped, enumerable: false });
  return otlp;
}
