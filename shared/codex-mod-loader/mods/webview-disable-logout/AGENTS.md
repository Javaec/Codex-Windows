# AGENTS Notes

## Purpose

- Keep the logout action visually disabled without touching bundled renderer code.

## Current Decisions

- This mod now depends on `shared/codex-mod-loader/api/renderer-api.js`.
- It is intentionally DOM-only.
- It scans clickable nodes and disables only exact `Log out` / `Logout` labels.

## Why

- Shared text normalization and DOM observation helpers remove duplicate boilerplate from simple renderer mods.
- This behavior is a UI preference, so it belongs in a feature mod, not in patch-pack or the runtime shim.
