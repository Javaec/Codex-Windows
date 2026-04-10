# 🚀✨ Codex-Windows (ZH-CN)

> [!IMPORTANT]
> 🌍 **语言切换**: [🇺🇸 English](README.md) | [🇷🇺 Русский](README.ru.md) | [🇨🇳 简体中文](README.zh-CN.md)

> [!TIP]
> 🧭 面向 Windows 的 Codex 重打包与启动流水线，采用 **Node.js 编排核心** + **轻量 PowerShell 入口**。

---

## 🎯 项目作用

`Codex-Windows` 通过确定性的流水线在 Windows 上重打包并运行 Codex Desktop：

- 🧩 从 `Codex.dmg` 提取 `app.asar`
- 🛠️ 应用 Windows 运行时补丁（PATH/env/process guards/CLI 解析）
- 🔽 注入稳定的会话切换自动滚动到底部
- 🧹 清理 workspace registry + 维护 git capability cache
- 🧪 校验原生模块（`better-sqlite3`、`node-pty`）
- 📦 生成便携版或单文件 EXE

---

## 🧼 自动清理策略（基于 mtime）

流水线启动时，会按**最后修改时间**清理 `%USERPROFILE%\.codex`（或 `%CODEX_HOME%`）中的旧数据：

| 目标 | 规则 |
|---|---|
| `log/` | 超过 **7 天** 的文件 |
| `sessions/` | 超过 **10 天** 的文件 |
| `worktrees/` | 超过 **5 天** 的根目录（按目录内最新 mtime） |

> [!NOTE]
> ✅ 即使聊天创建较早，只要最近有修改，就不会被清理。

---

## 🏗️ 流水线架构

```text
run.cmd / build.cmd
  -> scripts/run.ps1
    -> Setup-Codex/node/run.js
      -> scripts/ts/run.ts
```

> [!IMPORTANT]
> `build.cmd` 默认以 `-NoLaunch` 运行（只构建，不自动启动应用）。

---

## 🧰 环境要求

- 🪟 Windows 10/11
- 🟢 Node.js
- 🤖 Codex CLI: `npm i -g @openai/codex`
- 🗜️ 7-Zip (`7z`)（用于 DMG 提取和单文件 EXE 打包）

> [!NOTE]
> - 默认流程不需要 Python / Visual Studio Build Tools。
> - `scripts/ts/*` 为源码，`scripts/node/*` 为编译后的运行时产物。

---

## ⚡ 快速开始

1. 安装 Codex CLI：

```powershell
npm i -g @openai/codex
```

2. 直接运行：

```cmd
run.cmd -DmgPath .\Codex.dmg
```

3. 构建便携版（不自动启动）：

```cmd
build.cmd -DmgPath .\Codex.dmg
```

---

## 🖥️ 命令速查

| 场景 | 命令 |
|---|---|
| ▶️ 直接运行 | `run.cmd` |
| ⏸️ 直接运行但不启动 | `run.cmd -NoLaunch` |
| 📦 构建便携版（默认不启动） | `build.cmd -DmgPath .\Codex.dmg` |
| 🧷 便携版 + 单文件 EXE | `build.cmd -DmgPath .\Codex.dmg -SingleExe` |
| 🧠 Node runner（run 模式） | `node .\scripts\node\run.js run -DmgPath .\Codex.dmg` |
| 🛠️ Node runner（build 模式） | `node .\scripts\node\run.js build -DmgPath .\Codex.dmg -NoLaunch` |

---

## 🎛️ 常用参数

| 参数 | 含义 |
|---|---|
| `-WorkDir .\work` | 自定义工作目录 |
| `-DistDir .\dist` | 自定义输出目录 |
| `-Reuse` | 复用可复用构建产物 |
| `-NoLaunch` | 跳过应用启动 |
| `-CodexCliPath <path>` | 指定 `codex.exe` 路径 |
| `-SingleExe` | 构建自解压 EXE |
| `-DevProfile` | 使用隔离 dev 配置 |
| `-ProfileName <name>` | 指定配置名称 |
| `-StrictContract` | 严格环境契约检查 |

品牌化覆盖变量：

- 🎨 `CODEX_ICON_PATH` - 自定义 `.ico`
- 🧱 `CODEX_RCEDIT_PATH` - 自定义 `rcedit.exe`

---

## 📁 输出结构

```text
dist\Codex-win32-x64\Codex.exe
dist\Codex-win32-x64\Launch-Codex.cmd
dist\Codex-win32-x64-single.exe   (使用 -SingleExe 时生成)
```

---

## ⚠️ 免责声明

- 本项目**不是** OpenAI 官方项目。
- 请勿分发 OpenAI 二进制文件或 `Codex.dmg`。
