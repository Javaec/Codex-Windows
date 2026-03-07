# Modding AGENTS

## Purpose
Keep patch-pack resolution deterministic and mod-injector oriented.

## Rules
- Stage order and contracts come only from `C:\\Codex-Windows\\shared\\patch-pack\\stage-registry.json`.
- Mod manifests are injectors (`injector.stageId` + strict input/output contracts), not free-form patch step bags.
- Resolver must fail fast on unknown stage, contract mismatch, incompatibility, or conflict.
- No fallback stage ranking in code; stage order is read from stage-registry only.

## 2026-03-04 Decisions
- Added stage-registry enforcement into patch-pack resolver.
- Added `stageExecutions` output for each resolved profile.
- Kept patch-step merge only inside `mods` stage to avoid hidden cross-stage side effects.

## 2026-03-07: Patch-pack resolver is internal-version-first

- `resolvePatchProfile(...)` must prefer internal snapshot identity:
  - explicit `appVersion` / `buildNumber`
  - then nearby `package.json`
  - only then snapshot-label fallback
- Rule:
  - do not treat `Codex-11012.dmg` style filenames as the primary version source in orchestrator paths.
