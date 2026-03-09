# Example Codex Forge Mod

This template shows the preferred Fabric-like shape for a runtime mod:

- richer manifest metadata
- array entrypoints per lane
- optional `provides` aliases
- clear separation between main and renderer behavior

Copy this folder outside `templates/` into `mods/<your-mod-id>/` and adjust:

- `mod.json`
- `main.cjs`
- `renderer.js`
