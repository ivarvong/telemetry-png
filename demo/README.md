# Demo artifacts

These are locally generated demonstration and stress-case artifacts, not external captures.

- `stress.mjs` generates the five `w*.png` edge cases deterministically.
- `hero.mjs` renders page 1 of a synthetic 1,000-span workload while tracing the renderer; it writes `self-page1.json` and renders that trace as `hero.png`.

Regenerate from the repository root with:

```sh
node demo/stress.mjs demo
node demo/hero.mjs demo
```

The stress PNGs are deterministic. The self-trace contains measured durations and current timestamps, so `self-page1.json` and `hero.png` are expected to change between runs and environments.

## Current SHA-256

```text
070dfcea2ba1986971c9abc79c6aecb09e1f880cdfe3b6ae98b79390df884e03  hero.mjs
5dd6062ab8129e8f8a25197690d5670d1b90b6f4f4f3db0efd9ac370d8387f7b  hero.png
db4f594a77b0b8599c85511b928b22d3394caa31ade9605ae7e4e1c5613c74a7  self-page1.json
eec4f299ec033a0555473146cfaf6f6fdf12507dc75620a97bacf494d13c3e31  stress.mjs
e488f895faf22248929521b2c17ee96a80bdf020555b46a42212b23d24b0e357  w1-cjk.png
4b67ca879add53696210017341398a5e07d9c1039a4b65ca72fc7633b6448dbd  w2-12-services.png
6a7c46cdacb4a4f3d42a42c41057326473d0a392a0056c52f1f0e9a4249cc06e  w3-skew.png
6c606e9b4736ad6b9dba8a3fe5308ed0edb2bce57abd41bc04258f8b89cf2418  w4-micro.png
82575da45e88e3151907a85db6a6c9ffffba1f9c321f96f19943914355b6432a  w5-long.png
```
