# AGENTS Notes

## Purpose

- Keep old chat history loading after Codex CLI upgrades without touching renderer bundles.

## Current Decisions

- This mod is main-process only.
- It rewrites `thread/*` IPC payloads to force `persistExtendedHistory=true`.
- It does not touch sidebar thread caps anymore.

## Why

- `thread/list limit 10 -> 6` did not affect the visible grouped sidebar and only added dead logic.
- History persistence is a stable transport-level concern and belongs in the main-process mod.
