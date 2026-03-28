# AGENTS Notes

## Purpose

- Keep launcher-side sanitizers short and deterministic.

## Current Decisions

- Workspace sanitization is no longer limited to portable `userdata`.
- Always scan the real Codex state roots too:
  - `%APPDATA%\\Codex`
  - `%USERPROFILE%\\.codex` (or `CODEX_HOME`)
- Include `.codex-global-state.json` explicitly in the candidate set.

## Why

- Runtime workspace/git warnings were coming from persisted global state outside portable `userdata`.
- The launcher should remove stale path references before the app starts, instead of relying on manual cleanup.
