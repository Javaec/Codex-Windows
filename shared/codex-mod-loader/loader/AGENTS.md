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

## 2026-03-06: Capability registry is part of the loader contract

- Shared capability names now live in:
  - `loader/capability-registry.json`
- Both runtime loader and patch-pack preflight validate against this file.
- Rule:
  - add a capability only when it represents a stable platform hook
  - do not add capabilities for one-off DOM quirks.
- Recent additions:
  - renderer: `sidebar-groups`, `project-list`
  - main: typed Codex request/response hooks build on the existing app-server request/response capability lane

## 2026-03-06: Typed hooks first, renderer heuristics second

- Prefer typed hooks such as:
  - `onBeforeCodexRequest`
  - `onAfterCodexResponse`
  - `onRendererReady`
  - `onRouteChange`
- Prefer shared renderer group/list helpers such as:
  - `getSidebarGroups`
  - `getProjectLists`
- Rule:
  - if a mod can be expressed through a typed hook or shared capability, do not let the mod walk raw IPC/DOM structures itself.

## 2026-03-08: Renderer injection cache must be generation-aware

- Injection cache must not be keyed only by `webContents` identity.
- Reset cached renderer injections on:
  - `render-process-gone`
  - full main-frame reload/navigation
- Reason:
  - Electron can keep the same `webContents` wrapper while the renderer process and JS context are recreated.

## 2026-03-06: Usability probe is loader-owned smoke instrumentation

- `loader/usability-probe.js` is not a feature mod.
- It is injected only when:
  - `CODEX_WINDOWS_USABILITY_SMOKE=1`
- It exists only to log read-only UI readiness markers for smoke:
  - sidebar present
  - settings present
  - project list present
  - surface ready
  - blocking spinner present
- Rule:
  - do not put business logic or UI mutations in the usability probe.
- The probe must remain injectable even when runtime feature mods are disabled.
- `minimal` should still receive the shared renderer API plus the smoke probe; only feature mods stay disabled there.
