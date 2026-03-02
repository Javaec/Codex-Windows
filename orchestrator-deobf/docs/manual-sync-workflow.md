# Manual Sync Workflow (Generator <-> Manual Project)

## Why this exists

`manual-sync` is the bridge between:
- generated TS project from decompiler pipeline, and
- manual-first project where architecture and naming are improved by hand.

Goal: keep manual improvements reusable by the generator instead of losing them across new snapshots.

## Source of truth

Contracts live only in:
- `shared/manual-sync/symbol-name-overrides.json`
- `shared/manual-sync/module-path-overrides.json`
- `shared/manual-sync/module-surface-overrides.json`
- `shared/manual-sync/contract-changelog.md`

Contract header is mandatory:
- `contractVersion = 2`
- `migrationVersion = 1`

Pipeline stage usage:
- naming-memory stage applies symbol renames.
- template-emitter stage applies module path placement.
- structural/ownership checks consume module-surface owner layer and export surface as consistency evidence.

## Generated evidence for sync-back

Every quality emit writes:
- `project/runtime/manual-sync-index.json`

This index maps generated exports back to source symbol keys and lifted origins.
Export script uses this index to build/update contracts from manual project exports.

## CLI surface

Main pipeline:
- `node dist/index.js --snapshot <app.asar> --profile regression-latest --enable-manual-sync`
- Optional root override: `--manual-sync-root <path>`
- Disable hook: `--disable-manual-sync`

Manual export:
- `npm run manual-sync:export -- --manual-project <path-to-manual-project>`
- Optional generated project path:
  - `--generated-project <path>` (default: `output/regression-latest/project`)
- Optional contract root:
  - `--manual-sync-root <path>` (default: `shared/manual-sync`)
- Optional merged evidence promotion:
  - `--merged-evidence <path-to-merged-evidence.json>`
  - `--promotion-top-n <n>` (promotion filter is strict: `selected != currentName`)

Contract validation:
- `npm run manual-sync:validate`

Contract migration (explicit only):
- `npm run manual-sync:migrate`

Round-trip quality guard:
- `npm run manual-sync:roundtrip -- --snapshot <app.asar> --manual-project <path>`
- Flow: `export -> apply -> regenerate -> diff`.
- Hard-fails on quality degradation.

## Recommended daily loop

1. Generate baseline:
   - run pipeline with `--enable-manual-sync`.
2. Improve manual project:
   - rename symbols, move modules, improve structure.
3. Export manual decisions:
   - run `manual-sync:export`.
4. Validate contracts:
   - run `manual-sync:validate`.
5. Re-run generator:
   - verify manual decisions are applied automatically.
6. Commit:
   - commit `shared/manual-sync/*` with clear message.

## Contract expectations

`symbol-name-overrides.json` entries:
- `symbolKey` required.
- `preferredName` required (valid identifier, non-generic preferred).
- optional: `confidence`, `evidence`, `provenance`, `updatedAtIso`, `enabled`.

`module-path-overrides.json` entries:
- `symbolKey` required.
- `filePath` required; must start with `src/` or `src-tauri-adapter/`; must end with `.ts`.
- optional: `layer`, `archetype`, `topic`, `confidence`, `evidence`, `provenance`, `updatedAtIso`, `enabled`.

`module-surface-overrides.json` entries:
- `moduleFilePath` required.
- `ownerLayer` required.
- `exportSurface` required (non-empty).
- `symbolKeys` required (can be empty if unresolved, but stale cleanup removes permanently unmatched entries).
- optional: `archetype`, `confidence`, `evidence`, `provenance`, `updatedAtIso`, `enabled`.

## Failure behavior

Design is fail-fast:
- malformed contracts throw hard errors.
- incompatible/missing required fields are not silently ignored.
- duplicate `symbolKey` entries are invalid.

This prevents hidden regressions and keeps deterministic replay across snapshots.

## Snapshot migration strategy

When Codex snapshot changes (`Codex.dmg` updates):
1. run baseline generation on new snapshot,
2. keep old `shared/manual-sync/*`,
3. re-run and inspect apply report:
   - `runs/<id>/manual-sync-applied.json`,
4. export from manual project again to refresh mappings against new index.

This keeps manual knowledge portable even when obfuscation profile changes.

## Manual-first transition

`regression:cycles` now has stop-rule freeze behavior:
- if 3 cycles in a row have no growth in `quality + nameQuality + high-confidence`, pipeline writes:
  - `shared/manual-sync/manual-first-freeze.json`
- after freeze, automated cycle runs are blocked unless explicitly overridden with:
  - `--allow-after-freeze`
- reverse synchronization policy in freeze mode:
  - only `shared/manual-sync/*` contracts are allowed as sync-back channel.

## Operational artifacts

Useful files after run:
- `runs/<run-id>/manual-sync-applied.json`
- `output/regression-latest/project/runtime/manual-sync-index.json`
- `shared/manual-sync/last-export-report.json`

These three files are enough to diagnose:
- what was applied,
- what can be exported,
- what was updated or skipped.
