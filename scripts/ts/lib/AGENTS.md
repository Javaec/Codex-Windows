# Runner Lib AGENTS

## 2026-03-05: Forge-like split (platform patches vs feature mods)

- Platform patches stay in patch-pack (build/repack time):
  - preload bridge
  - webview sunset bypass
  - webview cwd normalization (optional by profile)
  - main Windows runtime shim (env + SQLite path normalization + open-path fix)

- Feature UI tweaks moved out of obfuscated webview bundle patching:
  - runtime modpack under `C:\\Codex-Windows\\shared\\codex-mod-loader\\mods\\*`
  - portable builds bundle it into `resources\\mods\\*`
  - injected by the main runtime shim on `dom-ready` via `webContents.executeJavaScript`
  - must be DOM-only and must not mutate `window.electronBridge` (it can be frozen/read-only)

## 2026-03-05: Launcher sanitizer must include global Codex state

- `sanitizeWorkspaceRegistry(...)` must scan not only run-local `userdata`, but also:
  - `%APPDATA%\\Codex`
  - `CODEX_HOME` / `%USERPROFILE%\\.codex`
- `.codex-global-state.json` is an explicit candidate, even if it does not match generic filename heuristics.
- Reason:
  - stale workspace/worktree references that cause `git-origin-and-roots` noise live in global state, not only in portable launch state.

## 2026-03-05: Native donor/seed discovery must ignore workdir depth

- Native recovery must not derive repo root from `path.dirname(workDir)` only.
- Version-isolated runs like `work/11012-test` must still discover donors from the real repo root:
  - `C:\\Codex-Windows\\dist\\*\\resources\\app`
  - `C:\\Codex-Windows\\scripts\\native-seeds\\<arch>\\app`
- Implementation rule:
  - collect repo-root candidates from `process.cwd()`, script location, and upward walk from `workDir`;
  - then scan donors/seeds from those roots.
- Reason:
  - otherwise patching succeeds for new versions, but native stage fails falsely with
    `No usable native artifacts found...` only because discovery looked under `work\\dist` instead of repo `dist`.

## 2026-03-05: Preload patch must survive comma-operator bundles

- New preload bundles can chain top-level side effects with comma operators:
  - `ipcRenderer.on(...),contextBridge.exposeInMainWorld(...)`
- Injected process bridge must therefore be prefixed with an explicit statement break:
  - consume the leading comma before the anchor and replace it with a statement boundary
  - result shape:
    - `...);const __codexWindowsProcessBridge=...;contextBridge.exposeInMainWorld(...)`
- Reason:
  - plain insertion before the anchor generates invalid syntax (`...,const ...` or `...),;const ...`) and portable builds fail at runtime with:
    - `Unable to load preload script`
    - `SyntaxError: Unexpected token 'const'`

## 2026-03-05: Expected-recovery paths must log as info, not warnings

- Tolerated recovery paths are not regressions and must not pollute the warning channel:
  - optional patch skips for unknown obfuscation signatures,
  - `7z` exit codes when required payload files are already present,
  - native cache misses followed by donor/seed recovery.
- Keep warnings only for real blockers or for validations that still fail at the end of the stage.
