// otel-png-tracer.mjs — a zero-dependency tracer that emits OTLP JSON.
//
// span(name, fn, attrs) times fn (sync or async). fn receives a child `span`, so
// parentage is passed explicitly rather than read from ambient state. `attrs` is a
// plain object read when the span ends, so fn can fill it in as it learns things.
// span.open(name, attrs) is the primitive, for work that outlives one call.
// On Workers, performance.now() only advances across I/O, so CPU-only spans read 0.

export function createTracer(service) {
  const epoch0 = BigInt(Date.now()) * 1_000_000n;
  const perf0 = performance.now();
  const now = () => epoch0 + BigInt(Math.round((performance.now() - perf0) * 1e6));
  const hex = (n) =>
    Array.from(crypto.getRandomValues(new Uint8Array(n)), (b) => b.toString(16).padStart(2, '0')).join('');
  const traceId = hex(16);
  const done = [];

  const under = (parentSpanId) => {
    // open() is the primitive, for work that outlives one call (a generator).
    const open = (name, attrs) => {
      const s = { traceId, spanId: hex(8), parentSpanId, name, kind: 1, startTimeUnixNano: String(now()) };
      const end = (err) => {
        s.endTimeUnixNano = String(now());
        if (attrs) {
          s.attributes = Object.entries(attrs).map(([key, v]) => ({
            key,
            value: Number.isInteger(v) ? { intValue: String(v) } : typeof v === 'number' ? { doubleValue: v } : { stringValue: String(v) },
          }));
        }
        s.status = err ? { code: 2, message: String(err) } : {};
        done.push(s);
      };
      return { span: under(s.spanId), end };
    };
    const span = (name, fn, attrs) => {
      const s = open(name, attrs);
      try {
        const r = fn(s.span);
        if (r instanceof Promise) return r.then((v) => (s.end(), v), (e) => { s.end(e); throw e; });
        s.end();
        return r;
      } catch (e) {
        s.end(e);
        throw e;
      }
    };
    span.open = open;
    return span;
  };

  const toOtlp = () => ({
    resourceSpans: [{
      resource: { attributes: [{ key: 'service.name', value: { stringValue: service } }] },
      scopeSpans: [{ scope: { name: 'otel-png' }, spans: done }],
    }],
  });

  return { span: under(''), toOtlp };
}

export const untraced = (_name, fn) => fn(untraced);
untraced.open = () => ({ span: untraced, end() {} });
