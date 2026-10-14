// Writes sample-trace.json: a checkout request across three services, with a failed payment.
import fs from 'node:fs';
const ms = (n) => String(1760000000000000000n + BigInt(Math.round(n * 1e6)));
const attrs = (o) => Object.entries(o).map(([key, v]) => ({ key, value: typeof v === 'number' ? { intValue: String(v) } : { stringValue: v } }));
const span = (id, parent, name, a, b, at = {}, extra = {}) => ({
  traceId: '5b8efff798038103d269b633813fc60c', spanId: id, parentSpanId: parent, name,
  startTimeUnixNano: ms(a), endTimeUnixNano: ms(b), attributes: attrs(at), status: {}, ...extra,
});
const err = (message) => ({ status: { code: 2, message } });
const res = (svc, spans) => ({ resource: { attributes: attrs({ 'service.name': svc }) }, scopeSpans: [{ spans }] });
const trace = { resourceSpans: [
  res('edge-gateway', [
    span('a1', '', 'GET /api/checkout', 0, 182, { 'http.method': 'GET', 'http.route': '/api/checkout', 'http.status_code': 502, 'cf.colo': 'EWR', 'user.tier': 'pro' }),
    span('a2', 'a1', 'auth.verify_jwt', 2, 9.5, { 'jwt.alg': 'ES256', 'cache.hit': 'false' }),
    span('a3', 'a1', 'ratelimit.check', 9.6, 10.1, { 'ratelimit.remaining': 118 }),
    span('a4', 'a1', 'fetch checkout-svc', 11, 180, { 'http.url': 'https://checkout.internal/checkout', 'http.status_code': 502 }),
  ]),
  res('checkout-svc', [
    span('b1', 'a4', 'POST /checkout', 14, 178, { 'http.route': '/checkout', 'http.status_code': 502, 'cart.items': 3 }),
    span('b2', 'b1', 'cart.load', 15, 41, { 'db.system': 'postgresql', 'db.rows': 3, 'cache.hit': 'false' }),
    span('b3', 'b1', 'pricing.compute {tax, shipping, discounts}', 42, 77, { 'pricing.rules_evaluated': 412, 'region': 'US-NY' }),
    span('b4', 'b1', 'payments.charge', 78, 171, { 'rpc.system': 'grpc', 'rpc.method': 'Charge', 'amount.cents': 12999 }, err('payments: 402')),
    span('b7', 'b1', 'emit order.created ~async', 172, 176, { 'messaging.system': 'queues', 'messaging.batch_size': 1 }),
  ]),
  res('payments', [
    span('c1', 'b4', 'POST /charge', 80, 169, { 'http.route': '/charge', 'http.status_code': 402, 'idempotency.key': 'ord_8841' }, err('402 from stripe')),
    span('c2', 'c1', 'db.query SELECT * FROM cards WHERE id=$1', 81, 88, { 'db.system': 'postgresql', 'db.rows': 1, 'db.pool.wait_ms': 4 }),
    span('c3', 'c1', 'stripe.create_intent', 89, 140, { 'http.url': 'https://api.stripe.com/v1/payment_intents', 'http.status_code': 200, 'net.peer.region': 'us-west-2', 'tls.resumed': 'false' }),
    span('c4', 'c1', 'stripe.confirm [retry #2]', 141, 168, { 'http.status_code': 402, 'retry.count': 2, 'retry.backoff_ms': 8 }, {
      ...err('card_declined: insufficient_funds'),
      events: [{ name: 'exception', timeUnixNano: ms(166), attributes: attrs({ 'exception.type': 'StripeCardError' }) }],
    }),
    span('c5', 'zz', 'orphan: café lookup', 150, 150.0004),
  ]),
] };
fs.writeFileSync(new URL('../sample-trace.json', import.meta.url), JSON.stringify(trace, null, 1));
