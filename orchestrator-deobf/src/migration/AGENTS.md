# Migration AGENTS

## Purpose
Keep Codex snapshot upgrades deterministic with minimal naming-memory loss.

## Current Tool
- `codex-version-bridge.ts`
  - freezes source naming profile into `migration/version-bridge/baselines/*`,
  - pre-seeds target snapshot profile deterministically,
  - runs shared patch-pack preflight before orchestrator run,
  - executes orchestrator run for target snapshot,
  - writes migration report to `migration/version-bridge/reports/*` and `latest-report.json`.
- `daily-migrate-10711.ts`
  - runs generated-artifact size-budget enforcement first,
  - runs pinned preflight for Codex-10711,
  - runs conflict fixture test,
  - runs version bridge,
  - writes KPI summary to `migration/daily-migrate-10711/latest-report.json`.

## Rules
- Fail fast on missing snapshot/profile/preflight failures.
- No silent fallback profile selection in migration path.
- Report must include source/target naming stats and run outputs.
- Daily migration must fail fast on any failed sub-step (preflight/conflict/bridge).
- Daily migration must fail fast on size-budget violation before preflight.
- No generated artifact above 100MB is allowed in migration path.
  - source/target naming snapshots are compacted before use,
  - baseline archives are written as compressed `.json.gz`,
  - legacy uncompressed baseline `.json` files are deleted automatically,
  - migration run fails fast if size budget is still exceeded.
- `codex-version-bridge.ts` must prefer internal snapshot identity over filename heuristics:
  - explicit CLI `--app-version` / `--build-number` first
  - then nearby `package.json` metadata next to the snapshot input
  - snapshot label only as fallback
- Rule:
  - do not keep old hardcoded version defaults in migration paths.
- `daily-migrate-10711.ts` must follow the same rule and record:
  - `versionIdentitySource`
  - `versionIdentityPath`
  in its report output.
- Both migration entrypoints should load shared identity logic from:
  - `C:\\Codex-Windows\\shared\\version-identity\\index.cjs`
