# Bird-JEV releases

Publishing is separate from verification and local installation. Obtain explicit authorization before pushing source/tags, opening a PR, publishing to npm, creating a GitHub release, or changing repository visibility. The npm package is `bird-jev`; the executable remains `bird`. Publishing does not authorize merging a PR or replacing an existing installation.

## Verify a candidate

Use Node ≥22 and pnpm 10.11.0. Preserve the lockfile and sweet-cookie patch.

```sh
pnpm install --frozen-lockfile --ignore-scripts
pnpm run check
```

`check` builds the distribution, runs offline tests, and lints. It does not test the npm artifact. Live tests are excluded because upstream includes mutations. Obtain separate authorization for bounded live probes. Do not print or persist session cookies, read credential files into logs, update query IDs, or invoke the Bun binary build during verification: `build:binary` embeds `BIRD_*` variables.

## Verify the npm artifact

Run the separate registry-backed gate:

```sh
pnpm run check:package --output /absolute/external/artifact-directory
```

Use a fresh directory outside the checkout; existing artifacts and receipts are never overwritten. The gate isolates npm configuration and credentials, runs actual `npm pack`, checks the archive, installs that exact file with plain npm, and exercises its CLI, public API, and declarations. Runtime analysis uses mocked provider transport, not X or paid JEV calls. Retain the resulting tarball and receipt; do not repack it before publishing.

`prepack` invokes only `build:dist`. That build removes stale generated `dist`, compiles, copies required JSON assets, and makes the CLI executable. Consumers install compiled code; there are no consumer installation hooks and no compiler or pnpm requirement.

Only `@steipete/sweet-cookie@0.1.0` is bundled. Its tested pnpm patch preserves Brave/macOS cookie discovery and Keychain timeout behavior. The gate compares bundled bytes against the patched dependency and verifies npm resolves those same bytes after installation. Pack only from the frozen pnpm-patched tree, not an unpatched npm source installation. A manifest declaration or successful `npm pack` alone is not proof; the offline suite and artifact gate are both required. Stop publication if the bundle is absent or differs; do not silently replace it with an unpatched registry dependency or upgrade authentication behavior.

The provider's SHA-256 is pinned in the artifact verifier to the patched bytes verified for the 0.9.0 runtime and covered by the provider regressions. An intentional patch change requires reviewing the new bytes and rerunning the provider regressions before updating that pin; the Git hash in the patch header is not the identity of pnpm's applied npm file. The packed manifest retains maintainer pnpm patch metadata, but npm consumers use the bundled bytes and do not need the patch file.

The artifact policy excludes private configuration, credentials, repository metadata, fixtures, stale generated files, standalone binaries, and escaping archive links. Preserve both the project and bundled dependency licenses.

CI runs the offline check and this separate gate on Node 22. Before a release, test the retained tarball on the supported Node 22 floor and the current development runtime. Use an isolated toolchain when needed, never replace the parent Node installation. To verify an existing artifact without repacking:

```sh
pnpm run check:package --tarball /absolute/path/bird-jev-0.10.0.tgz --output /absolute/external/second-verification
```

The receipt records source commit, dirty-candidate status, tool versions, artifact integrity, patched dependency hashes, and actual verification results. Reuse requires the original adjacent receipt, matching artifact bytes, and the same source commit before any install or execution. A second-runtime verification preserves that receipt and writes a separate runtime result. A dirty-tree artifact remains development evidence, not a publishable release candidate; reuse never makes it clean.

## Publish through a GitHub release

After `.github/workflows/publish.yml` is merged and npm trust is configured, publishing an eligible GitHub release is the explicit trigger for npm publication. The order becomes **GitHub release → verification → npm publication**. A published GitHub release does not by itself mean the npm package is available; inspect the workflow result.

### One-time npm trust setup

The package must already exist on npm before a trusted publisher can be configured; `bird-jev` already meets this prerequisite. An initial publication of a new package requires the separately authorized manual path below.

An authorized npm package owner must configure a GitHub Actions trusted publisher for `bird-jev` in npm's package settings:

| Setting | Value |
| --- | --- |
| GitHub organization or user | `jcardama` |
| Repository | `bird-jev` |
| Workflow filename | `publish.yml` |
| GitHub environment | Leave empty; this workflow does not use an environment |

