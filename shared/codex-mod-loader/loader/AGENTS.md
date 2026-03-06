# AGENTS Notes (Codex Mod Loader Bootstrap)

## 2026-03-06: Loader bootstrap is still injected from the main runtime shim

- The long-term target is:
  - `platform bootstrap`
  - `shared loader/api`
  - `external mods`
- Right now the actual bootstrap still lives in:
  - `shared/patch-pack/runtime/codex-windows-main-shim.template.cjs`
- Reason:
  - keep exactly one bootstrap patchpoint while Mod API v1 settles down.
- Rule:
  - feature logic belongs in `mods/*`
  - shared contracts belong in `api/*`
  - the shim should only bootstrap them, not absorb feature behavior back into patch-pack.

## 2026-03-06: Main loader extracted from shim

- Runtime mod selection, manifest loading, main-mod activation, and renderer-mod injection now live in:
  - `loader/main-loader.cjs`
- The shim now only:
  - resolves platform state
  - applies platform fixes
  - loads `main-loader.cjs`
- This keeps `patch-pack` platform-only and turns the mod loader into a real external subsystem.
