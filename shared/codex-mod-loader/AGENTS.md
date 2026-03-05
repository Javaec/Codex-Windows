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

