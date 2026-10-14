import { otlp } from '../test/helpers.mjs';
import { renderTraceSync } from '../otel-png.mjs';
import fs from 'node:fs';
const D = process.argv[2];
const out = (n, t, o = {}) => fs.writeFileSync(`${D}/${n}.png`, renderTraceSync(t, { maxHeight: Infinity, ...o }));
// 1. non-Latin names
out('w1-cjk', otlp(['api', 'GET /用户/订单', 0, 120, { attrs: { 'http.route': '/ユーザー/注文', 'user.name': 'Zoë Ångström 😀' } }, [
  ['db', 'SELECT * FROM 订单 WHERE 状态 = ?', 10, 80, { attrs: { 'db.statement': 'SELECT … WHERE name = "Müller"' } }], ['cache', 'получить сессию', 80, 110]]]));
// 2. 12 services: palette has 7 hues
const svc = Array.from({ length: 12 }, (_, i) => `service-${String.fromCharCode(97 + i)}`);
out('w2-12-services', otlp(['gateway', 'POST /checkout', 0, 400, {}, svc.map((s, i) => [s, `${s}.handle`, 20 + i * 25, 60 + i * 25 + (i % 3) * 20])]));
// 3. clock skew across services: child starts before parent and ends after
out('w3-skew', otlp(['edge', 'GET /', 100, 200, {}, [['origin', 'render', 80, 260, {}, [['db', 'query', 90, 150], ['db', 'query', 120, 300]]]]]));
// 4. tiny spans in a long one, microsecond scale
out('w4-micro', otlp(['svc', 'request', 0, 2000, {}, [['svc', 'parse', 0, 0.004], ['svc', 'auth', 0.004, 0.02], ['svc', 'handler', 0.02, 1999.9, {}, [['svc', 'tick', 5, 5.001]]]]]));
// 5. very long names/attributes
const long = 'x'.repeat(300);
out('w5-long', otlp(['api', 'GET /' + 'segment/'.repeat(30), 0, 90, { attrs: { 'url.full': 'https://example.com/' + long, 'http.request.header.cookie': long.slice(0, 200), a: 1, b: 2, c: 3, d: 4, e: 5, f: 6, g: 7, h: 8 } }]));
