# Reverse/Deobfuscation Progress Notes

## Snapshot
- Date (UTC): 2026-02-21
- Latest validated run: `work/reverse-codex-app-boost31`
- Pipeline entrypoint: `scripts/ts/reverse.ts`

## Implemented Capabilities
- Reference-guided deobfuscation from:
  - `reference/analysis/1code-codexmonitor-architecture-map.md`
  - `reference/analysis/1code-symbol-map.json`
  - `reference/analysis/CodexMonitor-symbol-map.json`
- Generated deobfuscation artifacts:
  - `report/deobfuscation-table.json`
  - `report/deobfuscation-table.md`
  - `report/deobfuscation-table.csv`
  - `report/rename-plan.md`
- Route/session architecture artifacts:
  - `report/component-boundaries.json`
  - `report/session-flow.json`
  - `report/session-flow.md`
  - `report/route-boundary-graph.json`
  - `report/reference-parity-gaps.json`
- Runtime probe with warning/error classification:
  - `report/runtime-probe.json`

## Generated Project (IDE-Oriented)
- Output folder is now always `project` (not `webstorm-test-project`).
- The folder is re-created on each run.
- Main structure:
  - `project/src/chunks/*` core selected decompiled chunks
  - `project/src/reconstructed/*` mapped files by deobfuscation target path
  - `project/mapping/*` source-of-truth mapping/flow reports
  - `project/meta/checks.json` automated check results

## Path Compaction
- Reconstructed paths are compacted to reduce nesting depth.
- Examples:
  - `src/main/lib/git/security/path-validation.ts` -> `src/reconstructed/main/git/security/path-validation.js`
  - `src/renderer/features/agents/main/active-chat.tsx` -> `src/reconstructed/renderer/agents/active-chat.js`

## Automated Quality Checks (inside generated `project`)
- `npm install`
- `tsc --noEmit`
- `eslint src/**/*.{js,mjs,cjs,ts,tsx} --format json`
- Last validated result (`boost31`): install=ok, tsc=0 errors, eslint=0 errors/0 warnings.

## Latest Metrics (`boost31`)
- Indexed files: 443
- JS files: 440
- Routes: 21
- Methods: 6
- IPC channels: 9
- Component boundaries: 27
- Deobfuscation:
  - mapped files: 2
  - mapped symbols: 8
  - entries: 10
  - reconstructed targets: 5

## Known Gaps / Noise
- Runtime probe still captures environment-specific noise (`ENOENT` worktrees, git remote checks, broadcast handlers without subscribers).
- Weighted reference parity is still partial (`~40.98%` weighted coverage in last run), with largest gaps in chat/session domain.

## Next Improvements (Generator-First)
- Keep fixing generator output and mapping heuristics instead of editing generated code manually.
- Increase stable symbol recovery in renderer bundles (especially IPC wrapper decode and callsite ownership).
- Continue reducing false positives in runtime probe classification and deobfuscation candidate selection.
