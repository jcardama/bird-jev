# Contributing

Bird-JEV builds on Bird to read and search X through the `bird` command and library API. Keep changes scoped to the requested work.

## Setup

Requires Node ≥22 and pnpm 10.11.0.

```sh
pnpm install --frozen-lockfile --ignore-scripts
```

Preserve the lockfile and the sweet-cookie patch. Do not rewrite the lockfile to accommodate pnpm 11.

## Verify

```sh
pnpm run check
```

This is the same check used by CI: distribution build, offline tests, then lint. Successful stages print short status lines. A failed stage prints its complete output and stops the check with a nonzero exit status.

Use focused tests while working, then run the full check before submitting. See [Testing](docs/testing.md) for commands, failure handling, and the live-test boundary. Do not run live tests or the credential-embedding binary build as routine verification.

## Changes

- Search existing patterns before adding code.
- Add focused tests for changed behavior.
- Keep consumer-specific query expansion and scoring in the consumer.
- Use Conventional Commits (`feat`, `fix`, `docs`, `chore`, `refactor`, `test`).
- JEV is an explicit opt-in analysis stage; preserve ordinary read output and keep consumer-specific policies in caller-supplied tasks.
- JEV provider calls spend money and send selected content externally. Live X calls and publication also require separate authorization; none belong in the offline check.

Installation, rollback, and publication bounds are in [Releasing](docs/releasing.md). Recovery and license facts are in [Provenance](docs/provenance.md).
