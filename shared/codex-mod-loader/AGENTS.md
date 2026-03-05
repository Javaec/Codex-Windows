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
  - It must export a function (or `{ activate() }`) that receives `{ electron, buildHint, modId }`.
  - Use this for stable, version-tolerant behavior changes (IPC request rewrites, routing tweaks, etc).

## 2026-03-05: app-server-tweaks (main mod)

- Added `mods/app-server-tweaks` as a main-process mod.
- Purpose:
  - change the default collapsed thread list cap (`thread/list` limit 10 -> 6) while preserving "Show more/Show less",
  - force `persistExtendedHistory=true` on `thread/*` calls so legacy chat history keeps loading after Codex CLI upgrades.
- Implementation:
  - wraps `electron.ipcMain` listeners and rewrites matching request objects in-place (no renderer bundle patching).
