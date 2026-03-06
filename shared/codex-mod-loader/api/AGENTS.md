# AGENTS Notes (Codex Mod API)

## 2026-03-06: Mod API v1

- `api/renderer-api.js` is the shared renderer contract for DOM-only mods.
- Goal:
  - stop duplicating sidebar lookup, observer/throttle, style injection, and bridge fetch wiring in every mod
  - move toward a Forge/Fabric-like split: loader/bootstrap separate from feature mods
- Renderer API intentionally stays small:
  - `normalizeText`
  - `isVisible`
  - `createDebouncedRunner`
  - `observeDom`
  - `scheduleBurst`
  - `ensureStyle`
  - `ensureSingletonNode`
  - `resolveHostId`
  - `bridgeFetchJson`
  - `findSidebarRoot`
  - `findSidebarAnchor`
  - `mountSidebarPanel`
  - `onRendererReady`
  - `onRouteChange`

- `api/main-api.cjs` is the shared main-process contract.
- Current v1 helper surface is intentionally small:
  - `isPlainObject`
  - `wrapIpcListeners`
  - `walkJsonTree`
  - `onBeforeAppServerRequest`
- Rule:
  - add helpers only when at least two mods need them or when the helper clearly removes bootstrap duplication.
