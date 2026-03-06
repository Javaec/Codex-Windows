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
