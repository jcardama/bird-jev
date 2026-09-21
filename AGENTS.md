# Bird-JEV

Bird-JEV is a command-line tool and TypeScript library for reading and searching X. It builds on Bird and keeps the `bird` command, library API, cookie authentication, and configuration paths.

JEV analysis is opt-in on post-producing reads. Custom tasks can evaluate individual posts or the selected collection; see `docs/jev.md`. Inherited write commands remain available, but maintenance and verification focus on reads.

## Commands

Use Node ≥22 and pnpm 10.11.0. Preserve the lockfile and the sweet-cookie patch.

```sh
pnpm install --frozen-lockfile --ignore-scripts
pnpm run check
```

`check` runs the distribution build, offline tests, and lint in order. It prints short status lines and the complete failed-stage output. It stops at the first failure. CI runs the same command, then the separate registry-backed `pnpm run check:package` artifact gate. The default check remains offline.

For focused work, run only the relevant offline tests:

```sh
pnpm exec vitest run tests/search-pagination.test.ts --exclude 'tests/live/**'
```

Run the full check before handoff. Do not pipe verification output through truncation commands.

## Boundaries

- Keep changes focused. Reuse existing implementations before adding new ones.
- Keep X parsing, pagination, and endpoint handling here. Keep consumer-specific query expansion and scoring in the consumer.
- Do not run live X operations without separate authorization. Live test suites include opt-in writes.
- Do not run `build:binary` with credentials in the environment: it embeds `BIRD_*` variables. `build` includes this binary step; use `build:dist` for the distribution alone.
- `graphql:update` contacts X and rewrites query IDs. It is not an offline check.
- Do not print credentials or add them to logs, fixtures, or commits. Publication and runtime installation require separate authorization.
- `publish.yml` verifies stable GitHub releases before publishing the exact tested npm artifact. Keep OIDC permission confined to its no-checkout publishing job; never add a saved npm token or run package lifecycle scripts there. Read `docs/releasing.md` before changing this workflow.

## Layout

- `src/commands/` — CLI commands
- `src/lib/twitter-client-*.ts` — X GraphQL client
- `src/cli/pagination.ts` — search and timeline pagination
- `src/lib/thread-filters.ts` — thread filter flags
- `tests/` — offline tests; live suites are under `tests/live/`
- `scripts/check.js` — shared local and CI verification runner

<important if="changing tests, check scripts, or CI">
Read `docs/testing.md`. Keep the default check offline and preserve failure output and exit codes.
</important>

<important if="editing search pagination, cursors, or GraphQL search parsing">
Read `src/cli/pagination.ts` and `src/lib/twitter-client-search.ts`.
</important>

<important if="creating a release, staging a runtime, or installing locally">
Read `docs/releasing.md`.
</important>

<important if="recovery, provenance, or license questions">
Read `docs/provenance.md`.
</important>
