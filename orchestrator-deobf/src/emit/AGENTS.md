# AGENTS.md

## Purpose
Keep the generated project runnable as a standalone source build (not only repack flow).

## 2026-03-04 Decisions
- Added desktop smoke support to generated project scaffold:
  - `package.json` script: `desktop:smoke`
  - emitted runtime files:
    - `runtime/desktop-main.cjs`
    - `runtime/desktop-smoke.mjs`
- Desktop smoke validates real Electron startup (`app-ready` + `window-ready`) against built `dist/index.html`.
- Electron executable resolution order is deterministic:
  1. `ELECTRON_EXE_PATH`
  2. `C:/Codex-Windows/work/ci-10711/native-builds/node_modules/electron/dist/electron.exe`
  3. `C:/Codex-Windows/work/native-builds/node_modules/electron/dist/electron.exe`

## Rules
- Fail fast if desktop entry or built index is missing.
- Do not add fallback-heavy runtime behavior in emitter for this path.
- Keep desktop smoke scripts minimal and reproducible.
