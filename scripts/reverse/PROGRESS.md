# Reverse/Deobfuscation Progress Notes

## Snapshot
- Date (UTC): 2026-02-22
- Latest validated run: `work/reverse-codex-app-bigstroke-6`
- Pipeline entrypoint: `scripts/ts/reverse.ts`

## Implemented Capabilities
- Reference-guided deobfuscation from:
  - `reference/analysis/1code-codexmonitor-architecture-map.md`
  - `reference/analysis/1code-symbol-map.json`
  - `reference/analysis/CodexMonitor-symbol-map.json`
- Reference model as single source-of-truth:
  - `report/reference-model.json`
  - generated from architecture map + both symbol maps in `scripts/ts/reverse/reference-model.ts`
  - now also extracts `unified.pathMap` from architecture-map file paths and merges it into unified file profiles
- Match-v2 deobfuscation stage:
  - implemented in `scripts/ts/reverse/match-v2.ts`
  - file-level + symbol-level scoring by multiple signals (AST, IPC/RPC, state keys, component boundaries, route/event flow)
  - domain-aware scoring from unified reference keywords + path-map tokens, source-anchor weighting, and anti-generic target penalties
  - regression-hint boosts + controlled non-generic fallback tiers
  - signal-aware target-path renaming when reference basename is generic
- Deobfuscation report layer extracted from god object:
  - `scripts/ts/reverse/deobfuscation-report.ts`
  - owns markdown/csv/rename-plan formatting and target-path normalization
- WebStorm project generation extracted from god object:
  - `scripts/ts/reverse/webstorm-project.ts`
  - owns project scaffold + install/typecheck/eslint checks
- Session-flow / route-boundary generation extracted from god object:
  - `scripts/ts/reverse/session-route-flow.ts`
  - owns `buildSessionFlowReport`, `formatSessionFlowMarkdown`, `buildRouteBoundaryGraphReport`
- Reference parity gap stage extracted from god object:
  - `scripts/ts/reverse/reference-parity.ts`
  - owns `buildReferenceParityGapsReport`
- IPC contract map stage extracted from god object:
  - `scripts/ts/reverse/ipc-contract-map.ts`
  - `reverse.ts` now calls stage via explicit helper contract
- RPC schema stage extracted from god object:
  - `scripts/ts/reverse/rpc-schema.ts`
  - owns runtime/static RPC method merge, payload key extraction, envelope inference
  - wired through explicit helper contracts from `reverse.ts` (no hidden cross-module state)
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
  - `project/src/chunks/*` one source artifact per chunk (single copy)
  - `project/src/main/*`, `project/src/renderer/*`, `project/src/services/*` TS-first reconstructed modules
  - `project/src-tauri-adapter/*` tauri/daemon bridge modules
  - `project/mapping/*` source-of-truth mapping/flow reports
  - `project/meta/checks.json` automated check results
  - `project/mapping/chunk-artifacts.json` chunk source-of-truth map

## Reconstruction Strategy
- One source chunk -> one artifact in `src/chunks/*`.
- Reconstructed target modules are generated as TS wrappers with point symbol exports from chunk artifacts (not full chunk copy per target file).
- Target path mapping is TS-first and reference-guided:
  - `src/main/...`
  - `src/renderer/...`
  - `src/services/...`
  - `src-tauri-adapter/...`

## Automated Quality Checks (inside generated `project`)
- `npm install`
- `tsc --noEmit`
- `eslint src/**/*.{js,mjs,cjs,ts,tsx} src-tauri-adapter/**/*.{js,mjs,cjs,ts,tsx} --format json`
- Last validated result (`bigstroke-6`): install=ok, tsc=0 errors, eslint=0 errors/0 warnings.

## Latest Metrics (`bigstroke-6`)
- Indexed files: 443
- JS files: 440
- Routes: 21
- Methods: 6
- IPC channels: 9
- Component boundaries: 27
- Deobfuscation:
  - mapped files: 6
  - mapped symbols: 9
  - entries: 15
  - reconstructed targets: 6
- Reference model:
  - unified files: 100
  - path-map entries: 31
- Pipeline size:
  - `scripts/ts/reverse.ts`: 4196 LOC (down from 5072 before rpc-schema extraction)

## Known Gaps / Noise
- Runtime probe still captures environment-specific noise (`ENOENT` worktrees, git remote checks, broadcast handlers without subscribers).
- Weighted reference parity is still partial (`~40.58%` weighted coverage in last run), with largest gaps in chat/session domain.
- File-level mapping now reaches 6, but two plans can still converge to the same reference path family; next pass should improve source->target separation.

## Next Improvements (Generator-First)
- Keep fixing generator output and mapping heuristics instead of editing generated code manually.
- Increase stable symbol recovery in renderer bundles (especially IPC wrapper decode and callsite ownership).
- Continue reducing false positives in runtime probe classification and deobfuscation candidate selection.
