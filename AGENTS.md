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
- Applied in repack patch pipeline (`scripts/ts/lib/platform-patches/bundle-patches.ts`, `scripts/node/lib/platform-patches/bundle-patches.js`) and directly to current packaged runtime bundle.
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

## 2026-03-05: Webview Mod Crash Fix (Frozen electronBridge)

- Symptom: black screen / no content with renderer console error:
  - `TypeError: Cannot assign to read only property 'sendMessageFromView' of object '#<Object>'`
- Root cause: on newer Codex builds `electronBridge` is exposed by `contextBridge` as a read-only/frozen object. Renderer-level mods must not mutate it.
- Fix:
  - Renderer mods must be DOM-only and injected by the main-process mod loader (no direct bundle monkeypatching).
  - Feature UI tweaks (limits panel, disable logout, etc) are now runtime mods under `shared/codex-mod-loader/mods/*` and are injected with `webContents.executeJavaScript`.
  - App-server behavior tweaks are main-process mods (no webview bundle patching):
    - `mods/app-server-tweaks` rewrites `thread/*` IPC request payloads to enforce `persistExtendedHistory=true` and change the default collapsed `thread/list` limit (10 -> 6).

## 2026-03-06: Cleanup bias toward smaller runtime and smaller pipeline

- Removed dead `shared/patch-pack/source-parity-smoke.mjs`; parity checks now live only where they are executed, not as an unowned side tool.
- Removed synthetic `test-mod-conflict` fixture from daily/manual flows; preflight remains the only required patch-pack gate.
- `shared/manual-sync/*` is now kept as contracts + current reports only; historical one-off JSON reports are treated as disposable artifacts.
- Old repack DMGs, stale `dist/*`, stale `work/*`, and stale reverse/manual-sync run directories should be deleted aggressively instead of retained in-repo.

## 2026-03-06: Repack determinism rules

- Repack/verify must ignore inherited `CODEX_*` runtime variables from the parent shell.
- Portable outputs must carry their own `build-metadata.json` so a broken artifact can be traced back to:
  - DMG input
  - patch profile
  - bundled CLI source
- Portable launch must explicitly point to bundled:
  - `resources/codex.exe`
  - `resources/mods`
- Reason:
  - the main regression class now is not missing patches, but hidden coupling to stale local builds and stale environment variables.

## 2026-03-06: dist is canonical, temporary outputs live under work

- `dist\\` should expose only canonical outputs and launchers.
- If the canonical portable output directory is busy, fallback outputs must go under:
  - `work\\portable-output\\*`
- `dist\\Launch-Codex-latest.cmd` is the canonical launcher entrypoint for the newest default build.
- Reason:
  - temporary `-work` / `-next*` outputs inside `dist` created repeated launches of stale artifacts.

## 2026-03-06: Repack code is now split into four responsibility lanes

- `scripts/ts/lib/source-bundle/*`
  - upstream bundle intake (`dmg`, `asar`, extraction)
- `scripts/ts/lib/runtime-donor/*`
  - Windows donor discovery and native/runtime reuse
- `scripts/ts/lib/runtime-pack/*`
  - portable artifact assembly and launcher generation
- `scripts/ts/lib/platform-patches/*`
  - platform-critical patch selection and execution
- Goal:
  - less cross-coupling
  - fewer hidden fallback paths
  - easier migration toward a Forge-like modding model

## 2026-03-06: Official Windows Codex is a runtime donor, not the logic source of truth

- Official Windows package under `C:\\Program Files\\WindowsApps\\OpenAI.Codex_*` is now a first-class donor source for Windows runtime artifacts.
- It is especially relevant for:
  - native modules
  - bundled Windows companion tools
  - future runtime-pack alignment
- The freshest upstream app logic can still come from DMG snapshots; donor/runtime concerns are separate from source-bundle concerns.

## 2026-03-06: Global CODEX_HOME state is a likely startup blocker; isolated-home is now a first-class diagnostic lane

- Portable runtime lanes that share the real `C:\\Users\\lensm\\.codex` can stall at a gray-screen stage even when:
  - CLI handshake succeeds
  - `Handled 'ready' message` appears
  - there are no `SyntaxError`, preload failures, or renderer mod failures
- The new launcher lane:
  - `Launch-Codex-isolated-home.cmd`
  redirects `CODEX_HOME` into the portable artifact and disables runtime mods.
- On short donor-first smoke runs this isolated lane showed materially healthier startup behavior than shared-home lanes:
  - very fast `account/read` and `thread/list`
  - `app/list` already appears in the first short window
  - no early `git-origin-and-roots` spam
  - no early `Failed to backfill app thread title`
- Current strongest suspects inside the real `C:\\Users\\lensm\\.codex` are:
  - `.codex-global-state.json` (contains stale workspace/worktree/thread UI state)
  - `state_5.sqlite` and its WAL-backed live state
- Practical rule:
  - when debugging gray-screen startup, bisect `shared .codex` vs `isolated-home` before blaming mods or patch-pack.
