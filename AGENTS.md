# AGENTS Notes

## 2026-03-03: Codex App vs Codex CLI request identity audit

- Investigated `dist/Codex-win32-x64/resources/app/.vite/build/main.js` and `preload.js` for request identity/signature behavior.
- Verified App injects desktop auth headers when proxying eligible requests:
  - `Authorization: Bearer <token>`
  - `ChatGPT-Account-Id` (derived from token)
  - `originator: Codex Desktop`
  - `User-Agent: Codex Desktop/<version> (<platform>; <arch>)`
- Verified App exposes session/build identity through Electron bridge (`codexAppSessionId`, build flavor).
- Verified telemetry sink marks events with source `codex-desktop` and `codex.app_session_id`.
- Verified bundled CLI path resolution in App runtime via `CODEX_CLI_PATH` and `resources/codex.exe` fallback.
- CLI is bundled as binary (`resources/codex.exe`) in this workspace; no full CLI source available here.
- Binary string scan indicates CLI has ChatGPT auth/header logic and an originator override path, but exact complete header contract cannot be fully reconstructed from binary strings alone.

## Important context

- This workspace contains a Windows runtime shim block (`CODEX-WINDOWS-ENV-SHIM-V7`) inside packaged main bundle; behavior may include local patching beyond upstream baseline build.

## 2026-03-03: Windows open-file path click fix

- Fixed path normalization for Windows file open flow to prevent `\ The system cannot find device specified`.
- Applied in repack patch pipeline (`scripts/ts/lib/launch.ts`, `scripts/node/lib/launch.js`) and directly to current packaged runtime bundle.
- Normalization now strips accidental drive-prefix slashes (`\C:\...`, `/C:/...`) and keeps UNC paths intact.
- Shell open hooks now sanitize paths for `shell.openPath` and `shell.showItemInFolder`.
