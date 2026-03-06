# Runtime Shim AGENTS

## Purpose
Single source of truth for the injected Electron main shim used by repack and direct-launch flows.

## 2026-03-06: Renderer mod wrapper contract

- Renderer mods are injected through `webContents.executeJavaScript(...)`.
- The wrapper must use real line breaks around the mod body:
  - good:
    - ``const wrapped = `/* CODEX-MOD:${mod.id} */``
    - next line: `${mod.script}`
    - next line: `` `; ``
- Do not encode those line breaks as literal `\\n`.
- Literal `\\n` in the wrapper makes every renderer mod fail to parse at runtime and produces a black screen.

## 2026-03-06: Bundled mods must beat ambient CODEX_MODS_DIR

- In packaged/repacked runs, the shim must prefer `process.resourcesPath/mods` when that directory exists.
- `CODEX_MODS_DIR` is only a fallback for unpacked/dev launches.
- Reason:
  - a stale shell-level `CODEX_MODS_DIR` can silently load the wrong modpack and produce missing UI or gray-screen regressions.

## 2026-03-06: Runtime contract must be logged once per main-process boot

- The shim must log one compact line with:
  - `executable`
  - `userData`
  - `codexHome`
  - `cli`
  - `mods`
  - `resources`
- Reason:
  - when the wrong Codex build is running, the first requirement is to identify the effective runtime contract without guesswork.

## 2026-03-06: Mod loader must support hard A/B isolation

- The main shim must support:
  - `CODEX_MODS_DISABLED=1`
  - `CODEX_MODS_ONLY=<id1,id2,...>`
  - `CODEX_MODS_EXCLUDE=<id1,id2,...>`
- Reason:
  - UI regressions must be bisected by mod set, not inferred from generic renderer/app-server logs.

## 2026-03-06: Shim now bootstraps shared Mod API before feature mods

- The shim must load:
  - `resources/mod-api/renderer-api.js`
  - `resources/mod-api/main-api.cjs`
  - `resources/mod-loader/main-loader.cjs`
  before feature mods execute.
- Renderer mods no longer own their own copies of sidebar lookup, observer/throttle helpers, or bridge fetch plumbing.
- Main mods now receive shared Mod API context rather than raw ad-hoc bootstrap objects.
- Runtime mod discovery/selection/injection now lives in `main-loader.cjs`, not in the shim itself.
- Reason:
  - reduce duplicated fragile logic
  - move toward `platform bootstrap + loader API + external mods`
  - keep feature behavior out of patch-pack.

## 2026-03-06: Runtime mods are opt-in, not default

- The main shim must not load runtime mods unless `CODEX_ENABLE_RUNTIME_MODS=1`.
- Direct `Codex.exe` launch therefore defaults to loader-present but no feature mods applied.
- Reason:
  - release safety is more important than convenience; experimental renderer mods must not be on by default.

## 2026-03-06: Main shim stays platform-critical only

- Removed from the main shim:
  - `.codex-global-state` sanitation
  - console/process warning noise suppression
- Keep in the shim only:
  - bundled CLI preference
  - renderer URL bootstrap
  - SQLite thread path normalization
  - Windows open-path sanitize
  - mod-loader bootstrap
- Reason:
  - these removed paths were masking symptoms and bloating the highest-risk runtime file.

## 2026-03-06: Minimal platform mode exists for gray-screen bisect

- `CODEX_WINDOWS_MINIMAL=1` disables non-essential runtime fixups inside the shim:
  - SQLite thread path normalization
  - shell `openPath/showItemInFolder` patching
  - runtime mod loading
- Keep active even in minimal mode:
  - bundled CLI preference
  - renderer URL bootstrap
  - runtime contract logging
- Use this mode only for diagnosis; it is not the default release lane.
