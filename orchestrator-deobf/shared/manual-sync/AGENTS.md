# AGENTS.md

## Purpose
Store stable manual-to-generator synchronization contracts.

## Scope
- `symbol-name-overrides.json`: authoritative symbol rename overrides from manual project.
- `module-path-overrides.json`: authoritative per-symbol module placement overrides.
- `module-surface-overrides.json`: authoritative module export surface + owner-layer mapping.
- `last-export-report.json`: latest export diagnostics from manual project.
- `contract-changelog.md`: append-only history of auto updates (`actor/when/why`).

## Rules
- Contracts are applied automatically by generator stages when files exist.
- Invalid contract entries fail fast (do not silently fallback).
- Contract header must stay fixed: `contractVersion=2`, `migrationVersion=1`.
- Keep entries deterministic and sorted by `symbolKey`.
- Prefer evidence-rich entries (`evidence`, `provenance`, `updatedAtIso`).

## Workflow
1. Generate baseline project with `runtime/manual-sync-index.json`.
2. Refactor manual project.
3. Run `npm run manual-sync:export -- --manual-project <path>`.
4. Commit updated `shared/manual-sync/*`.
5. Run generator again; overrides are applied to naming and module placement.
6. Run `npm run manual-sync:roundtrip -- --snapshot <app.asar> --manual-project <path>` before merge; fail on quality degradation.

## Lifecycle Rules
- `stale-cleanup` is mandatory in export: stale overrides are deleted if they no longer match current snapshot.
- Recovery by fingerprint is allowed only for unique high-confidence matches.
- After stop-rule freeze (`manual-first`), reverse sync is allowed only through `shared/manual-sync/*`.
