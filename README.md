# 🚀 Codex-Windows (EN)

> [!IMPORTANT]
> 🌐 **Language Switch**: [🇺🇸 English](README.md) | [🇷🇺 Русский](README.ru.md) | [🇨🇳 简体中文](README.zh-CN.md)

> [!TIP]
> 🧭 Windows-first Codex repack pipeline with a **Node.js orchestration core** and a **thin PowerShell adapter**.

## ✨ What You Get

- 🧩 Extract `app.asar` from `Codex.dmg`
- 🛠️ Apply Windows runtime patches (`PATH`, shell tools, CLI resolution)
- ✅ Validate native modules (`better-sqlite3`, `node-pty`) from donor/seed artifacts
- ⚡ Run Codex directly from `work/` (direct mode)
- 📦 Build portable output in `dist/`
- 🧷 Optionally build a single self-extracting EXE (7-Zip SFX)

## 🏗️ Architecture (At a Glance)

```text
run.cmd / build.cmd
  -> scripts/run.ps1          (thin entry adapter)
    -> scripts/node/run.js    (compiled runner)
      -> scripts/ts/run.ts    (source orchestrator)
        -> extract -> patch -> native validate -> package -> launch
```

- 📁 File operations (copy/move/delete) use Node `fs` with retries
- 🚫 No fragile shell one-liners for pipeline file management
- 📂 `app.asar` extraction is native Node-based (no `npm exec asar` dependency)

## 🧰 Requirements

- 🪟 Windows 10/11
- 🟢 Node.js
- 🧠 Codex CLI: `npm i -g @openai/codex`
- 🗜️ 7-Zip (`7z`) available (PATH or `winget` install path)
- 🔎 `rg` (ripgrep) is auto-resolved (PATH -> winget -> portable fallback)

> [!NOTE]
> - Default flow does **not** require Python / Visual Studio Build Tools.
> - Native rebuild via `node-gyp` is disabled by default policy in this repo.

## 📥 Prepare DMG

- Version monitor: [codex-version-monitor.vercel.app](https://codex-version-monitor.vercel.app/)
- Place DMG here:

```text
C:\Codex-Windows\Codex.dmg
```

## ⚡ Quick Start

1. Install Codex CLI:

```powershell
npm i -g @openai/codex
```

2. Run direct mode:

```cmd
run.cmd
```

3. Build portable:

```cmd
build.cmd -DmgPath .\Codex.dmg
```

## 🖥️ Command Cheat Sheet

| Scenario | Command |
|---|---|
| Direct run | `run.cmd` |
| Direct run with DMG | `run.cmd -DmgPath .\Codex.dmg` |
| Portable build | `build.cmd -DmgPath .\Codex.dmg` |
| Single EXE build | `build.cmd -DmgPath .\Codex.dmg -SingleExe` |
| Node runner (run) | `node .\scripts\node\run.js run -DmgPath .\Codex.dmg` |
| Node runner (build) | `node .\scripts\node\run.js build -DmgPath .\Codex.dmg` |

## 🎛️ Useful Options

- `-WorkDir .\work`
- `-DistDir .\dist`
- `-Reuse`
- `-NoLaunch`
- `-CodexCliPath C:\path\to\codex.exe`
- `-SingleExe`
- `-DevProfile`
- `-ProfileName dev`
- `-PersistRipgrepPath`

## 📦 Output Layout

Portable output:

```text
dist\Codex-win32-x64\Codex.exe
dist\Codex-win32-x64\Launch-Codex.cmd   (recommended entrypoint)
```

Single-file output:

```text
dist\Codex-win32-x64-single.exe
```

## 🧪 Dev Profile Isolation

Use `-DevProfile` or `-ProfileName <name>` to isolate your environment:

- `work\userdata-<profile>`
- `work\cache-<profile>`
- `work\state.manifest.<profile>.json`
- `work\diagnostics\<profile>\cli-resolution.log`

## 🧯 Troubleshooting

### 🔒 `rejected: blocked by policy`

This is a **Codex tool policy restriction**, not Windows PowerShell `ExecutionPolicy`.

Recommendations:

- ✅ Prefer project pipeline commands (`run.cmd`, `build.cmd`)
- ❌ Avoid nested one-liners (`pwsh -> cmd /c -> ...`)
- 🧹 For emergency cleanup in restricted env, use:

```cmd
cmd /d /c "if exist ""C:\path\dir"" rd /s /q ""C:\path\dir"""
```

### 🧵 Quoting/path issues in manual commands

Unsafe pattern in PowerShell:

```cmd
cmd /c if not exist ... & if not exist ...
```

Safer pattern:

```cmd
cmd /d /c "if not exist ""C:\A"" mkdir ""C:\A"" && if not exist ""C:\B"" mkdir ""C:\B"""
```

## ✅ Verify Windows Contract Inside Codex

```cmd
cmd /c where node
cmd /c where powershell
cmd /c node -v
cmd /c powershell -NoProfile -Command "$PSVersionTable.PSVersion.ToString()"
```

## ❓ Why Both `.ts` and `.js` Exist

- `scripts/ts/*` -> source code
- `scripts/node/*` -> compiled artifacts consumed by launcher/runtime

## ⚠️ Disclaimer

- This is not an official OpenAI project.
- Do not redistribute OpenAI binaries or `Codex.dmg`.
