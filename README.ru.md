# 🚀 Codex-Windows (RU)

> [!IMPORTANT]
> 🌐 **Переключение языков**: [🇺🇸 English](README.md) | [🇷🇺 Русский](README.ru.md) | [🇨🇳 简体中文](README.zh-CN.md)

> [!TIP]
> 🧭 Windows-first пайплайн перепаковки Codex с **Node.js-ядром оркестрации** и **тонким PowerShell-адаптером**.

## ✨ Что Вы Получаете

- 🧩 Извлечение `app.asar` из `Codex.dmg`
- 🛠️ Применение Windows runtime-патчей (`PATH`, shell-инструменты, резолв CLI)
- 🧼 Авто-санитайзер workspace registry с auto-prune битых путей перед запуском
- 🗃️ Git capability cache для missing refs/invalid CWD (меньше повторных `rev-parse` циклов)
- 🛡️ Idempotent runtime guards + IPC shutdown supervisor для более чистого завершения
- 🎨 Брендинг `Codex.exe` (иконка + ProductName/FileDescription), чтобы ярлыки не были `Electron`
  также применяется для direct-runtime (`work/native-builds/.../Codex.exe`)
- ✅ Валидация native-модулей (`better-sqlite3`, `node-pty`) из donor/seed артефактов
- ⚡ Запуск Codex напрямую из `work/` (direct mode)
- 📦 Сборка portable-версии в `dist/`
- 🧷 Опциональная сборка single EXE через 7-Zip SFX

## 🏗️ Архитектура (Коротко)

```text
run.cmd / build.cmd
  -> scripts/run.ps1          (тонкий входной адаптер)
    -> scripts/node/run.js    (скомпилированный раннер)
      -> scripts/ts/run.ts    (исходный оркестратор)
        -> extract -> patch -> native validate -> package -> launch
```

- 📁 Файловые операции (copy/move/delete) выполняются через Node `fs` с ретраями
- 🚫 Минимум хрупких shell one-liner в pipeline
- 📂 Распаковка `app.asar` делается нативным Node extractor (без `npm exec asar`)
- 🧱 Разделение на Core pipeline + adapters (`scripts/ts/lib/adapters/*`) для переносимости в другие обвязки/игры

## 🧰 Требования

- 🪟 Windows 10/11
- 🟢 Node.js
- 🧠 Codex CLI: `npm i -g @openai/codex`
- 🗜️ 7-Zip (`7z`) доступен в системе (PATH или через `winget`)
- 🔎 `rg` (ripgrep) резолвится автоматически (PATH -> winget -> portable fallback)

> [!NOTE]
> - Для стандартного потока **не нужны** Python / Visual Studio Build Tools.
> - Native rebuild через `node-gyp` по умолчанию отключен политикой этого репозитория.

## 📥 Подготовка DMG

- Монитор версий: [codex-version-monitor.vercel.app](https://codex-version-monitor.vercel.app/)
- Положите DMG сюда:

```text
C:\Codex-Windows\Codex.dmg
```

## ⚡ Быстрый Старт

1. Установите Codex CLI:

```powershell
npm i -g @openai/codex
```

2. Запустите direct mode:

```cmd
run.cmd
```

3. Соберите portable-версию:

```cmd
build.cmd -DmgPath .\Codex.dmg
```

## 🖥️ Шпаргалка Команд

| Сценарий | Команда |
|---|---|
| Прямой запуск | `run.cmd` |
| Прямой запуск с DMG | `run.cmd -DmgPath .\Codex.dmg` |
| Сборка portable | `build.cmd -DmgPath .\Codex.dmg` |
| Сборка single EXE | `build.cmd -DmgPath .\Codex.dmg -SingleExe` |
| Node runner (run) | `node .\scripts\node\run.js run -DmgPath .\Codex.dmg` |
| Node runner (build) | `node .\scripts\node\run.js build -DmgPath .\Codex.dmg` |

## 🎛️ Полезные Опции

- `-WorkDir .\work`
- `-DistDir .\dist`
- `-Reuse`
- `-NoLaunch`
- `-CodexCliPath C:\path\to\codex.exe`
- `-SingleExe`
- `-DevProfile`
- `-ProfileName dev`
- `-PersistRipgrepPath`

Переменные для брендирования:
- `CODEX_ICON_PATH` — путь к `.ico` (перекрывает встроенный `icons/codex.ico`)
- `CODEX_RCEDIT_PATH` — путь к `rcedit.exe` (если нужен кастомный бинарь)

## 📦 Структура Выхода

Portable:

```text
dist\Codex-win32-x64\Codex.exe
dist\Codex-win32-x64\Launch-Codex.cmd   (рекомендуемая точка входа)
```

Single-file:

```text
dist\Codex-win32-x64-single.exe
```

## 🧪 Изоляция Профилей

Используйте `-DevProfile` или `-ProfileName <name>`:

- `work\userdata-<profile>`
- `work\cache-<profile>`
- `work\state.manifest.<profile>.json`
- `work\diagnostics\<profile>\cli-resolution.log`

## 🧯 Troubleshooting

### 🔒 `rejected: blocked by policy`

Это **ограничение среды Codex tool**, а не Windows PowerShell `ExecutionPolicy`.

Рекомендации:

- ✅ Использовать команды pipeline проекта (`run.cmd`, `build.cmd`)
- ❌ Избегать вложенных one-liner (`pwsh -> cmd /c -> ...`)
- 🧹 Для аварийной очистки в ограниченной среде:

```cmd
cmd /d /c "if exist ""C:\path\dir"" rd /s /q ""C:\path\dir"""
```

### 🧵 Ошибки экранирования/путей в ручных командах

Небезопасный паттерн в PowerShell:

```cmd
cmd /c if not exist ... & if not exist ...
```

Безопасный паттерн:

```cmd
cmd /d /c "if not exist ""C:\A"" mkdir ""C:\A"" && if not exist ""C:\B"" mkdir ""C:\B"""
```

## ✅ Проверка Windows Контракта Внутри Codex

```cmd
cmd /c where node
cmd /c where powershell
cmd /c node -v
cmd /c powershell -NoProfile -Command "$PSVersionTable.PSVersion.ToString()"
```

## ❓ Почему Есть И `.ts`, И `.js`

- `scripts/ts/*` -> исходники
- `scripts/node/*` -> скомпилированные артефакты, используемые лаунчером/runtime

## ⚠️ Дисклеймер

- Это не официальный проект OpenAI.
- Не распространяйте бинарники OpenAI и `Codex.dmg`.
