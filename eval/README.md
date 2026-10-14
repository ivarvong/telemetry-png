# eval/ — optional research harness

`png-json-pilot/` is a small evaluation pilot that asks a model to diagnose synthetic traces and profiles given as raw JSON, analyzed JSON, PNG pages, or PNG plus an on-request JSON tool, and scores the answers.

It is **not part of the `otel-png` package** and is not needed to use, build or test the renderers. The core test suite only checks its input builder and scorer (`test/eval-pilot.test.mjs`), which need neither `pi` nor `typebox`.

Running it requires:

- the `pi` coding-agent CLI on `PATH` (POSIX only), configured for a model (`PI_PROVIDER`, `PI_MODEL`, `PI_REASONING_LEVEL`), and
- the `typebox` package, which `hybrid-tool.ts` (a `pi` extension) imports; it is not a dependency of this repository.

Inputs are synthetic; no private research results are included. Outputs go to `artifacts/png-json-pilot/` (gitignored) by default:

```sh
node eval/png-json-pilot/build-inputs.mjs
node eval/png-json-pilot/run-pilot.mjs
node eval/png-json-pilot/score-results.mjs
```
