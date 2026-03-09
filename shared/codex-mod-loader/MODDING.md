# Codex Forge Modding

`Codex Forge` is moving toward a Fabric-like split:

- manifest metadata belongs to the mod
- discovery/catalog belongs to the loader
- compatibility resolution belongs to the shared resolver
- launcher state belongs to `Codex Forge`

## Manifest

Each runtime mod lives under `mods/<modId>/` and must include `mod.json`.

Supported fields:

```json
{
  "schemaVersion": 1,
  "id": "example-sidebar-tool",
  "name": "Example sidebar tool",
  "version": "0.1.0",
  "description": "Example Codex Forge runtime mod.",
  "authors": ["Codex Forge"],
  "contact": {
    "sources": "https://example.invalid/codex-forge"
  },
  "license": "UNLICENSED",
  "environment": "*",
  "provides": ["sidebar-tooling"],
  "enabled": true,
  "priority": 300,
  "compatibility": {
    "minBuild": 0,
    "maxBuild": 0
  },
  "requiresCapabilities": {
    "main": ["app-start"],
    "renderer": ["renderer-ready", "dom-observer"]
  },
  "entrypoints": {
    "main": ["main.cjs"],
    "renderer": ["renderer.js"]
  },
  "conflicts": [],
  "dependencies": ["sidebar-tooling"],
  "softIncompatibilities": [],
  "loadAfter": [],
  "loadBefore": []
}
```

## Entrypoints

- `entrypoints.main`:
  - one or more CommonJS files
  - each file must export a function or `{ activate() }`
- `entrypoints.renderer`:
  - one or more injected renderer scripts
  - files run in manifest order

String entrypoints still work, but arrays are the preferred contract.

## Aliases

`provides` works like a lightweight Fabric-style alias mechanism.

If a mod declares:

```json
{
  "id": "auth-session-runtime",
  "provides": ["auth-runtime"]
}
```

then other mods may depend on either:

- `auth-session-runtime`
- `auth-runtime`

The shared compatibility resolver canonicalizes aliases before dependency, conflict, and load-order checks.

## Example

See:

- `templates/example-mod/mod.json`
- `templates/example-mod/main.cjs`
- `templates/example-mod/renderer.js`

## Rules

- Keep renderer mods DOM-only.
- Do not mutate `window.electronBridge`.
- Prefer shared Mod API helpers instead of cloning loader logic into each mod.
- Keep launcher-owned enable/disable state out of source manifests.
