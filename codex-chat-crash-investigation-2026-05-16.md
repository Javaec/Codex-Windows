# Codex Chat Crash Investigation - 2026-05-16

## Context

Workspace: `C:\Codex-Windows`

Reported affected app:

`C:\Program Files\WindowsApps\OpenAI.Codex_26.513.3673.0_x64__2p2nqsd0c76g0\app`

The user reports that after the latest Codex update chats can start, but fail mid-conversation with:

```text
Oops, an error has occurred
Check for updates
Try again
```

The user also expects this current chat may break, so this file is being kept as the durable investigation log.

## User Request

```text
У меня после последнего обновления Codex  (C:\Program Files\WindowsApps\OpenAI.Codex_26.513.3673.0_x64__2p2nqsd0c76g0\app)

Ломаются чаты. Чат можно начать но где-то в средине чата идёт ошибка.

Oops, an error has occurred
Check for updates
Try again

И прикол в том что даже этот чат сломается.

Поэтому делай вывод этого чата вот текущего в .md документ

И сразу после расследования пытайся чинить. Есть шанс что именно в конце чата ошибка идёт
```

## Working Notes

- Created this Markdown file first so the active chat has a local durable copy.
- Repository state at start:
  - Branch: `main`
  - Status: `main...origin/main [ahead 2]`
  - Untracked files present before this work:
    - `Setup-Codex/Setup-Codex.zip`
    - `codex-26-506-31421.zip`
- Investigation and fix notes will be appended below as they happen.

## 2026-05-16 09:24 MSK - Investigation Result

- Fresh installed package exists at the reported path and was updated on 2026-05-16 morning.
- The current `C:\Users\lensm\.codex\state_5.sqlite` had `212` rows with `threads.cwd` stored as extended Windows paths like `\\?\C:\Codex-Windows`.
- The required DB triggers were missing:
  - `codex_windows_threads_cwd_normalize_insert`
  - `codex_windows_threads_cwd_normalize_update`
  - `codex_windows_threads_rollout_path_normalize_insert`
  - `codex_windows_threads_rollout_path_normalize_update`
- Recent `logs_2.sqlite` errors were tool timeout/exit logs from this investigation, not the original UI crash.
- Strong current hypothesis: the official updated app reintroduced `\\?\...` thread cwd values because it does not run the repack runtime shim; renderer/thread-list code can then hit malformed Windows path state during chat/list/detail refresh.

## 2026-05-16 09:24 MSK - Live Repair Applied

- Created SQLite backup:
  - `C:\Users\lensm\.codex\backups\state_5-before-thread-path-normalize-20260516-092434.sqlite`
- Normalized live `threads.cwd` and `threads.rollout_path`.
- Installed the four DB-level normalization triggers.
- Verification after repair:
  - `cwd_prefixed = 0`
  - `rollout_prefixed = 0`
  - current thread cwd is `C:\Codex-Windows`

## 2026-05-16 09:27 MSK - Repo Fix Added

- Added `Repair-Codex-Chats.cmd`.
- Added `Setup-Codex/internal/Repair-Codex-ThreadPaths.ps1`.
- The repair command backs up `state*.sqlite`, normalizes malformed Windows thread paths, and installs the same DB triggers.
- Tested on a temporary SQLite database under `work/thread-path-repair-test`:
  - existing malformed `cwd` and `rollout_path` rows normalized;
  - all four triggers created;
  - later INSERT/UPDATE writes with `\\?\...` were normalized by triggers.

## 2026-05-16 09:30 MSK - Final Verification

- Ran `Repair-Codex-Chats.cmd -NoBackup` against the live Codex home:
  - `before=0`
  - `after=0`
  - `normalized=0`
- Live DB verification:
  - `cwd_prefixed = 0`
  - `rollout_prefixed = 0`
  - normalization trigger count = `4`
- Ran project verification:
  - `verify.cmd`
  - result: `OK=19 WARN=0 FAIL=0`

## 2026-05-16 09:44 MSK - Alternative 26.506 Build Path

- Rebuilt `build.cmd` path for `codex-26-506-31421.zip`.
- Found that the latest installed Windows `Codex.exe` (`26.513.3673.0`) can exit before loading `resources/app`; the runtime shim log is never created in that lane.
- Added `CODEX_WINDOWS_USE_ELECTRON_DIST_RUNTIME=1` for `build.cmd`, so the portable build uses plain Electron `41.2.0` instead of the latest packaged Codex shell.
- Fixed the internal setup runner compiler path so TypeScript changes compile through the repo-root `node_modules`.
- Fixed portable notification bundling for donor `codex-notification.wav`.
- Built canonical portable output:
  - `C:\Codex-Windows\dist\Codex-win32-x64`
  - app version `26.506.31421`
  - Electron runtime source `electron-dist-cache`
  - bundled notification sound present
- Smoke improved from "no app startup" to live app startup:
  - `cli_initialized=1`
  - `dom_ready=3`
  - `thread_list=2`
  - `app_list=2`
  - remaining smoke failures are extra usability/render-process counters, not a failure to load the main app.
- Launched the alternative Codex from:
  - `C:\Codex-Windows\dist\Launch-Codex-latest.cmd`
- Verified live launched process and shim:
  - `C:\Codex-Windows\dist\Codex-win32-x64\Codex.exe`
  - `C:\Codex-Windows\dist\Codex-win32-x64\resources\codex.exe`
  - `shim-startup.log` shows `disable-single-instance 1`.
- Ran `verify.cmd` after the change:
  - result: `OK=19 WARN=0 FAIL=0`
