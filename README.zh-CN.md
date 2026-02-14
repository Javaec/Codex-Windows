# 🚀 Codex-Windows (ZH-CN)

> [!IMPORTANT]
> 🌐 **语言切换**: [🇺🇸 English](README.md) | [🇷🇺 Русский](README.ru.md) | [🇨🇳 简体中文](README.zh-CN.md)

> [!TIP]
> 🧭 Windows-first Codex 重打包流程，采用 **Node.js 编排核心** + **轻量 PowerShell 适配入口**。

## ✨ 你将获得

- 🧩 从 `Codex.dmg` 提取 `app.asar`
- 🛠️ 应用 Windows 运行时补丁（`PATH`、shell 工具、CLI 解析）
- 🧼 启动前自动清理 workspace registry 并剪枝失效路径
- 🗃️ Git capability cache（缓存缺失 ref / 无效 cwd，减少重复 `rev-parse` 循环）
- 🛡️ 运行时幂等守卫 + IPC 关闭监督器，进程退出更干净
- ✅ 从 donor/seed 工件校验原生模块（`better-sqlite3`、`node-pty`）
- ⚡ 从 `work/` 目录直接运行 Codex（direct mode）
- 📦 在 `dist/` 生成便携版
- 🧷 可选生成单文件 EXE（7-Zip SFX）

## 🏗️ 架构速览

```text
run.cmd / build.cmd
  -> scripts/run.ps1          (轻量入口适配)
    -> scripts/node/run.js    (编译后的 runner)
      -> scripts/ts/run.ts    (源码编排器)
        -> extract -> patch -> native validate -> package -> launch
```

- 📁 文件操作（复制/移动/删除）统一走 Node `fs` + 重试
- 🚫 尽量避免脆弱的 shell one-liner
- 📂 `app.asar` 解包使用原生 Node extractor（不依赖 `npm exec asar`）
- 🧱 Core pipeline 与 adapters 分层（`scripts/ts/lib/adapters/*`），更易迁移到其他游戏/包装器

## 🧰 环境要求

- 🪟 Windows 10/11
- 🟢 Node.js
- 🧠 Codex CLI：`npm i -g @openai/codex`
- 🗜️ 7-Zip（`7z` 可用，PATH 或 `winget`）
- 🔎 `rg`（ripgrep）自动解析（PATH -> winget -> portable fallback）

> [!NOTE]
> - 默认流程 **不需要** Python / Visual Studio Build Tools。
> - 本仓库默认策略下不启用 `node-gyp` 原生重编译。

## 📥 准备 DMG

- 版本监控：[codex-version-monitor.vercel.app](https://codex-version-monitor.vercel.app/)
- 将 DMG 放在：

```text
C:\Codex-Windows\Codex.dmg
```

## ⚡ 快速开始

1. 安装 Codex CLI：

```powershell
npm i -g @openai/codex
```

2. 直接运行：

```cmd
run.cmd
```

3. 构建便携版：

```cmd
build.cmd -DmgPath .\Codex.dmg
```

## 🖥️ 命令速查

| 场景 | 命令 |
|---|---|
| 直接运行 | `run.cmd` |
| 指定 DMG 运行 | `run.cmd -DmgPath .\Codex.dmg` |
| 构建便携版 | `build.cmd -DmgPath .\Codex.dmg` |
| 构建单文件 EXE | `build.cmd -DmgPath .\Codex.dmg -SingleExe` |
| Node runner（run） | `node .\scripts\node\run.js run -DmgPath .\Codex.dmg` |
| Node runner（build） | `node .\scripts\node\run.js build -DmgPath .\Codex.dmg` |

## 🎛️ 常用参数

- `-WorkDir .\work`
- `-DistDir .\dist`
- `-Reuse`
- `-NoLaunch`
- `-CodexCliPath C:\path\to\codex.exe`
- `-SingleExe`
- `-DevProfile`
- `-ProfileName dev`
- `-PersistRipgrepPath`

## 📦 输出结构

便携版：

```text
dist\Codex-win32-x64\Codex.exe
dist\Codex-win32-x64\Launch-Codex.cmd   (推荐入口)
```

单文件：

```text
dist\Codex-win32-x64-single.exe
```

## 🧪 开发配置隔离

使用 `-DevProfile` 或 `-ProfileName <name>`：

- `work\userdata-<profile>`
- `work\cache-<profile>`
- `work\state.manifest.<profile>.json`
- `work\diagnostics\<profile>\cli-resolution.log`

## 🧯 故障排查

### 🔒 `rejected: blocked by policy`

这是 **Codex 工具环境策略限制**，不是 Windows PowerShell `ExecutionPolicy`。

建议：

- ✅ 优先使用项目流水线命令（`run.cmd`、`build.cmd`）
- ❌ 避免嵌套 one-liner（`pwsh -> cmd /c -> ...`）
- 🧹 受限环境手动清理可用：

```cmd
cmd /d /c "if exist ""C:\path\dir"" rd /s /q ""C:\path\dir"""
```

### 🧵 手工命令中的转义/路径问题

PowerShell 下不安全写法：

```cmd
cmd /c if not exist ... & if not exist ...
```

更安全写法：

```cmd
cmd /d /c "if not exist ""C:\A"" mkdir ""C:\A"" && if not exist ""C:\B"" mkdir ""C:\B"""
```

## ✅ 在 Codex 内验证 Windows 运行契约

```cmd
cmd /c where node
cmd /c where powershell
cmd /c node -v
cmd /c powershell -NoProfile -Command "$PSVersionTable.PSVersion.ToString()"
```

## ❓ 为什么同时存在 `.ts` 和 `.js`

- `scripts/ts/*` -> 源码
- `scripts/node/*` -> 编译产物（由 launcher/runtime 直接使用）

## ⚠️ 免责声明

- 本项目不是 OpenAI 官方项目。
- 请勿分发 OpenAI 二进制文件或 `Codex.dmg`。
