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

## 2026-03-04: Repack runbook for new obfuscation (must keep)

### Patch 1: Webview app sunset gate (Update required)

- Failure signature in repack:
  - `=== Patching webview app sunset gate ===`
  - `[ERROR] webview app sunset patch point not found.`
- Failure signature at runtime:
  - `This version of the app is no longer supported. Please download the latest version here.`
- Required behavior:
  - `patchWebviewAppSunsetGate` must be signature-tolerant for obfuscation drift.
  - Keep legacy direct needles and add new ones when bundle changes (for example `const s=ys(i);if(r){`).
  - Keep semantic fallback by markers `appSunset.title` / `Update required`.
  - Accept both React call styles when finding rendered branch:
    - `h.jsx/h.jsxs`
    - `f.jsx/f.jsxs`
  - Patch must set gate boolean to false (`const <gateVar>=!1;`) in the sunset branch.
  - If no patch point is found for current signature, log warning (best-effort) instead of aborting full repack.

### Patch 2: Webview cwd normalization

- This patch is optional by signature and must not hard-fail repack for unknown bundle shapes.
- If matcher misses current obfuscation signature:
  - log warning
  - continue repack.
- Goal:
  - normalize path comparison in webview code for Windows forms (`\\` vs `/`, `//?/`, `/??/`, leading `/C:/`).

### Patch 3: Bundled CLI priority on run/build

- Runtime must prefer local bundled CLI from repacked output:
  - `dist/Codex-win32-x64/resources/codex.exe` (or arm64 equivalent)
- Do not prefer global npm vendor CLI when bundled binary exists.
- Reason:
  - avoid contract drift between app-server versions and prevent chat/session behavior mismatches.

### SQLite path escaping/migration (critical for chat list on new builds)

- Problem:
  - `threads.cwd` can be rewritten by runtime with Windows prefix `\\?\` even after startup migration.
  - this breaks path-sensitive flows and can hide chat history in some builds.
- Required normalization targets:
  - `threads.cwd`
  - `threads.rollout_path`
- Required normalized forms:
  - strip prefixes: `\\?\`, `//?/`, `/??/`
  - strip malformed leading slash before drive path: `\C:\...`, `/C:/...`
- Implementation requirements:
  - keep startup row-level migration (deterministic per-row update, not only fragile bulk SQL patterns).
  - add SQLite triggers for both columns:
    - after insert
    - after update of column
  - trigger body must rewrite value to normalized form for `NEW.id`.
- Verification after launch:
  - `select count(*) from threads where typeof(cwd)='text' and substr(hex(cwd),1,8)='5C5C3F5C';` => `0`
  - `select count(*) from threads where typeof(rollout_path)='text' and substr(hex(rollout_path),1,8)='5C5C3F5C';` => `0`
  - `select name from sqlite_master where type='trigger' and name like 'codex_windows_threads_%_normalize_%';` => triggers exist.
