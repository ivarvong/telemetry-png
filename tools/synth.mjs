// A deterministic synthetic trace of n spans across six services.
export function synth(n, seed = 1) {
  let x = seed;
  const rnd = () => ((x = (x * 1664525 + 1013904223) >>> 0) / 2 ** 32);
  const base = 1760000000000000000n;
  const svcs = ['edge', 'api', 'auth', 'db', 'cache', 'queue'];
  const bySvc = new Map(svcs.map((s) => [s, []]));
  const spans = [{ id: 0, parent: '', a: 0, b: 1e9, depth: 0 }];
  bySvc.get('edge').push(spans[0]);
  for (let i = 1; i < n; i++) {
    const p = spans[Math.max(0, i - 1 - Math.floor(rnd() * 12))];
    const span = p.b - p.a;
    const a = p.a + rnd() * span * 0.8;
    const s = { id: i, parent: p.id, a, b: a + rnd() * (p.b - a) * 0.6, depth: p.depth + 1 };
    spans.push(s);
    bySvc.get(svcs[Math.floor(rnd() * svcs.length)]).push(s);
  }
  const hex = (i) => i.toString(16).padStart(16, '0');
  return {
    resourceSpans: [...bySvc].map(([svc, ss]) => ({
      resource: { attributes: [{ key: 'service.name', value: { stringValue: svc } }] },
      scopeSpans: [{ spans: ss.map((s) => ({
        traceId: 'feedfacefeedfacefeedfacefeedface', spanId: hex(s.id + 1), parentSpanId: s.parent === '' ? '' : hex(s.parent + 1),
        name: `op.${s.id % 37}.handler/${s.id}`, startTimeUnixNano: String(base + BigInt(Math.round(s.a))),
        endTimeUnixNano: String(base + BigInt(Math.round(s.b))), status: s.id % 53 === 7 ? { code: 2 } : {},
      })) }],
    })),
  };
}
