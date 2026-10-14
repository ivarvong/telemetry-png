#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")/../worker-bench"
PORT="${PORT:-$((18000 + RANDOM % 10000))}"
LOG="$(mktemp)"
TMP="$(mktemp -d)"
AUTH_SECRET="local-smoke-only-secret"
env -u CLOUDFLARE_API_TOKEN npx --no-install wrangler dev --local --port "$PORT" --var "TELEMETRY_AUTH_SECRET:$AUTH_SECRET" >"$LOG" 2>&1 &
PID=$!
cleanup() { kill "$PID" 2>/dev/null || true; wait "$PID" 2>/dev/null || true; rm -rf "$LOG" "$TMP"; }
trap cleanup EXIT
for _ in $(seq 1 60); do
  if curl -fsS "http://127.0.0.1:$PORT/health" >"$TMP/health.json" 2>/dev/null; then break; fi
  if ! kill -0 "$PID" 2>/dev/null; then cat "$LOG" >&2; exit 1; fi
  sleep 0.5
done
node -e "const x=require(process.argv[1]); if(!x.ok||x.source!=='cloudflare-workers-observability')process.exit(1)" "$TMP/health.json"
[ "$(curl -sS -o /dev/null -w '%{http_code}' -X POST -H 'content-type: application/json' --data '{\"count\":99}' "http://127.0.0.1:$PORT/api/workload")" = 400 ]
# Account telemetry routes require application authentication before parsing query input.
[ "$(curl -sS -o /dev/null -w '%{http_code}' "http://127.0.0.1:$PORT/api/traces?minutes=999")" = 401 ]
[ "$(curl -sS -o /dev/null -w '%{http_code}' "http://127.0.0.1:$PORT/api/trace/00000000000000000000000000000000.png?from=1&to=2")" = 401 ]
[ "$(curl -sS -o /dev/null -w '%{http_code}' -H "authorization: Bearer $AUTH_SECRET" "http://127.0.0.1:$PORT/api/traces?minutes=999")" = 400 ]
[ "$(curl -sS -o /dev/null -w '%{http_code}' -H "authorization: Bearer $AUTH_SECRET" "http://127.0.0.1:$PORT/api/traces?scope=account")" = 400 ]
[ "$(curl -sS -o /dev/null -w '%{http_code}' -H "authorization: Bearer $AUTH_SECRET" "http://127.0.0.1:$PORT/api/traces?minSpans=0")" = 400 ]
[ "$(curl -sS -o /dev/null -w '%{http_code}' "http://127.0.0.1:$PORT/api/trace/not-a-trace.png")" = 404 ]
curl -fsS "http://127.0.0.1:$PORT/" | grep -q 'Observer self-loop'
curl -sS -D "$TMP/profile-headers.txt" -o /dev/null "http://127.0.0.1:$PORT/profile/table.png"
grep -qi '^cache-control: public,' "$TMP/profile-headers.txt"
curl -fsS "http://127.0.0.1:$PORT/profile/otel-ping-worker.pprof" > "$TMP/profile.pprof"
curl -fsS "http://127.0.0.1:$PORT/profile/table.png" > "$TMP/profile.png"
curl -fsS "http://127.0.0.1:$PORT/profile/metadata.json" > "$TMP/profile.json"
node -e "const fs=require('fs'); const p=fs.readFileSync(process.argv[1]), png=fs.readFileSync(process.argv[2]), m=require(process.argv[3]); if(p.length<1000||png.subarray(0,8).toString('hex')!=='89504e470d0a1a0a'||m.targetTrace?.synthetic!==true||!m.scope.includes('NOT A PRODUCTION MEASUREMENT'))process.exit(1)" "$TMP/profile.pprof" "$TMP/profile.png" "$TMP/profile.json"
echo "local smoke: health, auth fail-closed behavior, abuse bounds, and synthetic profile artifacts passed on port $PORT"
