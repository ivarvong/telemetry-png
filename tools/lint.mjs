import fs from 'node:fs';

const library = fs.readdirSync('.').filter((name) => /^otel-png.*\.mjs$/.test(name) && name !== 'otel-png-cli.mjs');
const errors = [];
for (const file of library) {
  const source = fs.readFileSync(file, 'utf8');
  if (/from ['"]node:/.test(source)) errors.push(`${file}: library files may not import node modules`);
}
const worker = fs.readFileSync('worker-bench/worker.mjs', 'utf8');
for (const required of ["head_sampling_rate = 1", "EXPENSIVE_RATE_LIMITER", "CF_API_TOKEN", "maxEvents: 1001", "maxPages: 2", "events.length > 1000", "e?.$metadata?.service === SERVICE", "attributeMode: 'allowlist'", "attributeAllowlist: RENDER_ATTRIBUTE_ALLOWLIST", "includeErrorMessage: false", "retry-after", "BoundedCoalescingCache"]) {
  const haystack = required.includes('head_') ? fs.readFileSync('worker-bench/wrangler.toml', 'utf8') : worker;
  if (!haystack.includes(required)) errors.push(`missing required safety/tracing control: ${required}`);
}
const fixtureText = fs.readFileSync('test/fixtures/cf-events.real.json', 'utf8');
if (/authorization|cookie|api[_-]?token|secret/i.test(fixtureText)) errors.push('real fixture contains a credential-like key');
for (const leaked of ['metar-cache-worker', 'aviationweather.gov', '16a8346e77d7a8ca4c6e929bf9fb755d', 'd631d905-56c8-4a2c-8311-98008e4b8c14']) {
  if (fixtureText.includes(leaked)) errors.push(`real fixture contains unsanitized value: ${leaked}`);
}
let fixture;
try { fixture = JSON.parse(fixtureText); } catch (error) { errors.push(`real fixture is invalid JSON: ${error.message}`); }
if (fixture) {
  const events = fixture?.events?.events;
  const traceId = fixture?.summary?.traceId;
  const spanIds = new Set();
  if (traceId !== '0123456789abcdef0123456789abcdef') errors.push('real fixture must use the designated synthetic trace id');
  if (!Array.isArray(events) || events.length !== fixture?.summary?.spans) errors.push('real fixture span count does not match its summary');
  for (const [index, event] of (events ?? []).entries()) {
    const metadata = event?.$metadata ?? {};
    const source = event?.source ?? {};
    if (!/^[0-9a-f]{16}$/.test(metadata.spanId ?? '') || spanIds.has(metadata.spanId)) errors.push(`fixture event ${index} has an invalid or duplicate synthetic span id`);
    spanIds.add(metadata.spanId);
    if (metadata.traceId !== traceId || source.traceId !== traceId || source.spanId !== metadata.spanId) errors.push(`fixture event ${index} has inconsistent trace/span ids`);
    if (metadata.service !== 'fixture-worker' || source?.service?.name !== 'fixture-worker' || source?.faas?.name !== 'fixture-worker') errors.push(`fixture event ${index} has an unsanitized service`);
    if (source?.cloudflare?.script_version?.id !== '00000000-0000-4000-8000-000000000001' || source?.faas?.version !== '00000000-0000-4000-8000-000000000001') errors.push(`fixture event ${index} has an unsanitized version id`);
    const r2 = source?.cloudflare?.r2;
    if (r2?.request?.key && !/^synthetic-object-\d+\.bin$/.test(r2.request.key)) errors.push(`fixture event ${index} has an unsanitized R2 key`);
    const expectedHash = `${index + 1}`.padStart(32, '0');
    if (r2?.response?.etag && (r2.response.etag !== expectedHash || r2.response?.checksum?.md5 !== expectedHash)) errors.push(`fixture event ${index} has an unsanitized R2 hash`);
    if (source?.server?.address && !source.server.address.endsWith('.invalid')) errors.push(`fixture event ${index} has a non-reserved host`);
    if (source?.cloudflare?.ray_id && !/^0{16}(?:-SJC)?$/.test(source.cloudflare.ray_id)) errors.push(`fixture event ${index} has an unsanitized Ray id`);
    if (source?.faas?.invocation_id && source.faas.invocation_id !== '00000000000000000000000000000001') errors.push(`fixture event ${index} has an unsanitized invocation id`);
  }
  for (const [index, event] of (events ?? []).entries()) {
    const parent = event?.$metadata?.parentSpanId;
    if (parent && (!spanIds.has(parent) || event.source.parentSpanId !== parent)) errors.push(`fixture event ${index} has an inconsistent parent relationship`);
  }
}
if (errors.length) { console.error(errors.join('\n')); process.exit(1); }
console.log(`lint: ${library.length} library modules, Worker safety controls, and sanitized fixture passed`);
