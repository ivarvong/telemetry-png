// Writes examples/*.json: ten traces, each a different performance pathology.
// Times are milliseconds from trace start. n(service, name, start, end, attrs, children, extra)
import fs from 'node:fs';

const BASE = 1760100000000000000n;
const ns = (ms) => String(BASE + BigInt(Math.round(ms * 1e6)));
const av = (v) => (Number.isInteger(v) ? { intValue: String(v) } : typeof v === 'number' ? { doubleValue: v } : { stringValue: String(v) });
const attrs = (o) => Object.entries(o).map(([key, v]) => ({ key, value: av(v) }));
const n = (service, name, a, b, at = {}, kids = [], extra = {}) => ({ service, name, a, b, at, kids, ...extra });
const err = (message, event) => ({ error: message, event });

function toOtlp(root, traceId) {
  const by = new Map();
  let id = 0;
  const walk = (s, parent) => {
    const spanId = (++id).toString(16).padStart(16, '0');
    if (!by.has(s.service)) by.set(s.service, []);
    by.get(s.service).push({
      traceId, spanId, parentSpanId: parent, name: s.name, startTimeUnixNano: ns(s.a), endTimeUnixNano: ns(s.b),
      attributes: attrs(s.at), status: s.error ? { code: 2, message: s.error } : {},
      ...(s.event ? { events: [{ name: s.event.name, timeUnixNano: ns(s.event.at), attributes: attrs(s.event.at_ ?? {}) }] } : {}),
    });
    s.kids.forEach((k) => walk(k, spanId));
  };
  walk(root, '');
  return { resourceSpans: [...by].map(([svc, spans]) => ({ resource: { attributes: attrs({ 'service.name': svc }) }, scopeSpans: [{ spans }] })) };
}

const range = (k) => Array.from({ length: k }, (_, i) => i);
let seed = 7;
const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32);

