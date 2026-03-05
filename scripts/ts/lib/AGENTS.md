# Runner Lib AGENTS

## 2026-03-05: Forge-like split (platform patches vs feature mods)

- Platform patches stay in patch-pack (build/repack time):
  - preload bridge
  - webview sunset bypass
  - webview cwd normalization (optional by profile)
  - webview thread cap (10 -> 6)
  - webview persistExtendedHistory=true
  - main Windows runtime shim (env + SQLite path normalization + open-path fix)

- Feature UI tweaks moved out of obfuscated webview bundle patching:
  - runtime modpack under `C:\\Codex-Windows\\shared\\codex-mod-loader\\mods\\*`
  - portable builds bundle it into `resources\\mods\\*`
  - injected by the main runtime shim on `dom-ready` via `webContents.executeJavaScript`
  - must be DOM-only and must not mutate `window.electronBridge` (it can be frozen/read-only)

