# AGENTS Notes (Codex Mod Loader)

## 2026-03-05: Forge-like split (platform patches vs feature mods)

Goal: keep repacks/source builds stable across Codex versions with minimal obfuscation churn.

We split changes into two layers:

1) Platform patches (mandatory)
   - Applied by patch-pack at build/repack time.
   - Examples: preload bridge, sunset gate bypass, cwd normalization, Windows runtime shim (env + SQLite path normalization + open-path fix).

2) Feature mods (optional)
   - Loaded at runtime by the main-process Mod Loader.
   - Stored under `resources/mods/*` (or `CODEX_MODS_DIR` override).
   - Injected into renderer via `webContents.executeJavaScript` (DOM-only, never mutating `window.electronBridge`).

Why:
- Avoid brittle webview bundle patching for UI features (obfuscation drift).
- Keep one modpack that works for repack, portable builds, and source builds (by pointing `CODEX_MODS_DIR`).

Mod contract (v1):
- `mods/<modId>/mod.json` defines metadata, compatibility, and entrypoints.
- `entrypoints.renderer` is injected on `dom-ready` for each non-devtools webContents.
- `entrypoints.main` is executed once in the main process before renderer injection.
  - It must export a function (or `{ activate() }`) that receives Mod API v1 context.
  - Use this for stable, version-tolerant behavior changes (IPC request rewrites, routing tweaks, etc).

## 2026-03-06: Shared Mod API v1

- Shared API now lives under:
  - `api/renderer-api.js`
  - `api/main-api.cjs`
- Loader/bootstrap still lives in the runtime shim for now; this keeps one bootstrap patchpoint while moving feature logic out of per-mod copies.
- Renderer mods should use the shared API instead of cloning:
  - text normalization
  - sidebar discovery
  - DOM observers/throttling
  - style/singleton DOM nodes
  - bridge fetch wiring
- Main mods should use shared helpers for generic IPC wrapping instead of reimplementing ipcMain scaffolding.

## 2026-03-06: Loader path is now explicit runtime contract

- Portable and unpacked runs now point at:
  - `CODEX_MOD_LOADER_DIR`
- Default packaged location:
  - `resources/mod-loader`
- Reason:
  - keep bootstrap code out of patch-pack and make the loader a first-class subsystem beside `api/*` and `mods/*`.

## 2026-03-05: app-server-tweaks (main mod)

- Added `mods/app-server-tweaks` as a main-process mod.
- Purpose:
  - force `persistExtendedHistory=true` on thread-detail calls so legacy chat history keeps loading after Codex CLI upgrades.
- Implementation:
  - wraps `electron.ipcMain` listeners and rewrites matching request objects in-place (no renderer bundle patching).
- It must not touch:
  - `thread/list`
  - any `*/list`
  - `thread/realtime/*`
- Reason:
  - list endpoints become much slower and can hold the UI on the center spinner.

## 2026-03-05: Renderer injection format

- `webContents.executeJavaScript()` must receive real source code with real newlines.
- Do not build injected scripts with literal `\\n` outside string literals.
- Failure signature:
  - renderer console: `SyntaxError: Invalid or unexpected token`
  - main log: `renderer mod failed (...)`

## 2026-03-05: Limits panel contract

- `mods/webview-settings-limits-panel` must poll `/wham/usage` over the Electron fetch bridge.
- The sidebar panel must show remaining quota, matching Settings (`x% left`), not raw `used_percent`.
- Do not parse Settings DOM text; generic text scraping drifts and mirrors unrelated values.
- Prefer the general root limit entry (`limitName == null`) and select only the closest 5h/weekly windows.

## 2026-03-05: Grouped sidebar thread cap

- `mods/webview-thread-list-cap` keeps grouped project lists at 6 rows before expansion.
- It must first trigger the native React `Show more`, because rows after the bundled 10-item cap do not exist in the DOM until then.
- It now matches visible sidebar lists by structure (`native toggle row inside sidebar`) instead of one exact `aria-label`.
- After native expansion, the mod hides rows after 6 and renders its own compact toggle.

## 2026-03-06: Sidebar-first UI anchoring

- Renderer mods that inject persistent UI must anchor to the best visible sidebar container first, not to one brittle text node.
- Specific buttons like `Settings` may still be used as preferred insertion anchors inside that sidebar, but they are no longer the root selector.
