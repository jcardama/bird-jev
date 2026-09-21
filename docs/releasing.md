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

## Publish the verified artifact

For a PR-based release, wait for the authorized merge and passing CI, then build and verify a new artifact from the exact merged commit. Do not publish a pre-merge tarball as though it came from the merge commit.

1. Verify a clean checkout, exact candidate commit, version, and intended npm account with `npm whoami --registry=https://registry.npmjs.org/`. Use normal npm login/2FA; never paste tokens into command arguments, receipts, or chat.
2. Confirm the version is not already published. Recheck the retained artifact's digest against its successful verification receipt.
3. Publish that file, without rebuilding:

   ```sh
   npm publish /absolute/path/bird-jev-0.10.0.tgz --ignore-scripts --access public --tag latest --registry=https://registry.npmjs.org/
   ```

4. Check registry version, ownership, executable metadata, and `dist.integrity` against the verified tarball. Verify a clean registry install outside the checkout without changing any global executable.
5. Create the matching version tag at the verified source commit and publish the authorized GitHub release. Preserve existing releases and tags. Release notes distinguish implemented behavior from plans and disclose material limitations; routine test results belong in the publication receipt.

npm versions are immutable. If npm succeeds but a GitHub or bookkeeping step fails, record the partial outcome and complete only the missing step. Do not republish, unpublish, move tags, or force-push to repair bookkeeping.

## Stage and install locally

Local installation requires separate authorization, even after publication.

1. Verify the candidate and inspect the existing `bird` executable before changing it.
2. Stage a version-and-commit-specific runtime outside the checkout, either from the verified npm artifact or from the tested pnpm production dependency tree. For a source stage, preserve relative symlinks and the patched dependency.
3. Check for credential files, development artifacts, and links into the checkout. Test CLI help/version and library imports from outside the checkout.
4. Record the literal old executable link and preserve the entire previous package installation. Switch only that link; do not replace its parent Node installation or force an npm installation over a collision.
5. Check PATH and any consumer-specific executable paths. If verification fails, restore the recorded link. Keep the previous runtime for offline rollback.

Installation and publication receipts belong outside the repository. Retain the original MIT license and recovery provenance.
