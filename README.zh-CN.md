# 🚀 Codex-Windows: DMG -> Full Windows Runtime（简体中文）

> ## 🌐 语言切换
> **[🇺🇸 English](README.md) | [🇷🇺 Русский](README.ru.md) | [🇨🇳 简体中文](README.zh-CN.md)**

这是一个基于 `reference/Codex-Windows-main-1` 的 Windows-first Codex 重打包方案，重点是实现 **100% 实用级 Windows 兼容性**：

- ✅ 在 Codex 内可直接识别 `Node.js`
- ✅ 在 Codex 内可直接识别 `PowerShell`/`pwsh`
- ✅ 自动修正 Windows `PATH`（`cmd`、`where` 等可用）
- ✅ 原生 Windows 命令执行稳定可用

## ✨ 项目功能

- 从 `Codex.dmg` 提取 `app.asar`
- 为 Windows 重新构建原生模块（`better-sqlite3`、`node-pty`）
- 从 `work/` 直接启动 Codex（direct mode）
- 构建便携版到 `dist/`

## 🧰 环境要求

- Windows 10/11
- Node.js
- Codex CLI：`npm i -g @openai/codex`
- 7-Zip（`7z` 在 PATH 中）  
  若未安装，脚本会尝试使用 `winget` 或下载便携版 7z。

## 📦 准备步骤

### 📥 获取最新 DMG

- 版本监控页面：[codex-version-monitor.vercel.app](https://codex-version-monitor.vercel.app/)
- 从该页面下载最新 `Codex.dmg`，并放到：
  - `C:\Codex-Windows\Codex.dmg`

1. 将 `Codex.dmg` 放到仓库根目录：
   - `C:\Codex-Windows\Codex.dmg`
2. 安装 Codex CLI：

```powershell
npm i -g @openai/codex
```

## ▶️ 运行（direct mode）

```cmd
run.cmd -DmgPath .\Codex.dmg
```

可选参数：

- `-WorkDir .\work`
- `-CodexCliPath C:\path\to\codex.exe`
- `-Reuse`
- `-NoLaunch`

## 🧳 构建便携版

```cmd
build.cmd -DmgPath .\Codex.dmg
```

输出：

- `dist\Codex-win32-x64\Codex.exe`
- `dist\Codex-win32-x64\Launch-Codex.cmd`（推荐入口）

可选参数：

- `-WorkDir .\work`
- `-DistDir .\dist`
- `-Reuse`
- `-NoLaunch`
- `-CodexCliPath C:\path\to\codex.exe`

## 🛠️ PowerShell 示例

```powershell
.\scripts\run.ps1 -DmgPath .\Codex.dmg
.\scripts\run.ps1 -DmgPath .\Codex.dmg -BuildPortable
.\scripts\run.ps1 -DmgPath .\Codex.dmg -Reuse -NoLaunch
```

## 🔍 在 Codex 内验证 Windows 兼容性

```cmd
cmd /c where node
cmd /c where powershell
cmd /c powershell -NoProfile -Command "$PSVersionTable.PSVersion.ToString()"
cmd /c node -v
```

## 🌍 其他语言

- English（默认）：`README.md`
- Russian：`README.ru.md`

## ⚠️ 免责声明

- 本项目不是 OpenAI 官方项目。
- 请勿分发 OpenAI 二进制文件或 `Codex.dmg`。
