# pprof test fixtures

These files are oracle fixtures for `pprof-render/test/`:

- `cpu.pprof` and `mem.pprof` are gzip-compressed pprof protobuf profiles.
- `*.raw.txt`, `*.top*.txt`, and `*.traces.txt` are `go tool pprof` views of those same profiles. Tests compare the local decoder and aggregation code with the raw and top views.

## Provenance supported by the files

The embedded profile metadata and oracle text identify the profiled executable as `json.test`, build ID `0ea318d70b7f04478ca966780a61893ec899a1a9`, running Go's `encoding/json` benchmarks. Source paths embedded in both profiles and the raw views begin with `/usr/local/go1.24.7/src/`, which identifies Go 1.24.7. The CPU profile starts at `2026-10-10 15:18:31 -0400` and reports a 111.31 second duration; the memory profile is timestamped `2026-10-10 15:20:25 -0400`.

The original shell command, benchmark flags, host details, and exact `go tool pprof` command lines were not retained. The filenames and output formats strongly indicate `-raw`, `-top`, and `-traces`, but they are evidence of output type rather than a record of the exact historical invocation.

## Regeneration guidance

To replace the fixtures, use a recorded Go toolchain and run the `encoding/json` benchmarks with CPU and memory profiling enabled. Then produce matching oracle views with `go tool pprof`:

```sh
# Example workflow; record the exact flags and `go version` used for replacements.
go test -run='^$' -bench=. -cpuprofile=cpu.pprof -memprofile=mem.pprof encoding/json
go tool pprof -raw cpu.pprof >cpu.raw.txt
go tool pprof -top cpu.pprof >cpu.top.txt
go tool pprof -traces cpu.pprof >cpu.traces.txt
go tool pprof -raw mem.pprof >mem.raw.txt
go tool pprof -sample_index=alloc_space -top mem.pprof >mem.top.alloc_space.txt
go tool pprof -sample_index=alloc_space -traces mem.pprof >mem.traces.txt
```

This is a reproducible replacement recipe, not a claim that these exact commands created the checked-in files. Profile samples, timestamps, build IDs, addresses, and text formatting can vary with the Go version and platform. Update the tests and hashes deliberately when replacing them.

## SHA-256

```text
7d5a213a38cb1302380db808beb69c0d50341a0f2dc3eb012fd93b982cd2f66f  cpu.pprof
24f92898441de6466371abc16a92f5d0429b89b3efc397fbaa74679867fa44cf  cpu.raw.txt
e574478b8619865279f3cef2c0ef8fd8e3ed2499379787056735b87065fc6759  cpu.top.txt
59ce277b7f3828f1243f8399ae5469b4af0f3a618099d4d26666e70d8372f4c6  cpu.traces.txt
703c0854a8ac89b4bf6e9b89bb4df6cf96f84ec3235216745a9156a980acfd25  mem.pprof
b3b64feb89c38ff41c7a6409e52f9c57514bbdf76e118523dc562efd8a14b77d  mem.raw.txt
ecc08fd22257c529e58f8123ec827b447192b144aa65a9fe182b3d8a0bd47714  mem.top.alloc_space.txt
62e1b9f5a73057619f33957670a4c8c80ad002dcdde21ca585ea2b85649ac918  mem.traces.txt
```

Verify from this directory with `shasum -a 256 cpu.pprof cpu.raw.txt cpu.top.txt cpu.traces.txt mem.pprof mem.raw.txt mem.top.alloc_space.txt mem.traces.txt`.
