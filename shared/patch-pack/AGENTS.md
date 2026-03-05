# Patch Pack AGENTS

## Purpose
Single source of truth for patch profiles across repacker, generator, and manual project.

## Scope
- patch step catalog
- stage registry (`extract -> deobf -> mods -> runtime-pack`)
- version selectors
- profile plans with required/optional steps
- mod manifests (`mods/*.json`) with deterministic ordering and conflict rules

## Rules
- No duplicated profile definitions inside app-specific code.
- Profile selection must be deterministic: forced override > selector rules > default profile.
- Mod execution order must be deterministic: `stage` rank -> `priority` -> `id`.
- Any conflict in selected mods must fail fast.
- Additive profile evolution only; no implicit fallback chains.
- Mod manifests must declare explicit injector contracts (`stageId`, `inputContract`, `outputContract`) that exactly match stage-registry.

## 2026-03-04 Decisions
- Added `preflight.mjs` as a single fail-fast validator for the shared patch-pack.
- Preflight validates:
  - selector + catalog schema,
  - all profile files and mod manifests,
  - duplicate mods and step-id integrity,
  - mod conflict graph per profile,
  - compatibility of selected profile for provided snapshot/build/app-version input.
- This is now the required first check before version migration work (`106x -> 10711+`).
- Added test fixture profile `profiles/test-mod-conflict.json` with intentionally conflicting sunset mods.
- Added conflict assertion command `test-mod-conflict.mjs`.
  - It expects preflight to fail with conflict diagnostics (`webview-sunset-strict` x `webview-sunset-optional`).
  - Test fixture profiles are excluded from normal preflight unless `--include-test-profiles` is passed.
- Added `stage-registry.json` as the only source of stage ordering and IO contracts:
  - required stages: `extract`, `deobf`, `mods`, `runtime-pack`,
  - injector mods are allowed only on `mods` stage by policy,
  - all mod manifests now use `lane + injector` instead of legacy free-form stage ranking.

## 2026-03-05 Decisions

## 2026-03-05: Split Platform Patches vs Feature Mods (Forge-like)

- patch-pack is now strictly "platform patching":
  - preload bridge
  - webview sunset bypass
  - webview cwd normalization (optional by profile)
  - webview thread cap (10 -> 6)
  - webview persistExtendedHistory=true
  - main Windows runtime shim (env + SQLite path normalization + open-path fix + renderer mod-loader hook)
- Feature UI tweaks moved out of brittle webview bundle patching:
  - runtime-loaded by the main-process mod loader from `shared/codex-mod-loader/mods/*`
  - bundled into portable outputs as `resources/mods/*`
  - injected into renderer via `webContents.executeJavaScript` (DOM-only, must not mutate `window.electronBridge`)
- patch-pack preflight now validates runtime modpack presence + manifest/entry integrity.
