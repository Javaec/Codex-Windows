# AGENTS Notes

## Purpose

- Prune stale workspace/worktree roots from persisted global state before they keep triggering `git-origin-and-roots` ENOENT churn.

## Current Decisions

- This is a main-process startup mod.
- Declared main capability:
  - `app-start`
- Scope is intentionally narrow:
  - only `.codex-global-state.json`
  - only stale path-like entries
- It runs once per app boot and logs a compact summary.

## Why

- The current crash trace is renderer-heavy, but stale workspace roots were also creating continuous background churn.
- This keeps the fix outside the runtime shim and inside the mod platform, which is closer to a Forge/Fabric split.
- Narrow startup sanitation is safer than broad runtime mutation of user state.
