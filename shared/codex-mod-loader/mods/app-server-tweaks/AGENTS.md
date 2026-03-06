# AGENTS Notes

## Purpose

- Keep old chat history loading after Codex CLI upgrades without touching renderer bundles.

## Current Decisions

- This mod is main-process only.
- It now receives shared Mod API v1 context instead of a raw ad-hoc bootstrap object.
- It rewrites thread detail IPC payloads to force `persistExtendedHistory=true`.
- Tree walking now belongs to the API hook `onBeforeAppServerRequest`, not to this mod.
- It must not touch:
  - `thread/list`
  - any `*/list`
  - `thread/realtime/*`
- It does not touch sidebar thread caps anymore.

## Why

- Shared IPC wrapping should live in the loader API, not be cloned in every main mod.
- Request-tree traversal should also live in the API, so the mod only defines the actual business rewrite.
- `thread/list limit 10 -> 6` did not affect the visible grouped sidebar and only added dead logic.
- Forcing persistence on `thread/list` can dramatically slow initial load and keep the UI on the center spinner.
- History persistence is a stable transport-level concern, but only for thread-detail reads, not list endpoints.
