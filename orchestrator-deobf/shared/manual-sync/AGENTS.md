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
   - For safe top-hot sync without naming regressions, prefer:
     `npm run manual-sync:export -- --manual-project <path> --path-surface-only --top-hot-limit 5`
4. Commit updated `shared/manual-sync/*`.
5. Run generator again; overrides are applied to naming and module placement.
6. Run `npm run manual-sync:roundtrip -- --snapshot <app.asar> --manual-project <path>` before merge; fail on quality degradation.

## Lifecycle Rules
- `stale-cleanup` is mandatory in export: stale overrides are deleted if they no longer match current snapshot.
- Recovery by fingerprint is allowed only for unique high-confidence matches.
- After stop-rule freeze (`manual-first`), reverse sync is allowed only through `shared/manual-sync/*`.

## 2026-03-03 Run Notes
- Full cycle order used: `manual-sync:batch` -> top-10 hot selection -> top-5 quarantine/refactor -> `manual-sync:export` -> `manual-sync:roundtrip` -> `manual-sync:hot-rescue`.
- Current guard remained green: `namespace-import <= 8` across top-hot targets (`violationCount=0`).
- If roundtrip KPI does not increase, rollback generator pass artifacts and keep only narrower manual pass.
- Refactorability-first top-5 selection should exclude known no-op paths (`store-path-quality*`, `transport-bridge*`) and prioritize large store/service files with behavior-split potential.
- For targeted top-3 manual cycle, prefer `roundtrip --path-surface-only --top-hot-limit 3 --top-hot-report <refactorability-top3-report>` to avoid accidental symbol-rename degradation.
