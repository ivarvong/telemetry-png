# telemetry-png

Dependency-free JavaScript renderers for turning telemetry into compact PNGs:

- **`otel-png`** renders OTLP/JSON traces as paginated timelines or one tall image.
- **`pprof-png`** renders gzip-compressed or raw pprof protobuf profiles as a table or flame graph.

The renderers use baked fonts and indexed-color PNGs. The trace library has no Node imports and can run in modern web-runtime environments such as Cloudflare Workers.

> [!WARNING]
> This is an experimental `0.x` project. Rendering, layout, defaults, and APIs may change. Treat generated images as diagnostic views, not as lossless replacements for source telemetry. In particular, profile values are sampled estimates and converted Chrome CPU profiles are not request wall time or span duration.

## Requirements

Node.js 20 or newer is supported for the library, command-line tools, and core development suite. Local Worker smoke tests require Node.js 22 or newer because the pinned Wrangler version requires it. Runtime use outside Node requires Web Streams plus `CompressionStream`/`DecompressionStream`; trace rendering can instead select the synchronous JavaScript compressor with `compress: 'js'`.

## Trace rendering

From a checkout, run the existing `otel-png` CLI (no install required):

```sh
git clone https://github.com/ivarvong/telemetry-png.git
cd telemetry-png
node otel-png-cli.mjs trace.otlp.json trace.png
```

The package and CLI retain the name `otel-png`; this repository release does not publish an npm package.

The input is OTLP trace JSON. If the trace needs several pages, the command writes `trace-01.png`, `trace-02.png`, and so on.

Useful options:

```text
--tall                 render one tall image
--max-height N         maximum logical page height (default: 960)
--width N              logical width (default: 1280)
--scale 1|2            device pixels per logical pixel (default: 1)
--fold N               fold N or more identical leaf siblings (default: 5; 0 disables)
--no-detail            omit attribute detail lines
--compress stream|js   platform or pure-JS compression
--trace self.json      emit the renderer's own OTLP trace
```

The JavaScript API returns PNG bytes as `Uint8Array` values:

```js
import { readFile, writeFile } from 'node:fs/promises';
import { renderTrace, renderTracePages, openTrace } from './otel-png.mjs';

const otlp = JSON.parse(await readFile('trace.otlp.json', 'utf8'));

// One tall PNG.
await writeFile('trace.png', await renderTrace(otlp));

// Vision-model-sized pages (1280x960 logical pixels by default).
const pages = await renderTracePages(otlp);
await Promise.all(pages.map((png, i) => writeFile(`trace-${i + 1}.png`, png)));

// Stream a page without collecting the complete PNG in memory.
const trace = openTrace(otlp);
const response = new Response(trace.stream(0));
```

Synchronous counterparts (`renderTraceSync` and `renderTracePagesSync`) use the pure-JavaScript compressor. See the exports in [`otel-png.mjs`](./otel-png.mjs) for the complete API and options.

## pprof rendering

The pprof renderer currently lives in this repository and is not exported by the `otel-png` npm package. From a checkout, render a profile with:

```sh
node pprof-render/bin/pprof-png.mjs cpu.pprof cpu-table.png
node pprof-render/bin/pprof-png.mjs cpu.pprof cpu-flame.png --view flame
```

Options include `--view table|flame`, `--text summary.txt`, `--type alloc_space`, `--width N`, `--max-height N`, `--font N`, and `--no-collapse`. Both gzip-compressed and raw pprof protobuf inputs are accepted.

A Chrome DevTools Protocol CPU profile can be converted first:

```sh
node pprof-render/tools/cpuprofile-to-pprof.mjs cpu.cpuprofile cpu.pprof
```

The pprof modules can also be imported directly from [`pprof-render/src/index.js`](./pprof-render/src/index.js), including `parseProfile`, `profileTable`, `flameGraph`, `summary`, and `renderFlamePNG`.

## Development

The library has no runtime dependencies. Install the pinned development toolchain exactly as recorded in `package-lock.json`, then run the complete local gate on Node.js 22 or newer:

```sh
npm ci
npm run check
```

Individual commands are available for focused work:

```sh
npm run check:core    # typecheck, lint, and tests; supports Node.js 20+
npm run typecheck
npm run lint
npm test
npm run smoke:local   # local Worker smoke; requires Node.js 22+
npm run golden       # intentionally updates trace golden hashes
```

`smoke:local` uses the locally installed, pinned Wrangler without downloading another version. Deployment and production smoke scripts are optional and are not required for library development.

### Optional Cloudflare demo

`worker-bench/` is a sample Worker, not production deployment configuration. Choose your own Worker name in `worker-bench/wrangler.toml`. Account telemetry listing and rendering are disabled unless `TELEMETRY_AUTH_SECRET` (at least 16 characters), `CF_ACCOUNT_ID`, and `CF_API_TOKEN` are configured as Worker secrets. Requests to telemetry routes require `Authorization: Bearer <TELEMETRY_AUTH_SECRET>`. Use a random application secret and a least-privilege Cloudflare token; never commit either.

The gallery currently requires an injected authorization header (there is no login form). Its bounded workload generator sends outbound requests to Cloudflare diagnostic endpoints; it is rate-limited but public. The embedded profile is from local Node.js renders of a synthetic trace, **not** a production Worker measurement. Regenerate it with `node tools/capture-profile.mjs`.

Browser smoke requires Playwright installed locally or `PLAYWRIGHT_PATH`. Font-generation tools require Python with Pillow (and fontTools for the pprof atlas). The optional evaluation pilot requires `pi` and its TypeBox extension dependency; evaluation data is synthetic and no private research results are included.

## License

The project is available under the [MIT License](./LICENSE). The baked Commit Mono font data is distributed under the SIL Open Font License 1.1; see [third-party notices](./THIRD_PARTY_NOTICES.md).
