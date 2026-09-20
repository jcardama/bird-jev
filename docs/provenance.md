# Provenance

Bird-JEV builds on the recovered Bird source. The command remains `bird`. The original MIT license is retained.

## Recovery

Recovered on 2026-09-20:

- Original repository: https://github.com/steipete/bird (public API returned 404; this does not distinguish deletion from a private repository).
- Full source and history mirror: https://github.com/rymalia/bird.git (`upstream`).
- Compiled-only fallback: https://github.com/Oceanswave/bird.git (`npm-rescue`), commit `90ead61c96d1794dfa7a4563f66f04cbaffd263f`.
- Published artifact: https://registry.npmjs.org/@steipete/bird/-/bird-0.8.0.tgz
- Verified artifact integrity: `sha512-p7+a9a/olzf1Rxe56a51VMFoBlFQpFVosC5B8dB3rOT8UbSZ3Ey5eXCZoLDjKXDf8xKINvSmGtMAd3yjeE4Gcw==`
- License: MIT, copyright Peter Steinberger. Keep `LICENSE`.

The recovered 0.8.0 baseline is commit `6ae239383c0692b0dc96ea07de42d5b17d6ee2a3`. That commit matches npm's `gitHead` for `@steipete/bird@0.8.0`. Original history contains 329 commits through that release.

## 0.8.1 and 0.8.2

The 0.8.2 maintenance work adopted recovered 0.8.1 at `d5301055f44cb88c6b0a6cc4dcdc39bd88887656` from `rymalia/bird`, including the four thread-filter flags. Its offline baseline passed 440 tests. No later upstream development branch is included.

Version 0.8.2 keeps the `bird` executable, authentication environment variables, configuration paths, and library API. JEV capabilities are planned and are not part of this release. See `docs/releasing.md` for staging and publication bounds.

The confirmed search defect was a bottom cursor in `TimelineReplaceEntry` on page two. Bird previously read only `TimelineAddEntries` and stopped after 40 posts.

## Reproduce the 0.8.0 baseline

Run these commands at commit `6ae239383c0692b0dc96ea07de42d5b17d6ee2a3`, not at current HEAD. Use Node ≥22 and pnpm 10.11.0. pnpm 11 ignores `package.json`'s `pnpm.patchedDependencies` and fails a frozen install. Do not rewrite this release's lockfile to work around that.

```sh
pnpm install --frozen-lockfile --ignore-scripts
pnpm run build:dist
BIRD_LIVE=0 pnpm exec vitest run --exclude 'tests/live/**'
node dist/cli.js --version
```

Recovery verification: the build passed. 421 tests passed across 52 files. All 210 rebuilt `dist/` files matched the integrity-verified npm archive byte-for-byte. Live tests were excluded. No credentials were copied into the checkout.

Use `build:dist` for local development. The inherited binary build uses `--env=BIRD_*`. Do not run it in an environment that contains Bird credentials.
