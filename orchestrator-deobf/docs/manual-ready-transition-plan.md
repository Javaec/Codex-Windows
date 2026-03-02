# Manual-Ready Transition Plan

## Scope
- Final generator push: semantic naming quality for hot modules, deterministic promotion rules, and pass-level rollback guards.
- Transition target: manual-first development with reverse sync only through `shared/manual-sync/*`.

## Step 3: Semantic naming and manual-readiness
- Role/IO rename is applied inside function bodies for hot service/store and hot renderer-store modules.
- Merged-evidence top-N promotion is applied only when:
  - selected candidate name differs from current name, and
  - candidate has positive quality uplift (or non-generic upgrade).
- `manual-sync:export` always performs stale cleanup and writes cleanup counters to export report.
- Template emitter executes guarded pass pipeline with per-pass rollback:
  - syntax guard,
  - name-quality guard,
  - low-quality identifier growth guard,
  - import-noise/size growth guard.

## Step 4: Manual-ready mode
- Stable working artifacts:
  - `regression/manual-ready-slice.json`,
  - `regression/manual-ready-backlog.json`.
- Backlog split:
  - `manualRefactor` stream: top domain files for manual work.
  - `generatorSync` stream: minimal supporting updates for naming/ownership/emitter alignment.
- Reverse sync contract is fixed:
  - only `shared/manual-sync/*` is valid.
- Stop-rule:
  - after 3 cycles without quality growth, generator enters manual-first freeze.
  - further generation requires explicit `--allow-after-freeze`.
