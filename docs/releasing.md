# Bird-JEV releases

Publishing is separate from verification and local installation. Obtain explicit authorization before publishing to npm, creating a release, enabling GitHub Pages, or sending changes to the original Bird repositories. `package.json` has `private: true` to prevent accidental npm publication; this flag does not control repository visibility. The executable remains `bird`.

## Verify a candidate

Use Node ≥22 and pnpm 10.11.0; preserve the lockfile and sweet-cookie patch.

```sh
pnpm install --frozen-lockfile --ignore-scripts
pnpm run build:dist
BIRD_LIVE=0 pnpm exec vitest run --exclude 'tests/live/**'
pnpm run lint
node dist/cli.js --version
```

Live tests are excluded because upstream includes mutations. Use separately authorized, bounded read-only probes for search, cursor resume, and replies. Do not print or persist session cookies. Do not run the Bun binary build with credentials in the environment: the inherited command embeds `BIRD_*` variables.

## Stage and install locally

1. Verify and commit the candidate with the personal Git identity.
2. Stage a version-and-commit-specific runtime outside the development checkout, containing built `dist`, package metadata, license, and the tested pnpm dependency tree. Preserve relative symlinks and the patched sweet-cookie dependency. A plain npm tarball install does not reproduce that patch.
3. Check the stage for credential files, development artifacts, and symlinks back into the source checkout. Test CLI help/version and library imports from outside the checkout.
4. Inspect the existing `bird` executable. Record its literal symlink target and preserve the entire previous package installation. Switch only that executable link to the staged CLI; do not replace its parent Node installation or use a forced package install to mask a collision.
5. Check both PATH resolution and any consumer-specific executable paths. If verification fails, restore the recorded link immediately. Keep the previous installation for offline rollback.

The local installation receipt records exact version, source commit, runtime directory, original link, verification, and rollback steps. It belongs beside the runtime, not in the repository.

## Remote changes

Create or update only the explicitly authorized repository. Repository creation, pushing source/tags, PRs, releases, and visibility changes are distinct actions; obtain authorization for each. Verify the owner and requested visibility after creation. Never assume local installation authorizes publishing.

Retain the original MIT license and recovery provenance. Version notes must distinguish implemented features from planned JEV capabilities.
