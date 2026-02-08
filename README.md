# 🚀 Codex-Windows: DMG -> Full Windows Runtime

Лёгкая перепаковка Codex из macOS `Codex.dmg` в рабочий Windows-раннер/portable-сборку.

База решения: `reference/Codex-Windows-main-1`, плюс исправления Windows-окружения (`PATH`, `cmd`, `powershell/pwsh`, `node`) без тяжёлых и хрупких runtime-хаков.

## ✨ Что умеет

- ✅ Извлекает `app.asar` из `Codex.dmg`
- ✅ Подкладывает Windows-native модули (`better-sqlite3`, `node-pty`)
- ✅ Запускает Codex напрямую из `work/`
- ✅ Собирает portable-папку `dist/Codex-win32-x64` (или `arm64`)
- ✅ Нормализует окружение Windows перед запуском

## 🧰 Требования

- Windows 10/11
- Node.js
- Codex CLI (`npm i -g @openai/codex`)
- 7-Zip (`7z`)  
  Если не найден, скрипт пытается поставить через `winget` или скачать portable `7z`.

## 📦 Подготовка

1. Положите `Codex.dmg` в корень репозитория:
   - `C:\Codex-Windows\Codex.dmg`
2. Установите CLI:

```powershell
npm i -g @openai/codex
```

## ▶️ Запуск (direct mode)

```cmd
run.cmd -DmgPath .\Codex.dmg
```

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
- `dist\Codex-win32-x64\Launch-Codex.cmd` (рекомендуемый старт)

Опции:

- `-WorkDir .\work`
- `-DistDir .\dist`
- `-Reuse`
- `-NoLaunch`
- `-CodexCliPath C:\path\to\codex.exe`

## 🛠️ PowerShell-варианты

```powershell
.\scripts\run.ps1 -DmgPath .\Codex.dmg
.\scripts\run.ps1 -DmgPath .\Codex.dmg -BuildPortable
.\scripts\run.ps1 -DmgPath .\Codex.dmg -Reuse -NoLaunch
```

## 🔍 Быстрая проверка среды внутри Codex

```cmd
cmd /c where powershell
cmd /c where node
cmd /c powershell -NoProfile -Command "$PSVersionTable.PSVersion.ToString()"
cmd /c node -v
```

## 🧠 Что взято из `main-1` и что улучшено

- Сохранён простой и надёжный пайплайн `main-1`
- Убраны хрупкие патчи minified `main-*.js`
- Убраны глобальные monkey-patch перехваты `child_process`
- Сохранён только минимальный shim в `main.js` для переменных окружения/флагов
- Упорядочены `run.cmd`/`build.cmd` (явная передача аргументов)
- Документация и сценарии запуска приведены к более операционному формату

## ⚠️ Важно

- Это не официальный проект OpenAI.
- Не распространяйте бинарники OpenAI и `Codex.dmg`.
