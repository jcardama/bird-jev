# Testing

## Offline verification (default)

Use Node ≥22 and the project-pinned pnpm 10.11.0:

```sh
pnpm run check
```

The check runs `build:dist`, Vitest with `--exclude 'tests/live/**'`, then `lint`. It sets `BIRD_LIVE=0` for each child, even if the calling environment enables live tests. Stages run serially; Vitest retains its normal test parallelism. GitHub Actions uses the same command on pull requests and pushes to `main`.

Each stage prints a start line and a pass or failure line. Successful tool output stays quiet. Failed stdout and stderr are replayed in full, and the check stops with the failing command's exit code. Launch errors and signal termination also fail the check. Output is captured in temporary files and removed after completion; failure output remains in the terminal or CI log. Output is not automatically redacted, so tests and tools must never print credentials.

Invoke the runner through `pnpm run check`, not directly with Node. It uses pnpm's supplied JavaScript CLI entry to invoke the existing package scripts without shell command strings. It does not install dependencies, load credential files, update query IDs, build the standalone binary, or contact X as a verification step. The distribution build writes `dist/`.

## Focused checks

Run only the relevant tests while developing, then run the full check before handoff:

```sh
pnpm exec vitest run tests/search-pagination.test.ts --exclude 'tests/live/**'
pnpm run build:dist
pnpm run lint
```

The individual commands show normal tool output. Plain `pnpm test` remains available, but it includes live test files and relies on their environment guards. Use the explicit live-folder exclusion for offline work.

## npm artifact verification (registry-backed)

```sh
pnpm run check:package
```

This separate gate contacts the public npm registry to acquire consumer dependencies. It is not part of the offline `check` command or Vitest discovery. CI runs it after the offline check on Node 22.

It packs the safe distribution, inspects the actual tarball, proves the bundled sweet-cookie patch survives, and installs that exact artifact in an isolated consumer outside the checkout. It exercises the installed executable, ESM API, and TypeScript declarations. Saved-post analysis runs through the real engine and SDK with mocked fetch and synthetic credentials. No X, paid JEV, browser, or Keychain access is part of the gate.

Use `--output /absolute/external/directory` to retain the artifact and receipt in a fresh directory. Use `--tarball /absolute/path/package.tgz` to test an already-packed artifact without rebuilding it, including on a second Node version. Reuse requires its original adjacent receipt and matching source commit, and verifies its digest before execution. Neither mode changes the global installation. See [Releases](releasing.md) for the publication boundary and exact-artifact workflow.

Packaging policy and patched-provider regression tests belong in the ordinary offline suite, using synthetic archives and mocked OS/database/Keychain boundaries. Real browser decryption on macOS is not implied by these tests. The provider fixture uses built-in SQLite; that suite skips on older Node 22 minors where the builtin is unavailable. The current Node 22 CI runtime runs it.

## Release automation verification (offline)

```sh
pnpm exec vitest run tests/package-release.test.ts --exclude 'tests/live/**'
```

The release tests parse the real `publish.yml` workflow and execute its actual inline publishing logic with mocked filesystem, registry, process, and timer boundaries. No real `npm publish`, OIDC exchange, credential access, GitHub mutation, X request, or paid JEV call is allowed. The VM is a test seam for trusted code, not a security sandbox.

Coverage includes release identity, clean receipts, exact artifact bytes, permissions and artifact handoff, existing-version idempotency, newer-`latest` rejection, registry errors, and bounded visibility checks after one publish attempt. Validate workflow syntax with `actionlint` as well. These checks do not establish that npm's external trusted-publisher setting is configured; the first authorized release is the integration test of that setting. See [Releases](releasing.md) for setup and recovery.

## Live tests (separately authorized)

These suites run the CLI against real X GraphQL endpoints. They contain both read checks and opt-in mutations, including follow/unfollow, likes, retweets, and bookmarks. They are not a read-only verification gate. Obtain separate authorization for the exact live operations; none are part of `pnpm run check` or CI.

Requirements:
- Auth cookies in env:
  - `AUTH_TOKEN` (or `TWITTER_AUTH_TOKEN`)
  - `CT0` (or `TWITTER_CT0`)
- Network access

Run:
- `pnpm test:live`
- `pnpm bird following --all --max-pages 2 --json --cookie-source chrome --chrome-profile Default`
- `pnpm bird list-timeline <list-id> --all --max-pages 2 --json --cookie-source chrome --chrome-profile Default`
- `pnpm bird search "from:steipete" --all --max-pages 2 --json --cookie-source chrome --chrome-profile Default`
- `pnpm bird home --count 5 --json --cookie-source chrome --chrome-profile Default`
- `pnpm bird home --count 5 --following --json --cookie-source chrome --chrome-profile Default`

Notes:
- Live tests are skipped unless `BIRD_LIVE=1` (set by `pnpm test:live`).
- Search query is configurable via `BIRD_LIVE_SEARCH_QUERY`.
- Follow/unfollow handle is configurable via `BIRD_LIVE_FOLLOW_HANDLE` (opt-in).
- Command timeout is configurable via `BIRD_LIVE_TIMEOUT_MS` (ms).
- Cookie extraction timeout is configurable via `BIRD_LIVE_COOKIE_TIMEOUT_MS` (ms).
- Spawned CLI `NODE_ENV` defaults to `production` (override with `BIRD_LIVE_NODE_ENV`).
- If you don't tweet, set `BIRD_LIVE_TWEET_ID` to a known tweet ID to use for `read/replies/thread`.
- Long-form article coverage: set `BIRD_LIVE_LONGFORM_TWEET_ID` to a known article tweet ID (example: `2007184284944322584` from @X; refresh by finding a tweet with `article` via `bird user-tweets X -n 20 --json`).
- Optional: set `BIRD_LIVE_BOOKMARK_FOLDER_ID` to exercise `bookmarks --folder-id`.
- `bird query-ids --fresh` live coverage: set `BIRD_LIVE_QUERY_IDS_FRESH=1`.
- The live suite may hit internal X endpoints (v1.1 REST) as fallback; it still uses cookie auth (no developer API key).
