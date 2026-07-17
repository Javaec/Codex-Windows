# 🚀✨ Codex-Windows (RU)

> [!IMPORTANT]
> 🌍 **Переключение языков**: [🇺🇸 English](README.md) | [🇷🇺 Русский](README.ru.md) | [🇨🇳 简体中文](README.zh-CN.md)

> [!TIP]
> 🧭 Windows-first пайплайн перепаковки и запуска Codex с **Node.js-ядром оркестрации** и **тонким PowerShell entrypoint**.

---

## 🎯 Что Это За Проект

`Codex-Windows` перепаковывает и запускает Codex Desktop на Windows через детерминированный pipeline:

- 🧩 Извлечение `app.asar` из `Codex.dmg`
- 🛠️ Применение Windows runtime-патчей (PATH/env/process guards/резолв CLI)
- 🔽 Инжект стабильного автоскролла чата при переключении тредов
- 🧹 Санитизация workspace registry + git capability cache
- 🧪 Проверка native-модулей (`better-sqlite3`, `node-pty`)
- 📦 Сборка portable-выхода или single-file EXE

---

## 🧼 Политика Автоочистки (по mtime)

В начале пайплайна очищаются старые данные в `%USERPROFILE%\.codex` (или `%CODEX_HOME%`) по **дате последнего изменения**:

| Цель | Правило |
|---|---|
| `log/` | файлы старше **7 дней** |
| `sessions/` | файлы старше **10 дней** |
| `worktrees/` | корни старше **5 дней** (по максимальному mtime внутри дерева) |

> [!NOTE]
> ✅ Старые чаты/сессии сохраняются, если недавно изменялись.

---

## 🏗️ Архитектура Пайплайна

```text
run.cmd / build.cmd
  -> scripts/run.ps1
    -> Setup-Codex/node/run.js
      -> scripts/ts/run.ts
```

> [!IMPORTANT]
> `build.cmd` по умолчанию всегда запускается с `-NoLaunch` (только билд, без автозапуска приложения).

---

## 🧰 Требования

- 🪟 Windows 10/11
- 🟢 Node.js
- 🤖 Codex CLI: `npm i -g @openai/codex`
- 🗜️ 7-Zip (`7z`) для извлечения DMG и упаковки single EXE

> [!NOTE]
> - Для стандартного потока **не нужны** Python / Visual Studio Build Tools.
> - `scripts/ts/*` = исходники, `scripts/node/*` = runtime-артефакты после компиляции.

---

## ⚡ Быстрый Старт

1. Установите Codex CLI:

```powershell
npm i -g @openai/codex
```

### Временный workaround для лагов Windows Codex

Если Microsoft Store-сборка Codex вызывает системные зависания и события `0xc06d007f`, можно запустить текущую закреплённую сборку через:

```cmd
Launch-Codex-WorkLouder-Bypass.cmd
```

Launcher не изменяет Store-пакет или пользовательские данные. Он автоматически находит актуальный `OpenAI.Codex` через AppX, использует его текущий путь и версию, проверяет структуру `@worklouder/device-kit-oai`, затем временно подменяет только этот модуль, чтобы `findWLDevices()` возвращал пустой список. Work Louder / Codex Micro при этом не работает.

Перед запуском полностью закройте Codex/ChatGPT: launcher намеренно не подключается к уже работающему `ChatGPT.exe` и не завершает чужую сессию.

После обновления приложения launcher повторно проверит новый пакет автоматически. Если OpenAI изменит контракт Work Louder-модуля или его структуру, launcher намеренно завершится до запуска с сообщением о необходимости обновить адаптер.

2. Прямой запуск:

```cmd
run.cmd -DmgPath .\Codex.dmg
```

3. Portable-сборка (без автозапуска):

```cmd
build.cmd -DmgPath .\Codex.dmg
```

---

## 🖥️ Шпаргалка Команд

| Сценарий | Команда |
|---|---|
| ▶️ Прямой запуск | `run.cmd` |
| ⏸️ Прямой запуск без старта | `run.cmd -NoLaunch` |
| 📦 Portable-сборка (по умолчанию без запуска) | `build.cmd -DmgPath .\Codex.dmg` |
| 🧷 Portable + single EXE | `build.cmd -DmgPath .\Codex.dmg -SingleExe` |
| 🧠 Node runner (режим run) | `node .\scripts\node\run.js run -DmgPath .\Codex.dmg` |
| 🛠️ Node runner (режим build) | `node .\scripts\node\run.js build -DmgPath .\Codex.dmg -NoLaunch` |

---

## 🎛️ Полезные Опции

| Опция | Значение |
|---|---|
| `-WorkDir .\work` | свой рабочий каталог |
| `-DistDir .\dist` | свой каталог выхода |
| `-Reuse` | переиспользовать артефакты |
| `-NoLaunch` | не запускать приложение |
| `-CodexCliPath <path>` | явный путь к `codex.exe` |
| `-SingleExe` | собрать self-extracting EXE |
| `-DevProfile` | изолированный dev-профиль |
| `-ProfileName <name>` | именованный профиль |
| `-StrictContract` | строгая проверка контракта среды |

Переменные брендирования:

- 🎨 `CODEX_ICON_PATH` - кастомный `.ico`
- 🧱 `CODEX_RCEDIT_PATH` - кастомный `rcedit.exe`

---

## 📁 Выходные Артефакты

```text
dist\Codex-win32-x64\Codex.exe
dist\Codex-win32-x64\Launch-Codex.cmd
dist\Codex-win32-x64-single.exe   (если указан -SingleExe)
```

---

## ⚠️ Дисклеймер

- Это **не** официальный проект OpenAI.
- Не распространяйте бинарники OpenAI и `Codex.dmg`.
