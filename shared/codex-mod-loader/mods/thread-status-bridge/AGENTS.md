# AGENTS Notes

## Purpose

- Supply renderer mods with stable thread activity state from the main process instead of guessing from fragile DOM-only heuristics.

## Current Decisions

- This is a main-process mod.
- Declared main capabilities:
  - `app-start`
  - `window-created`
- It patches the `codex.exe` stdio process boundary to observe:
  - `turn/start`
  - `turn/started`
  - `turn/completed`
  - `turn/aborted`
  - `thread/resume`
  - `thread/read`
- It broadcasts a small state object into renderer windows via `executeJavaScript`.

## Why

- Current window URL does not carry the active thread id, so pure DOM heuristics are not enough for reliable current-thread highlighting.
- A tiny main-to-renderer state bridge is less invasive than patching upstream sidebar React internals.
