# Reverse/Deobfuscation Progress Notes

## Snapshot
- Date (UTC): 2026-02-22
- Latest validated run: `work/reverse-codex-app-bigstroke-7`
- Latest regression suite: `work/reverse-regression-bigstroke-7`
- Pipeline entrypoint: `scripts/ts/reverse.ts`

## Implemented Capabilities
- Unified reference source-of-truth in `scripts/ts/reverse/reference-model.ts`:
  - reads:
    - `reference/analysis/1code-codexmonitor-architecture-map.md`
    - `reference/analysis/1code-symbol-map.json`
    - `reference/analysis/CodexMonitor-symbol-map.json`
  - emits unified model in `report/reference-model.json`
  - includes:
    - `unified.files` (symbol-map + path-map merged)
    - `unified.pathMap`
    - `unified.domainDefinitions` (labels + weights + keywords)
- `match-v2` stage in `scripts/ts/reverse/match-v2.ts`:
  - multi-signal file/symbol scoring:
    - AST
    - IPC/RPC
    - state keys
    - component boundaries
    - route/event flow
    - layer/path-map alignment
  - regression-calibrated profile sourced from `scripts/ts/reverse/regression-config.ts`
  - controlled non-generic fallback and regression-fill to keep mappedFiles inside gate target
- `domain-report` + `component-boundaries` extracted from god object:
  - `scripts/ts/reverse/domain-boundaries.ts`
- IPC stage extracted:
  - `scripts/ts/reverse/ipc-contract-map.ts`
- RPC schema stage extracted:
  - `scripts/ts/reverse/rpc-schema.ts`
- Session/graph stage extracted:
  - `scripts/ts/reverse/session-route-flow.ts`
- Reference parity stage extracted:
  - `scripts/ts/reverse/reference-parity.ts`
- Deobfuscation formatting extracted:
  - `scripts/ts/reverse/deobfuscation-report.ts`
- Project generator extracted:
  - `scripts/ts/reverse/webstorm-project.ts`

## Hard Quality Gates
- Gate stage: `scripts/ts/reverse/quality-gates.ts`
- Output: `report/quality-gates.json`
- Enforced conditions per run:
  - `mappedFiles` in `[4..6]`
  - `mappedSymbols` must not regress against history (`work/reverse-quality-history.json`)
  - no generic-path noise in reconstructed targets (`types/utils/index/common/shared`)
  - generated project checks must be clean:
    - `npm install`
    - `tsc --noEmit`
    - `eslint` errors=0 and warnings=0
  - strict artifact consistency:
    - one chunk source -> one chunk artifact
    - wrapper-only reconstructed modules
    - only TS-first target layers:
      - `src/main/*`
      - `src/renderer/*`
      - `src/services/*`
      - `src-tauri-adapter/*`

## Fixed Regression Runs
- Config: `scripts/ts/reverse/regression-config.ts`
- Runner: `scripts/ts/reverse-regression.ts`
- NPM command:
  - `npm run reverse:regression -- -AppDir C:\Codex-Windows\work\app -OutRoot C:\Codex-Windows\work\reverse-regression`
- Current fixed suite:
  - `core-no-binary`
  - `core-no-binary-no-pretty`
  - `core-no-binary-top120`

## Generated Project (IDE-Oriented)
- Target folder: `project`
- Reconstruction policy:
  - one source chunk -> one artifact in `project/src/chunks/*`
  - reconstructed modules are TS wrappers with point symbol exports
  - no full-chunk duplication into each reconstructed module
- Layer layout:
  - `project/src/main/*`
  - `project/src/renderer/*`
  - `project/src/services/*`
  - `project/src-tauri-adapter/*`

## Latest Metrics (`bigstroke-7`)
- Indexed files: 443
- JS files: 440
- Routes: 21
- Methods: 6
- IPC channels: 9
- Component boundaries: 27
- Deobfuscation:
  - mapped files: 4
  - mapped symbols: 9
  - entries: 13
  - reconstructed targets: 7
- Reference model:
  - unified files: 100
  - path-map entries: 31
- Quality gates:
  - pass: true
  - generic-path noise: 0
  - install/tsc/eslint: clean
- Pipeline size:
  - `scripts/ts/reverse.ts`: 3636 LOC (down from 4196 before this extraction pass)

## Latest Regression Suite (`reverse-regression-bigstroke-7`)
- `core-no-binary`: pass, mappedFiles=4, mappedSymbols=9
- `core-no-binary-no-pretty`: pass, mappedFiles=4, mappedSymbols=9
- `core-no-binary-top120`: pass, mappedFiles=4, mappedSymbols=9

## Known Gaps / Noise
- Runtime probe still collects environment-specific noise in some runs.
- Reference parity is still partial, especially in chat/session coverage depth.
- Symbol recovery is stable but still conservative; next gain should come from stronger callsite ownership signals.

## Next Improvements (Generator-First)
- Continue slicing `reverse.ts` toward orchestration-only (next candidate: helper-heavy IPC decode internals).
- Expand fixed regression suite with runtime-probe variant and app-version-pinned baseline snapshots.
- Improve symbol-level precision for renderer chunks without widening generic-path acceptance.
