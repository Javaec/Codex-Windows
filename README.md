# 🚀✨ Codex-Windows (EN)

> [!IMPORTANT]
> 🌍 **Language Switch**: [🇺🇸 English](README.md) | [🇷🇺 Русский](README.ru.md) | [🇨🇳 简体中文](README.zh-CN.md)

> [!TIP]
> 🧭 Windows-first Codex repack + launch pipeline with a **Node.js orchestration core** and a **thin PowerShell entrypoint**.

---

## 🎯 What This Project Is

`Codex-Windows` repacks and runs Codex Desktop on Windows with a deterministic pipeline:

- 🧩 Extract `app.asar` from `Codex.dmg`
- 🛠️ Apply Windows runtime patches (PATH/env/process guards/CLI resolution)
- 🔽 Inject reliable chat auto-scroll on thread switch
- 🧹 Sanitize workspace registry + maintain git capability cache
- 🧪 Validate native modules (`better-sqlite3`, `node-pty`)
- 📦 Build portable output or single-file EXE

---

## 🧼 Automatic Cleanup Policy (mtime-based)

At pipeline start, stale data in `%USERPROFILE%\.codex` (or `%CODEX_HOME%`) is cleaned by **last modified time**:

| Target | Rule |
|---|---|
| `log/` | files older than **7 days** |
| `sessions/` | files older than **10 days** |
| `worktrees/` | roots older than **5 days** (based on latest mtime inside tree) |

> [!NOTE]
> ✅ Old chats/sessions are kept if they were modified recently.

---

## 🏗️ Pipeline Architecture

```text
run.cmd / build.cmd
  -> scripts/run.ps1
    -> Setup-Codex/node/run.js
      -> scripts/ts/run.ts
```

> [!IMPORTANT]
> `build.cmd` runs build mode with `-NoLaunch` by default (build only, no auto-start).

---

## 🧰 Requirements

- 🪟 Windows 10/11
- 🟢 Node.js
- 🤖 Codex CLI: `npm i -g @openai/codex`
- 🗜️ 7-Zip (`7z`) for DMG extraction and single EXE packaging

> [!NOTE]
> - Python / Visual Studio Build Tools are **not required** for default flow.
> - `scripts/ts/*` = source, `scripts/node/*` = compiled runtime artifacts.

---

## ⚡ Quick Start

1. Install Codex CLI:

```powershell
npm i -g @openai/codex
```

2. Direct run:

```cmd
run.cmd -DmgPath .\Codex.dmg
```

3. Portable build (no auto-launch):

```cmd
build.cmd -DmgPath .\Codex.dmg
```

---

## 🖥️ Command Cheat Sheet

| Scenario | Command |
|---|---|
| ▶️ Direct run | `run.cmd` |
| ⏸️ Direct run without launch | `run.cmd -NoLaunch` |
| 📦 Portable build (default no launch) | `build.cmd -DmgPath .\Codex.dmg` |
| 🧷 Portable build + single EXE | `build.cmd -DmgPath .\Codex.dmg -SingleExe` |
| 🧠 Node runner (run mode) | `node .\scripts\node\run.js run -DmgPath .\Codex.dmg` |
| 🛠️ Node runner (build mode) | `node .\scripts\node\run.js build -DmgPath .\Codex.dmg -NoLaunch` |

---

## 🎛️ Useful Options

| Option | Meaning |
|---|---|
| `-WorkDir .\work` | custom work directory |
| `-DistDir .\dist` | custom output directory |
| `-Reuse` | reuse reusable pipeline artifacts |
| `-NoLaunch` | skip application launch |
| `-CodexCliPath <path>` | explicit `codex.exe` path |
| `-SingleExe` | build self-extracting EXE |
| `-DevProfile` | use isolated dev profile |
| `-ProfileName <name>` | named profile isolation |
| `-StrictContract` | strict environment contract checks |

Branding overrides:

- 🎨 `CODEX_ICON_PATH` - custom `.ico`
- 🧱 `CODEX_RCEDIT_PATH` - custom `rcedit.exe`

---

## 📁 Output Layout

```text
dist\Codex-win32-x64\Codex.exe
dist\Codex-win32-x64\Launch-Codex.cmd
dist\Codex-win32-x64-single.exe   (when -SingleExe is used)
```

---

## ⚠️ Disclaimer

- This is **not** an official OpenAI project.
- Do not redistribute OpenAI binaries or `Codex.dmg`.
