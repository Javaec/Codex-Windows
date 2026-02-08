# 🚀 Codex-Windows (RU)

> [!IMPORTANT]
> ## 🌐 Переключение языков
> **✨ [🇺🇸 English](README.md) | [🇷🇺 Русский](README.ru.md) | [🇨🇳 简体中文](README.zh-CN.md) ✨**

> [!TIP]
> ## 🪟💯 100% Windows Runtime Support
> - ✅ `Node.js` стабильно работает внутри Codex
> - ✅ `PowerShell` / `pwsh` стабильно работают внутри Codex
> - ✅ `PATH` нормализован для Windows-инструментов (`cmd`, `where`, `npm`, `git`)
> - ✅ Нативные Windows-команды выполняются корректно и предсказуемо

Windows-first перепаковка Codex на базе `reference/Codex-Windows-main-1`.

## ✨ Что делает проект

- Извлекает `app.asar` из `Codex.dmg`
- Пересобирает native-модули под Windows (`better-sqlite3`, `node-pty`)
- Запускает Codex из `work/` (direct mode)
- Собирает portable-пакет в `dist/`
- Использует Node.js-ядро оркестрации с PowerShell-адаптерами совместимости

## 🧰 Требования

- Windows 10/11
- Node.js
- Codex CLI: `npm i -g @openai/codex`
- 7-Zip (`7z` в PATH)  
  Если отсутствует, скрипт пробует `winget` или portable 7z.

## 📦 Подготовка

### 📥 Где взять последнюю версию DMG

- Монитор версий: [codex-version-monitor.vercel.app](https://codex-version-monitor.vercel.app/)
- Возьмите оттуда актуальный `Codex.dmg` и поместите в:
  - `C:\Codex-Windows\Codex.dmg`

1. Положите `Codex.dmg` в корень репозитория:
   - `C:\Codex-Windows\Codex.dmg`
2. Установите Codex CLI:

```powershell
npm i -g @openai/codex
```

## ▶️ Запуск (direct mode)

```cmd
run.cmd
```

Если `Codex.dmg` лежит в другом месте:

```cmd
run.cmd -DmgPath .\Codex.dmg
```

Также можно запускать двойным кликом по `run.cmd`.

Опции:

- `-WorkDir .\work`
- `-CodexCliPath C:\path\to\codex.exe`
- `-Reuse`
- `-NoLaunch`

## 🧳 Portable-сборка

```cmd
build.cmd -DmgPath .\Codex.dmg
```

Результат:

- `dist\Codex-win32-x64\Codex.exe`
- `dist\Codex-win32-x64\Launch-Codex.cmd` (рекомендуемый вход)

Опции:

- `-WorkDir .\work`
- `-DistDir .\dist`
- `-Reuse`
- `-NoLaunch`
- `-CodexCliPath C:\path\to\codex.exe`
- `-SingleExe` (собрать один self-extracting `*.exe` через 7-Zip SFX)

### Single EXE (SFX)

```cmd
build.cmd -DmgPath .\Codex.dmg -SingleExe
```

Результат:

- `dist\Codex-win32-x64-single.exe`

## 🛠️ Примеры PowerShell

```powershell
.\scripts\run.ps1 -DmgPath .\Codex.dmg
.\scripts\run.ps1 -DmgPath .\Codex.dmg -BuildPortable
.\scripts\run.ps1 -DmgPath .\Codex.dmg -Reuse -NoLaunch
```

## 🧠 Вход через Node-ядро

```cmd
node .\scripts\node\run.js run -DmgPath .\Codex.dmg -Reuse -NoLaunch
node .\scripts\node\run.js build -DmgPath .\Codex.dmg -Reuse -NoLaunch
```

Исходник TypeScript:
- `scripts\ts\run.ts`
- команда сборки: `npm run build:runner`

## 🔍 Проверка совместимости Windows внутри Codex

```cmd
cmd /c where node
cmd /c where powershell
cmd /c powershell -NoProfile -Command "$PSVersionTable.PSVersion.ToString()"
cmd /c node -v
```

## 🌍 Другие языки

- English (default): `README.md`
- Chinese: `README.zh-CN.md`

## ⚠️ Дисклеймер

- Это не официальный проект OpenAI.
- Не распространяйте бинарники OpenAI и `Codex.dmg`.
