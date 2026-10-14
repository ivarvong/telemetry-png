# Generated examples

The ten JSON/PNG pairs are synthetic OpenTelemetry traces illustrating named performance pathologies. They contain no production captures or third-party data.

`tools/make-examples.mjs` is the source of the JSON fixtures. It uses a fixed timestamp base and deterministic PRNG seed. Regenerate the pairs from the repository root with:

```sh
node tools/make-examples.mjs
for json in examples/*.json; do
  node otel-png-cli.mjs "$json" "${json%.json}.png"
done
```

The checked-in PNGs are deterministic renderings with the CLI defaults. Review JSON and PNG changes together.

## SHA-256

```text
09d8dc0d3de0366c29ec5a6ca0f7d5dc4b0bc3ee17d9ed91b0df8f62e7f088fc  01-n-plus-one.json
26f78f8ea09e8743f05e4e45b65990ff8c183bcac64b0fa4fc40b4fd7ba767ca  01-n-plus-one.png
7a65ba084d955789ee36cb9bed35c747b098169ec69000e4f92b619d42415947  02-fanout-straggler.json
215820e1fed51b255b74f0ee557b36ea0886e4f67390fc9c9b437a5432dbc3dc  02-fanout-straggler.png
d09e96ec3c64785455893befb5fe0626c61396b4e024844eec4967e2bba0825c  03-retry-backoff.json
3bbc1a115267d9c1e0091e5109574c7d598ca7d21cb832fa5170cbfb90662308  03-retry-backoff.png
678aed0414982eee873de0da56061b224ee5bf8ac4b597f8aa173846c57ef1c4  04-cold-start.json
7ad509740069006d44338c5c978c8bb7b3a77384ab9dae89ec8a5ba133284cc8  04-cold-start.png
615d7e6409244747b2efb36e0204df2ff125d99ac471b4b78d2601dd9065ab28  05-lock-contention.json
63637efcd021a7a2959554e7f5155f6c57f003b8c0055d05def2b3379b163d27  05-lock-contention.png
ee4f2d90dac0260d3b7887252c9cb08cebdc852d73c039c0621d18ddb5b14f9b  06-queue-lag.json
3fac54534a4e39fc0411e70b2c46e155563c0fb63208033ac648af85e37a171d  06-queue-lag.png
1361a3614f583840e75f1c8affde16e31a4cb8e9c9841e6eacaab76be3ac9a29  07-timeout-cascade.json
7ade3da00c4e4073fc5806ab105fa7150f7bc31ceddaea2e6b2f5309034c8128  07-timeout-cascade.png
4aea5aa9d19df8a681780822ee4265dc68cfbb9d88ebd849514255c6a63d26ea  08-graphql-resolvers.json
3a445bf4df7f718dd2119427a368d259a1a8a03d9594a923c0adeba232b0ea5e  08-graphql-resolvers.png
23870eee34cd5e998403481d0f190c261f4c3bfce19f117f2ec830f407012ae0  09-connection-setup.json
88ea9da10400e310e84377be79423cca9807623962394e043bb79805fe58517f  09-connection-setup.png
6bc0bc896c9853880b5fc9263866486825fadd802c066f32507aa89636e55a0b  10-batch-skew.json
c9454acf5f30f6a3023adbfbafa662469cfafc96a65343d7738b58145fd7fbe0  10-batch-skew.png
```
