# Runtime Shim AGENTS

## Purpose
Single source of truth for the injected Electron main shim used by repack and direct-launch flows.

## 2026-03-06: Renderer mod wrapper contract

- Renderer mods are injected through `webContents.executeJavaScript(...)`.
- The wrapper must use real line breaks around the mod body:
  - good:
    - ``const wrapped = `/* CODEX-MOD:${mod.id} */``
    - next line: `${mod.script}`
    - next line: `` `; ``
- Do not encode those line breaks as literal `\\n`.
- Literal `\\n` in the wrapper makes every renderer mod fail to parse at runtime and produces a black screen.
