# 🚀 Codex-Windows (EN)

> [!IMPORTANT]
> ## 🌐 Language Switcher
> **✨ [🇺🇸 English](README.md) | [🇷🇺 Русский](README.ru.md) | [🇨🇳 简体中文](README.zh-CN.md) ✨**

> [!TIP]
> ## 🪟💯 100% Windows Runtime Support
> - ✅ `Node.js` works inside Codex
> - ✅ `PowerShell` / `pwsh` work inside Codex
> - ✅ `PATH` is normalized for Windows tools (`cmd`, `where`, `npm`, `git`)
> - ✅ Native Windows commands run reliably

Windows-first Codex repack flow based on `reference/Codex-Windows-main-1`.

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

### 📥 Download the latest DMG

- Live version monitor: [codex-version-monitor.vercel.app](https://codex-version-monitor.vercel.app/)
- Use the latest `Codex.dmg` from there, then place it in:
  - `C:\Codex-Windows\Codex.dmg`

1. Put `Codex.dmg` in repository root:
   - `C:\Codex-Windows\Codex.dmg`
2. Install Codex CLI:

```powershell
npm i -g @openai/codex
```

## ▶️ Run (direct mode)

```cmd
run.cmd
```

If your DMG is in a custom location:

```cmd
run.cmd -DmgPath .\Codex.dmg
```

You can also launch by double-clicking `run.cmd`.

Options:

- `-WorkDir .\work`
- `-CodexCliPath C:\path\to\codex.exe`
- `-Reuse`
- `-NoLaunch`
- `-DevProfile` (uses isolated dev profile paths)
- `-ProfileName dev` (custom profile name; default is `default`)

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
- `-DevProfile`
- `-ProfileName dev`

## 🛠️ PowerShell examples

```powershell
.\scripts\run.ps1 -DmgPath .\Codex.dmg
.\scripts\run.ps1 -DmgPath .\Codex.dmg -BuildPortable
.\scripts\run.ps1 -DmgPath .\Codex.dmg -Reuse -NoLaunch
.\scripts\run.ps1 -DmgPath .\Codex.dmg -DevProfile -NoLaunch
```

## 🧪 Dev profile isolation

Use `-DevProfile` (or `-ProfileName <name>`) to isolate local development from your default profile.

- separate user data / cache directories (`work\userdata-<profile>`, `work\cache-<profile>`)
- separate state manifest (`work\state.manifest.<profile>.json`)
- separate CLI resolver trace (`work\diagnostics\<profile>\cli-resolution.log`)

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
