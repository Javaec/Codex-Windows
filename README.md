# 🚀 Codex-Windows: DMG -> Full Windows Runtime (English)

Windows-first Codex repack flow based on `reference/Codex-Windows-main-1`, improved for **100% practical Windows compatibility**:

- ✅ `Node.js` is visible inside Codex
- ✅ `PowerShell`/`pwsh` is visible inside Codex
- ✅ `PATH` is normalized for Windows tools (`cmd`, `where`, etc.)
- ✅ Native Windows command execution works as expected

## ✨ What this project does

- Extracts `app.asar` from `Codex.dmg`
- Rebuilds native modules for Windows (`better-sqlite3`, `node-pty`)
- Launches Codex from `work/` (direct mode)
- Builds a portable package in `dist/`

## 🧰 Requirements

- Windows 10/11
- Node.js
- Codex CLI: `npm i -g @openai/codex`
- 7-Zip (`7z` in PATH)  
  If missing, the script tries `winget` or a portable 7z download.

## 📦 Setup

1. Put `Codex.dmg` in repository root:
   - `C:\Codex-Windows\Codex.dmg`
2. Install Codex CLI:

```powershell
npm i -g @openai/codex
```

## ▶️ Run (direct mode)

```cmd
run.cmd -DmgPath .\Codex.dmg
```

Options:

- `-WorkDir .\work`
- `-CodexCliPath C:\path\to\codex.exe`
- `-Reuse`
- `-NoLaunch`

## 🧳 Build portable

```cmd
build.cmd -DmgPath .\Codex.dmg
```

Output:

- `dist\Codex-win32-x64\Codex.exe`
- `dist\Codex-win32-x64\Launch-Codex.cmd` (recommended entry point)

Options:

- `-WorkDir .\work`
- `-DistDir .\dist`
- `-Reuse`
- `-NoLaunch`
- `-CodexCliPath C:\path\to\codex.exe`

## 🛠️ PowerShell examples

```powershell
.\scripts\run.ps1 -DmgPath .\Codex.dmg
.\scripts\run.ps1 -DmgPath .\Codex.dmg -BuildPortable
.\scripts\run.ps1 -DmgPath .\Codex.dmg -Reuse -NoLaunch
```

## 🔍 Verify Windows compatibility in Codex

```cmd
cmd /c where node
cmd /c where powershell
cmd /c powershell -NoProfile -Command "$PSVersionTable.PSVersion.ToString()"
cmd /c node -v
```

## 🌍 Other languages

- Russian: `README.ru.md`
- Chinese: `README.zh-CN.md`

## ⚠️ Disclaimer

- This is not an official OpenAI project.
- Do not redistribute OpenAI binaries or `Codex.dmg`.