const examples = {
  // 1. Forty sequential queries where one batched query would do.
  '01-n-plus-one': () => {
    let t = 6;
    const queries = range(40).map((i) => {
      const d = 2.2 + rnd() * 1.6;
      const q = n('postgres', 'SELECT * FROM line_items WHERE order_id=$1', t, t + d, { 'db.system': 'postgresql', 'db.rows': 1 + (i % 4), 'order.id': 9100 + i });
      t += d + 0.3;
      return q;
    });
    return n('orders-api', 'GET /orders', 0, t + 9, { 'http.route': '/orders', 'http.status_code': 200, 'orders.count': 40 }, [
      n('postgres', 'SELECT * FROM orders WHERE user_id=$1 LIMIT 40', 1, 5.4, { 'db.system': 'postgresql', 'db.rows': 40 }),
      ...queries,
      n('orders-api', 'serialize json', t + 0.5, t + 8.5, { 'response.bytes': 48211 }),
    ]);
  },

  // 2. Six parallel calls; total time is set by the one straggler.
  '02-fanout-straggler': () => {
    const call = (svc, d, at) => n(svc, `GET /${svc}`, 4, 4 + d, { 'http.status_code': 200, ...at }, [n(svc, 'handler', 5, 3 + d, {})]);
    return n('bff', 'GET /home', 0, 318, { 'http.route': '/home', 'http.status_code': 200 }, [
      n('bff', 'auth', 0.5, 3.5, { 'cache.hit': 'true' }),
      call('profile', 22, {}), call('feed', 61, { 'feed.items': 50 }), call('ads', 38, {}), call('notifications', 17, {}),
      n('recommendations', 'GET /recommendations', 4, 301, { 'http.status_code': 200, 'model.version': 'v41' }, [
        n('recommendations', 'feature fetch', 6, 31, { 'features.count': 212 }),
        n('recommendations', 'model inference', 32, 296, { 'model.batch': 1, 'gpu.queue_ms': 231, 'inference_ms': 33 }),
      ]),
      call('search-suggest', 44, {}),
      n('bff', 'render', 302, 317, { 'response.bytes': 91244 }),
    ]);
  },

  // 3. A failing dependency retried with exponential backoff; the backoff is the cost.
  '03-retry-backoff': () => {
    const attempt = (i, a, d, ok) => n('inventory-client', `POST /reserve attempt ${i}`, a, a + d, { 'http.status_code': ok ? 200 : 503, 'retry.attempt': i },
      [n('inventory', 'POST /reserve', a + 1, a + d - 1, { 'http.status_code': ok ? 200 : 503, 'pool.active': ok ? 12 : 64, 'pool.max': 64 }, [], ok ? {} : err('connection pool exhausted'))],
      ok ? {} : err('503 Service Unavailable'));
    return n('cart', 'POST /cart/checkout', 0, 1240, { 'http.status_code': 200, 'retry.policy': 'exp base=100ms x2' }, [
      n('cart', 'validate cart', 1, 9, { 'cart.items': 5 }),
      attempt(1, 10, 31, false), attempt(2, 141, 30, false), attempt(3, 371, 32, false), attempt(4, 803, 29, false), attempt(5, 1133, 96, true),
      n('cart', 'commit', 1230, 1239, {}),
    ]);
  },

  // 4. A cold start: most of the request happens before the handler runs.
  '04-cold-start': () => n('edge', 'GET /api/user', 0, 412, { 'http.status_code': 200, 'cold_start': 'true', 'colo': 'ORD' }, [
    n('runtime', 'isolate startup', 0.4, 388, { 'script.bytes': 4812331, 'compat.date': '2026-09-01' }, [
      n('runtime', 'fetch script bundle', 0.6, 96, { 'cache.hit': 'false', 'bytes': 4812331 }),
      n('runtime', 'parse + compile', 96, 301, { 'modules': 1184, 'bytes': 4812331 }),
      n('runtime', 'evaluate top-level', 301, 387, { 'modules': 1184 }, [
        n('runtime', 'init orm schema', 304, 361, { 'tables': 212 }),
        n('runtime', 'init i18n catalogs', 361, 384, { 'locales': 38 }),
      ]),
    ]),
    n('app', 'handler', 388.5, 411, {}, [n('kv', 'KV get user:812', 389, 409, { 'kv.hit': 'true', 'bytes': 912 })]),
  ]),

  // 5. Uninstrumented wait: the parent's own time is a lock nobody traced.
  '05-lock-contention': () => n('ledger', 'POST /transfer', 0, 2140, { 'http.status_code': 200, 'account.id': 'acct_77', 'lock.wait_ms': 1876 }, [
    n('ledger', 'validate', 1, 6, {}),
    n('postgres', 'BEGIN', 7, 8, { 'db.system': 'postgresql' }),
    n('postgres', 'SELECT balance FROM accounts WHERE id=$1 FOR UPDATE', 9, 1885, { 'db.system': 'postgresql', 'db.rows': 1, 'db.lock': 'RowExclusive', 'db.blocked_by_pid': 48213 }),
    n('postgres', 'UPDATE accounts SET balance=balance-$1', 1886, 1889, { 'db.rows': 1 }),
    n('postgres', 'INSERT INTO entries', 1890, 1893, { 'db.rows': 2 }),
    n('postgres', 'COMMIT', 1894, 2131, { 'db.system': 'postgresql', 'wal.fsync_ms': 229 }),
    n('ledger', 'publish event', 2132, 2139, {}),
  ]),

  // 6. Async handoff: the consumer starts long after the producer returned.
  '06-queue-lag': () => n('api', 'POST /videos', 0, 48, { 'http.status_code': 202, 'video.id': 'v_5512' }, [
    n('api', 'store upload', 2, 38, { 'bytes': 81234112, 'r2.bucket': 'uploads' }),
    n('api', 'enqueue transcode', 39, 46, { 'messaging.system': 'queues', 'queue': 'transcode' }, [
      n('transcoder', 'process transcode', 4310, 9420, { 'messaging.lag_ms': 4264, 'queue.depth': 912, 'consumer.concurrency': 2 }, [
        n('transcoder', 'download source', 4312, 4790, { 'bytes': 81234112 }),
        n('transcoder', 'ffmpeg 1080p', 4792, 7410, { 'codec': 'h264', 'frames': 7200, 'fps': 2.75 }),
        n('transcoder', 'ffmpeg 480p', 4792, 6105, { 'codec': 'h264', 'frames': 7200, 'fps': 5.48 }),
        n('transcoder', 'upload renditions', 7412, 9415, { 'bytes': 39112004, 'parts': 8 }),
      ]),
    ]),
  ]),

  // 7. One hung call at the bottom; every caller above it times out in turn. Nine services.
  '07-timeout-cascade': () => {
    const chain = ['web', 'api-gateway', 'orders', 'pricing', 'promotions', 'catalog', 'inventory', 'warehouse', 'legacy-erp'];
    const build = (i) => {
      const a = i * 3, timeout = 5000 - i * 250;
      const last = i === chain.length - 1;
      return n(chain[i], last ? 'SOAP GetStock' : `call ${chain[i + 1]}`, a, last ? 8000 : a + timeout, { 'timeout_ms': last ? 30000 : timeout, 'peer.service': last ? 'erp-db' : chain[i + 1] },
        last ? [n('legacy-erp', 'SELECT stock (full table scan)', a + 4, 7998, { 'db.system': 'oracle', 'db.rows_examined': 18400112, 'index.used': 'none' })] : [build(i + 1)],
        last ? {} : err(`deadline exceeded after ${timeout} ms`));
    };
    return build(0);
  },

  // 8. A wide GraphQL query: many small resolvers, one of them unbatched.
  '08-graphql-resolvers': () => {
    const authors = range(12).map((i) => n('users', 'User.byId', 31 + i * 9.2, 31 + i * 9.2 + 8.4, { 'user.id': 300 + i, 'dataloader': 'false' }));
    return n('graphql', 'query Feed', 0, 151, { 'graphql.operation': 'Feed', 'graphql.depth': 4, 'graphql.fields': 96 }, [
      n('graphql', 'parse + validate', 0.3, 2.1, { 'query.bytes': 1820 }),
      n('graphql', 'Query.feed', 2.4, 29, {}, [n('posts', 'Posts.recent', 3, 28, { 'db.rows': 12, 'cache.hit': 'false' })]),
      n('graphql', 'Post.author x12', 30, 142, { 'resolver.calls': 12, 'batched': 'false' }, authors),
      n('graphql', 'Post.likeCount x12', 30, 44, { 'resolver.calls': 12, 'batched': 'true' }, [n('likes', 'Likes.countMany', 31, 43, { 'ids': 12, 'redis.cmd': 'MGET' })]),
      n('graphql', 'Post.commentPreview x12', 30, 68, { 'resolver.calls': 12, 'batched': 'true' }, [n('comments', 'Comments.previewMany', 31, 67, { 'ids': 12, 'db.rows': 36 })]),
      n('graphql', 'serialize', 143, 150, { 'response.bytes': 28114 }),
    ]);
  },

  // 9. Connection setup on a microsecond scale: where one HTTPS request's latency sits.
  '09-connection-setup': () => n('client', 'GET https://api.example.com/v1/status', 0, 187.4, { 'http.status_code': 200, 'http.version': '2', 'net.reused': 'false' }, [
    n('client', 'dns lookup', 0.2, 41.9, { 'dns.resolver': '10.0.0.2', 'dns.cache_hit': 'false', 'dns.answers': 2 }),
    n('client', 'tcp connect', 42.0, 71.3, { 'net.peer.ip': '203.0.113.9', 'rtt_ms': 29 }),
    n('client', 'tls handshake', 71.4, 162.8, { 'tls.version': '1.2', 'tls.resumed': 'false', 'tls.round_trips': 2, 'cert.chain_bytes': 5822 }, [
      n('client', 'verify certificate chain', 131.2, 162.1, { 'ocsp.stapled': 'false', 'ocsp.fetch_ms': 27 }),
    ]),
    n('client', 'send request', 162.9, 163.05, { 'bytes': 412 }),
    n('client', 'wait for first byte', 163.05, 186.2, { 'server.timing': 'app;dur=1.8' }),
    n('client', 'read body', 186.2, 187.3, { 'bytes': 2210 }),
  ]),

  // 10. A batch job in seconds: eight parallel partitions, one of them skewed.
  '10-batch-skew': () => {
    const rows = [1.1, 0.9, 1.2, 1.0, 14.8, 1.1, 0.8, 1.0];
    return n('etl', 'nightly rollup 2026-10-09', 0, 61800, { 'job.id': 'rollup-8812', 'partitions': 8, 'workers': 8 }, [
      n('etl', 'plan', 50, 900, { 'input.files': 412 }),
      n('etl', 'extract', 950, 6400, { 'bytes': 9211442004, 'input.files': 412 }),
      n('etl', 'transform', 6450, 57200, { 'shuffle.partitions': 8 }, rows.map((m, i) =>
        n('etl-worker', `partition ${i}`, 6500, 6500 + m * 3400, { 'rows': Math.round(m * 1e6), 'key.top': i === 4 ? 'tenant=acme (93%)' : 'uniform', 'spill.bytes': i === 4 ? 6120443 * 1024 : 0 },
          i === 4 ? [n('etl-worker', 'spill to disk', 21000, 49800, { 'spill.files': 212, 'memory.limit_mb': 4096 })] : []))),
      n('warehouse', 'load', 57250, 61700, { 'rows': 21900000, 'copy.files': 8 }),
    ]);
  },
};

for (const [name, build] of Object.entries(examples)) {
  const id = [...name].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7).toString(16).padStart(8, '0').repeat(4);
  fs.writeFileSync(new URL(`../examples/${name}.json`, import.meta.url), JSON.stringify(toOtlp(build(), id), null, 1));
}
console.log(Object.keys(examples).length, 'examples written');