This is an account-security change, separate from merging the workflow. Do not create a long-lived npm token or a bypass-2FA token as a substitute. No `NPM_TOKEN` or `NODE_AUTH_TOKEN` secret is required. Trusted publishing requires GitHub-hosted runners, Node ≥22.14.0, and npm ≥11.5.1; the workflow uses pinned compatible tools. The package repository URL must stay `git+https://github.com/jcardama/bird-jev.git` for provenance to match. See [npm trusted publishing](https://docs.npmjs.com/trusted-publishers/).

### Release procedure

1. Prepare a new stable version and changelog in source, obtain the authorized merge to `main`, and wait for CI. Publication does not bump the version or merge a PR.
2. Create the authorized `vX.Y.Z` tag at the intended commit on `main`. The version must match `package.json`, and the tagged commit must include this workflow; prereleases are not published. Preserve existing tags and releases rather than repurposing them as activation tests.
3. Publish the GitHub release with user-facing notes that distinguish implemented behavior from plans and disclose material limitations. Routine test results belong in verification receipts, not release notes.
4. The verification job checks the release identity and main ancestry, installs the frozen pnpm tree, runs `check` and `check:package`, then binds the retained tarball to a clean, passing receipt and the exact tagged SHA. This job has read-only repository permission and no OIDC permission.
5. A separate publishing job downloads that exact artifact. It has OIDC permission but no source checkout, build, or package execution. Built-in Node APIs validate the receipt and digests before publication. The only operation on the Bird-JEV package is `npm publish <verified.tgz> --ignore-scripts --access public --tag latest` against the fixed public registry.
6. Check the workflow summary and registry version, executable metadata, and integrity. The workflow creates neither tags nor releases and never changes a local installation.

Registry responses fail closed: only HTTP 404 means a version is absent. An existing version is accepted only when its identity and integrity match the verified artifact; that path does not invoke `npm publish` or change dist-tags. A new version must be newer than the current stable `latest`. Authentication, transport, server, malformed metadata, and integrity errors stop publication. There is one publish attempt per run; bounded post-publish visibility checks do not repeat it.

Publishing runs are serialized package-wide with `cancel-in-progress: false`, so a new run does not cancel an active publication. GitHub concurrency is not a durable FIFO queue: a newer pending run can replace an older pending run. Release one version at a time and check its outcome before starting another. GitHub concurrency does not coordinate manual publications; do not publish manually while a workflow run is active.

### Failure and recovery

If publication fails, retain the exact artifact, receipt, workflow URL, and failure. Correct the specific setup or registry problem, then rerun the failed workflow; do not manufacture a different artifact for the same version. A rerun can safely recognize a version that was published before a later verification or bookkeeping failure, provided its integrity matches. If a pending run was superseded, an authorized maintainer can rerun it; an older absent version will be rejected once a newer version is `latest`.

npm versions are immutable. Never unpublish, move tags, force-push, or downgrade `latest` to repair bookkeeping. Do not delete and recreate a GitHub release to trigger another publication. A provenance or npm trust failure is a setup error to investigate, not authorization to weaken authentication or change the repository URL on the fly.

### Explicit manual publication

Manual publication remains a separately authorized recovery path, not the automatic fallback. Verify a clean merged candidate, run both gates, check the intended npm account with `npm whoami --registry=https://registry.npmjs.org/`, and use normal login/2FA. Publish the retained tarball with lifecycle scripts disabled, never a rebuilt working directory. Recheck registry integrity afterward. Never paste tokens or authentication codes into command arguments, receipts, or chat.

## Stage and install locally

Local installation requires separate authorization, even after publication.

1. Verify the candidate and inspect the existing `bird` executable before changing it.
2. Stage a version-and-commit-specific runtime outside the checkout, either from the verified npm artifact or from the tested pnpm production dependency tree. For a source stage, preserve relative symlinks and the patched dependency.
3. Check for credential files, development artifacts, and links into the checkout. Test CLI help/version and library imports from outside the checkout.
4. Record the literal old executable link and preserve the entire previous package installation. Switch only that link; do not replace its parent Node installation or force an npm installation over a collision.
5. Check PATH and any consumer-specific executable paths. If verification fails, restore the recorded link. Keep the previous runtime for offline rollback.

Installation and publication receipts belong outside the repository. Retain the original MIT license and recovery provenance.
