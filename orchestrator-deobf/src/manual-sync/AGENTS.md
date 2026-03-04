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
- Batch now starts with patch-pack preflight gate from workflow config (`patchPackPreflight`):
  - runs `npm run patch-pack:preflight -- --snapshot-label ... --app-version ... --build-number ...`,
  - optionally runs `npm run patch-pack:test:mod-conflict`.
  Verified reason: migration/version drift in patch-pack is detected before regression/manual-sync work starts.
- Batch now forwards patch-pack identity into roundtrip generator calls:
  - `--snapshot-label` (required when preflight is enabled),
  - optional `--patch-profile`.
  Verified reason: prevents `app.asar` label ambiguity in roundtrip runs and keeps patch-pack resolver deterministic.
- Batch runs `regression:cycles` with `--output-profile latest` (not `regression-latest`) to avoid Windows lock contention on `output/regression-latest/project` during parallel/manual roundtrip work.
- Roundtrip keeps `--profile latest` for the same lock-avoidance reason.
- One batch can run at most one generator sync pass; if stop-rule streak is reached, generator sync is frozen via `shared/manual-sync/manual-generator-freeze.json`.
- Batch includes strict hot-rescue gate against manual top-10 files from `regression/manual-refactor-candidates.json`.
- Hot-rescue report is emitted to `shared/manual-sync/manual-hot-rescue-last-report.json`.
- Hard limit: `namespace-import <= 8` for each mapped top-hot manual file.
- When generator pass gives non-positive cycle uplift, manual-sync contracts are restored from pre-cycle snapshot (auto rollback of generator-side sync delta).
- Added hot import quarantine pass (`manual-sync:quarantine-imports`):
  - reads `manual-hot-rescue-last-report.json`,
  - rewrites top-unique hot manual files by moving `artifacts/*` and `assets/payloads/*` imports into sibling `*-deps.ts`,
  - supports `--skip-unique` to process the next hot batch (`#6-#10`, etc.),
  - keeps business logic files with a single aggregated deps import.
  Verified reason: reduces import/runtime-vendor visual noise in hot manual files without changing function bodies.
- Added targeted top-hot manual refactor pass (`manual-sync:refactor-top-hot`):
  - extracts one dependency-closure behavior cluster per top-hot file into sibling `*-behavior-split.ts`,
  - keeps refactor strictly manual-project scoped (no new generator fallback branches),
  - emits `manual-top-hot-refactor-last-report.json` with before/after file metrics.
  Verified reason: enables fast behavior-boundary split experiments on top-5 manual files while preserving strict manual-first workflow.
- Refactor pass now supports strict safety guards:
  - `--max-line-growth <n>` and `--max-import-growth <n>`,
  - candidate extraction is rejected when post-metrics exceed allowed growth.
  Verified reason: avoid local readability regressions from micro-extractions that only increase glue/import noise.
- Added refactorability-first hot selection (`manual-sync:select-hot`):
  - builds top-5 using composite score (`low-quality + high-refactorability`),
  - excludes files with repeated no-op history (`refactorability-state.json`),
  - prioritizes large store/service files with extraction potential.
  Verified reason: avoid wasting cycles on stable no-op targets (`store-path*`, `transport-bridge*`).
- Added local readability KPI in batch:
  - tracks `avgFunctionBodyLength`, `glueRatio`, `domainCallDensity` on fixed top-3 files,
  - cycle is considered successful only when global `nameQuality` and local readability KPI both improve,
  - generator rollback now triggers only when both roundtrip and local readability KPI fail to grow.
- Manual-first targeted rename policy:
  - perform role/io renames directly in manual store/service files when size-reduction passes plateau,
  - keep external deps compatibility by aliasing renamed imports (`oldExport as newLocalName`) instead of changing upstream export contract.
  Verified reason: improves local readability without widening generator blast radius.

## Resolution Rules
- Manual overrides always have higher priority than generated quality/coverage naming.
- Missing symbol keys may be resolved by declaration fingerprint match (`AST role/api/mutation + call/state neighborhood`).
- Ambiguous fingerprint matches are rejected (no silent fallback).
