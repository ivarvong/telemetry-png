# Test fixture provenance

## `cf-events.real.json`

This is a reviewed, sanitized derivative of a real Cloudflare Workers Observability trace response. It preserves the response shape needed by `test/cf.test.mjs`, but identifying and sensitive values were replaced with designated synthetic values. In particular, trace/span IDs, service and script names, version and invocation IDs, object keys, hashes, hosts, Ray IDs, timestamps, and selected numeric values are fixtures rather than trustworthy facts about the original workload. The top-level `real: true` means the schema originated in an actual API response; it does not mean every retained value is original.

The raw capture is intentionally not retained. `tools/cf-capture.mjs` documents how to capture a replacement into a protected temporary file. A maintainer must then manually review and sanitize it before replacing this file. `tools/lint.mjs` enforces the current synthetic identifiers and checks for several credential-like or known original values, but passing lint is not a substitute for manual disclosure review.

Current SHA-256:

```text
477a0b4b08a3e453ea9a5414718abd6322b12ec26c4a30f9cc734a4c7984e29e  cf-events.real.json
```

Verify from this directory with `shasum -a 256 cf-events.real.json`.
