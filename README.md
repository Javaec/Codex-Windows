# Codex-Windows (DMG -> Full Windows Runtime)

This repository contains a practical Windows repack flow based on the
lightweight `Codex-Windows-main-1` approach, with one critical addition:
the launcher force-restores a full Windows runtime environment so Codex can
see standard Windows tools (`cmd`, `powershell`/`pwsh`, `node`, `where`, etc.).

## Why this exists

A common issue with DMG-based Codex runners on Windows is a broken process
environment (mostly `PATH`). In that case Codex can start, but inside it:

- `node` is "not found" even though Node is installed
- PowerShell commands fail
- even basic Windows tools are missing

This project fixes that by:

- rebuilding `PATH` from machine/user registry values
- prepending core Windows directories
- adding typical Node and PowerShell install paths
- setting `COMSPEC` and `CODEX_PWSH_PATH`
- applying an app-side environment shim
- patching `child_process` spawn/exec in app main process so every child process
  (including Codex CLI tool shells) gets a full Windows environment

## Quick start

1. Put your `Codex.dmg` in this repo root.
2. Make sure Node.js is installed.
3. Install Codex CLI:

```powershell
npm i -g @openai/codex
```

4. Run direct mode:

```cmd
run.cmd
```

5. Or build a portable Windows package:

```cmd
build.cmd
```

Portable output goes to:

- `dist\Codex-win32-x64` (or `dist\Codex-win32-arm64`)

## Commands

- `run.cmd`
  Extracts DMG, rebuilds native modules, launches Codex from `work\`.

- `build.cmd`
  Extracts/builds, then repacks to a portable Windows app folder and launches it.

## PowerShell usage

```powershell
.\scripts\run.ps1
.\scripts\run.ps1 -BuildPortable
.\scripts\run.ps1 -DmgPath .\Codex.dmg -Reuse
.\scripts\run.ps1 -BuildPortable -NoLaunch
```

## Notes

- This is not an official OpenAI project.
- Do not redistribute OpenAI binaries or DMG files.
