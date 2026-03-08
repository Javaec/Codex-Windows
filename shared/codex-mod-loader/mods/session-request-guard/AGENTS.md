# AGENTS Notes

## Purpose

- Keep old chat history loading after Codex CLI upgrades without touching renderer bundles.

## Current Decisions

- This mod is main-process only.
- It now receives shared Mod API v1 context instead of a raw ad-hoc bootstrap object.
- Declared main capabilities:
  - `before-app-server-request`
- It rewrites thread detail IPC payloads to force `persistExtendedHistory=true`.
- Tree walking now belongs to the API hook `onBeforeAppServerRequest`, not to this mod.
- The mod now uses the typed hook `onBeforeCodexRequest`, so it receives `method` and `params` directly instead of generic tree nodes.
- It must not touch:
  - `thread/list`
  - any `*/list`
  - `thread/realtime/*`
- It does not touch sidebar thread caps anymore.
- It now also provides two conservative stability guards:
  - debounce repeated internal `getAuthStatus(refreshToken=true)` storms
  - clamp oversized `thread/list` requests to a safer upper bound

## Why

- Shared IPC wrapping should live in the loader API, not be cloned in every main mod.
- Request-tree traversal should also live in the API, so the mod only defines the actual business rewrite.
- `thread/list limit 10 -> 6` did not affect the visible grouped sidebar and only added dead logic.
- Forcing persistence on `thread/list` can dramatically slow initial load and keep the UI on the center spinner.
- History persistence is a stable transport-level concern, but only for thread-detail reads, not list endpoints.
- Hot auth refresh should stay live, but repeated token refresh requests in a very tight burst are wasteful and can amplify recovery churn.
