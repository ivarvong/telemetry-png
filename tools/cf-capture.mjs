// Capture a RAW Cloudflare telemetry response, to turn the UNVERIFIED fields in
// otel-png-cf.mjs into a real fixture. Prints JSON to stdout; nothing is rewritten.
//
//   CF_ACCOUNT_ID=... CF_API_TOKEN=... node tools/cf-capture.mjs --list            # recent trace summaries (view: traces)
//   CF_ACCOUNT_ID=... CF_API_TOKEN=... node tools/cf-capture.mjs <traceId>         # that trace's span events (view: events)
// Redirect raw captures only to a protected temporary file. Commit only a reviewed,
// sanitized fixture (test/fixtures/cf-events.real.json).
//
// The token needs the Workers Observability permission. The Workers must have
// observability.traces.enabled = true, and the trace must be within the 7-day retention.
import { runQuery, traceEventsQuery, recentTracesQuery } from '../otel-png-cf.mjs';

const { CF_ACCOUNT_ID: accountId, CF_API_TOKEN: token } = process.env;
if (!accountId || !token) { console.error('set CF_ACCOUNT_ID and CF_API_TOKEN'); process.exit(2); }
const arg = process.argv[2];
if (!arg) { console.error('usage: cf-capture.mjs --list | <traceId>'); process.exit(2); }

const to = Date.now(), from = to - 6 * 3600 * 1000; // bounded capture window
const body = arg === '--list' ? recentTracesQuery({ from, to }) : traceEventsQuery({ traceId: arg, from, to });
console.log(JSON.stringify(await runQuery({ accountId, token, body }), null, 2));
