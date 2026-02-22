# Reverse/Deobfuscation Progress Notes

## Snapshot
- Date (UTC): 2026-02-22
- Latest validated run: `work/reverse/regression-latest/core-no-binary`
- Latest regression suite: `work/reverse/regression-latest`
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
  - ownership-aware symbol scoring:
    - boundary ownership signal
    - UI likelihood signal
  - controlled non-generic symbol recovery pass
  - regression-calibrated profile sourced from `scripts/ts/reverse/regression-config.ts`
- `domain-report` + `component-boundaries` extracted from god object:
  - `scripts/ts/reverse/domain-boundaries.ts`
- Domain/session/parity orchestration extracted from god object:
  - `scripts/ts/reverse/domain-flow-parity.ts`
  - domain definitions are now consumed directly from `reference-model.unified.domainDefinitions`
  - no local parity keyword/weight adapters in `reverse.ts`
- IPC stage extracted:
  - `scripts/ts/reverse/ipc-contract-map.ts`
- IPC wrapper decode internals extracted:
  - `scripts/ts/reverse/ipc-wrapper-decode.ts`
- Runtime probe orchestration extracted from god object:
  - `scripts/ts/reverse/runtime-probe.ts`
  - `reverse.ts` now uses module-level runtime probe API + classification helper
- RPC schema stage extracted:
  - `scripts/ts/reverse/rpc-schema.ts`
- Session/graph stage extracted:
  - `scripts/ts/reverse/session-route-flow.ts`
- Reference parity stage extracted:
  - `scripts/ts/reverse/reference-parity.ts`
  - now accepts `domainDefinitions` directly (label + keywords + parityWeight) from `reference-model`
- Deobfuscation formatting extracted:
  - `scripts/ts/reverse/deobfuscation-report.ts`
- Report writing extracted:
  - `scripts/ts/reverse/report-writer.ts`
  - all final report json/markdown/csv/txt writes are delegated from `reverse.ts`
- Architecture markdown builder extracted:
  - `scripts/ts/reverse/architecture-report.ts`
- Summary composition extracted:
  - `scripts/ts/reverse/summary-composer.ts`
- Project generator extracted:
  - `scripts/ts/reverse/webstorm-project.ts`
- Stable output discipline added:
  - `scripts/ts/reverse/output-discipline.ts`
  - reverse runs sync to `work/reverse/latest`
  - regression suites sync to `work/reverse/regression-latest`
  - archived runs are rotated via keep-last-N cleanup

## Hard Quality Gates
- Gate stage: `scripts/ts/reverse/quality-gates.ts`
- Output: `report/quality-gates.json`
- Enforced conditions per run:
  - `mappedFiles` in `[4..6]`
  - `mappedSymbols` floor `>= 12`
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
  - `npm run reverse:regression -- -AppDir C:\Codex-Windows\work\app`
- Current fixed suite:
  - `core-no-binary`
  - `core-no-binary-no-pretty`
  - `core-no-binary-top120`
  - `core-runtime-probe-soft`
- Match-v2 regression calibration variants:
  - `baseline`
  - `ownership_boost`
  - `file_recall_boost`
- Calibration targets (fixed-suite scoring):
  - mappedFiles: `5..6`
  - mappedSymbols: `12..16`
- Snapshot-version baseline store:
  - file: `scripts/reverse/regression-baselines.json`
  - profile key: `name@version` (example: `openai-codex-electron@26.217.1959`)

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

## Latest Metrics (`work/reverse/regression-latest/core-no-binary`)
- Indexed files: 443
- JS files: 440
- Routes: 21
- Methods: 6
- IPC channels: 9
- Component boundaries: 27
- Deobfuscation:
  - mapped files: 6
  - mapped symbols: 16
  - entries: 22
  - reconstructed targets: 12
- Reference model:
  - unified files: 99
  - path-map entries: 30
- Quality gates:
  - pass: true
  - generic-path noise: 0
  - install/tsc/eslint: clean
- Pipeline size:
  - `scripts/ts/reverse.ts`: 2206 LOC
  - `scripts/ts/reverse/architecture-report.ts`: 269 LOC
  - `scripts/ts/reverse/summary-composer.ts`: 230 LOC
  - `scripts/ts/reverse/ipc-wrapper-decode.ts`: 1184 LOC
  - `scripts/ts/reverse/domain-flow-parity.ts`: 201 LOC
  - `scripts/ts/reverse/runtime-probe.ts`: 291 LOC
  - `scripts/ts/reverse/report-writer.ts`: 97 LOC

## Latest Regression Suite (`work/reverse/regression-latest`)
- Selected variant: `baseline`
- `core-no-binary`: pass, mappedFiles=6, mappedSymbols=16
- `core-no-binary-no-pretty`: pass, mappedFiles=6, mappedSymbols=16
- `core-no-binary-top120`: pass, mappedFiles=6, mappedSymbols=16
- `core-runtime-probe-soft`: pass, mappedFiles=6, mappedSymbols=16

## Known Gaps / Noise
- Runtime probe remains environment-dependent and can still produce machine-specific variance.
- Reference parity is still partial, especially in chat/session coverage depth.
- Symbol recovery now reaches upper calibration band `16` without generic-path leakage; next gap is lifting symbol semantic precision.

## Next Improvements (Generator-First)
- Continue slicing `reverse.ts` toward orchestration-only (next candidates: additional extraction/index helpers and binary/rpc utilities).
- Keep calibrating symbol ownership precision on fixed regression runs while holding mappedSymbols at `16` and avoiding generic leakage.
- Extend snapshot baseline coverage as new app snapshot versions are added.
