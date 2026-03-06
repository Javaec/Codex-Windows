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
  - main Windows runtime shim (env + SQLite path normalization + open-path fix + renderer mod-loader hook)
- Feature UI tweaks moved out of brittle webview bundle patching:
  - runtime-loaded by the main-process mod loader from `shared/codex-mod-loader/mods/*`
  - bundled into portable outputs as `resources/mods/*`
  - injected into renderer via `webContents.executeJavaScript` (DOM-only, must not mutate `window.electronBridge`)
- App-server request tweaks are also runtime mods (main-process):
  - `mods/app-server-tweaks` rewrites IPC request payloads:
    - `thread/*` forced `persistExtendedHistory=true`
- UI behavior tweaks are renderer mods:
  - `mods/webview-thread-list-cap` keeps grouped project lists at 6 rows before the custom toggle
  - `mods/webview-settings-limits-panel` polls `/wham/usage` and shows remaining 5h/weekly quota
- patch-pack preflight now validates runtime modpack presence + manifest/entry integrity.

## 2026-03-05: Explicit Codex-11012 support

- `codex-10711` profile is the active compatibility profile for `Codex-11012.dmg`.
- Selector must resolve this profile by either:
  - snapshot label (`Codex-11012.dmg`), or
  - app version `26.305.950` when the DMG file has been renamed generically.
- `buildHint` must also be recoverable from known `appVersion` values for compatibility gating:
  - `26.305.950 -> 11012`
  - `26.303.1606 -> 10711`
- Added a dedicated smoke command:
  - `npm run patch-pack:preflight:11012`
- Reason:
  - new-version migration must not depend on the user keeping the original DMG filename.

## 2026-03-05: Main shim now owns Windows noise suppression and global-state cleanup

- `codex-windows-main-shim.template.cjs` must sanitize `.codex-global-state.json` on startup:
  - drop missing workspace roots,
  - drop missing per-path entries,
  - prune stale `thread-titles` entries against the SQLite `threads` table and cap cache size.
- The same shim also suppresses known non-actionable Windows noise:
  - missing-worktree git-origin warnings,
  - `wsl.exe --list --verbose` warning spam,
  - Node `DEP0169` (`url.parse`) deprecation noise.
- Reason:
  - these warnings are not business logic failures; they hide real regressions and make runtime diagnostics unreadable.

## 2026-03-05: Tolerated patch outcomes are informational

- Optional patch skips for unsupported bundle signatures must log as info, not warnings.
- Repack output should reserve warning lines for actionable failures only.
