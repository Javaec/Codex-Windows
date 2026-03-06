# AGENTS Notes

## Purpose

- Keep grouped sidebar thread lists compact: 6 rows per project before manual expansion.

## Current Decisions

- This mod now depends on `shared/codex-mod-loader/api/renderer-api.js`.
- This is a renderer DOM mod.
- It now follows shared renderer lifecycle hooks (`onRendererReady`, `onRouteChange`) instead of ad-hoc one-off startup wiring.
- It targets visible sidebar lists with a native `Show more` / `Show less` row, not one exact `aria-label`.
- It first clicks the native `Show more` once so rows beyond the bundled 10-item cap exist in the DOM.
- After native expansion, it hides rows after 6 and renders its own compact `Show more` / `Show less` toggle.

## Why

- Shared observer/text/visibility helpers keep the cap logic focused on list behavior instead of loader plumbing.
- Changing `thread/list` request limits does not change the grouped sidebar cap.
- In the bundled UI, rows after 10 do not exist in the DOM until native expansion happens.
- Matching by visible sidebar structure is more stable than matching by one localized `aria-label`.
