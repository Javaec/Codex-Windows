# AGENTS.md

## Purpose
Implement deterministic import/export bridges between generated project output and manual project decisions.

## Modules
- `contracts.ts`: typed contract models, path resolution, normalization, and strict readers.
- `export-from-manual.ts`: export script that derives symbol/path overrides from manual project exports.

## Design Rules
- Fail fast on malformed contract entries.
- Keep one source of truth for manual decisions in `shared/manual-sync/*`.
- Do not mutate semantic IR directly in this layer; only provide deterministic inputs for stages.
- Keep output deterministic (stable sorting and stable merge behavior).
- Contract law is strict: `contractVersion=2`, `migrationVersion=1`.
- Migration is explicit through `manual-sync:migrate`; runtime does not auto-heal old schemas.
- Reverse sync root is fixed: only `shared/manual-sync/*` is allowed (custom root paths are rejected).

## Sync Contract Flow
1. Generator emits `runtime/manual-sync-index.json`.
2. Manual project evolves.
3. `manual-sync:export` updates:
   - `shared/manual-sync/symbol-name-overrides.json`,
   - `shared/manual-sync/module-path-overrides.json`,
   - `shared/manual-sync/module-surface-overrides.json`.
4. Next run imports these contracts in naming-memory and emitter stages.

## Quality Guard
- `manual-sync:roundtrip` is the mandatory safety loop for export changes:
  - `export -> apply -> regenerate -> diff`,
  - fail-fast on quality regression (`nameQuality`, coverage, build/dev health, proxy count).
- `nameQuality` comparison uses a strict micro-jitter tolerance (`0.001`) to avoid false failures from tiny snapshot-level fluctuations.

## Stale Cleanup
- Export pass removes stale override entries that no longer match current snapshot.
- Rekey by fingerprint is allowed only for unique high-score matches; ambiguous matches are dropped.
- Stale cleanup is mandatory in `manual-sync:export` and is reported in `last-export-report.json`.

## Promotion Rule
- Merged-evidence top-N promotion applies only when `selected != currentName` and candidate has positive quality uplift (or non-generic upgrade).

## Batch Loop
- `manual-sync:batch` is the default Step-3/Step-4 executor.
- Batch policy is configured in `config/manual-first-workflow.json` and enforced by state files in `shared/manual-sync/manual-batch-*.json`.
- One batch can run at most one generator sync pass; if stop-rule streak is reached, generator sync is frozen via `shared/manual-sync/manual-generator-freeze.json`.

## Resolution Rules
- Manual overrides always have higher priority than generated quality/coverage naming.
- Missing symbol keys may be resolved by declaration fingerprint match (`AST role/api/mutation + call/state neighborhood`).
- Ambiguous fingerprint matches are rejected (no silent fallback).
