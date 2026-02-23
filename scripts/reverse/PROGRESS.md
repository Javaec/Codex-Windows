# Reverse/Deobfuscation Progress Notes

## Snapshot
- Date (UTC): 2026-02-23
- Latest validated run: `C:\Codex-Windows\work\reverse\latest` (`run-20260223-115657Z`)
- Latest fixed regression suite root: `C:\Codex-Windows\work\reverse\regression-latest`
- Pipeline entrypoint: `scripts/ts/reverse.ts`

## Current Pipeline Shape

### Reference and Matching
- Unified reference source-of-truth: `scripts/ts/reverse/reference-model.ts`
  - reads:
    - `reference/analysis/1code-codexmonitor-architecture-map.md`
    - `reference/analysis/1code-symbol-map.json`
    - `reference/analysis/CodexMonitor-symbol-map.json`
  - emits:
    - `report/reference-model.json`
    - `report/reference-signals.json`
    - `report/reference-symbols.json`
- Matching stage: `scripts/ts/reverse/match-v2.ts`
  - multi-signal scoring:
    - AST
    - IPC/RPC
    - state keys
    - component boundaries
    - route/event flow
    - layer/path-map alignment
  - ownership-aware scoring:
    - boundary ownership boost/penalty
    - UI likelihood alignment
  - aggressive and completion symbol coverage paths remain bounded by quality gates.

### Reverse Orchestrator Decomposition
- Major reverse stages have been extracted from `reverse.ts`:
  - `domain-boundaries.ts`
  - `domain-flow-parity.ts`
  - `ipc-contract-map.ts`
  - `ipc-wrapper-decode.ts`
  - `runtime-probe.ts`
  - `rpc-schema.ts`
  - `session-route-flow.ts`
  - `reference-parity.ts`
  - `deobfuscation-report.ts`
  - `architecture-report.ts`
  - `summary-composer.ts`
  - `report-writer.ts`
  - `webstorm-project.ts`
  - `output-discipline.ts`

### Generated Project Policy
- Generator stage: `scripts/ts/reverse/webstorm-project.ts`
- TS-first layout is fixed to:
  - `project/src/main/*`
  - `project/src/renderer/*`
  - `project/src/services/*`
  - `project/src-tauri-adapter/*`
- Artifact model is strict:
  - one source chunk -> one chunk artifact in `project/src/chunks/*`
  - source-to-artifact mapping in `project/mapping/chunk-artifacts.json`
  - reconstructed module map in `project/mapping/reconstructed-map.json`
  - lift diagnostics in `project/mapping/lifter-diagnostics.json`

## Major Milestones Reached (2026-02-23)

### 1) Chunk Bridge Elimination
- `chunkBridgeMode` reduced to `0`.
- `placeholderMode` reduced to `0`.
- AST-lift now resolves all reconstructed modules without bridge placeholders in the latest run.

### 2) Ownership-Based Source Switching
- Reconstruction no longer hard-binds to initial source chunk only.
- Source candidates are ranked per target module and switched when ownership quality is higher.
- Parser-heavy sources are penalized when cleaner ownership candidates exist.

### 3) Parser/Registry Unpack Rule
- `symbol-lifter.ts` now supports parser/registry unpack override (`allowParserRegistryUnpack`).
- Rule allows lifting generated parser/registry blocks when needed instead of forced unresolved fallback.
- In latest run, source reranking avoided parser-heavy routes entirely (`parserRegistryUnpackUsed = 0`), but unpack path is available as controlled fallback.

### 4) Output Noise Reduction
- Chunk artifact writes are now demand-driven for selected sources only.
- Artifact count returned to low stable range after source-switch refactor.

## Hard Quality Gates (Current)
- Gate stage: `scripts/ts/reverse/quality-gates.ts`
- Output: `report/quality-gates.json`
- Enforced conditions:
  - `mappedFiles` in `[4..6]`
  - `mappedSymbols >= 12` and non-regression against `work/reverse-quality-history.json`
  - no generic target-path noise (`types/utils/index/common/shared`)
  - generated project checks pass:
    - `npm install`
    - `tsc --noEmit`
    - `eslint` (`errors=0`, `warnings=0`)
  - artifact integrity checks pass.

## Latest Metrics (`run-20260223-115657Z`)

### Gate Metrics
- `passed = true`
- `mappedFiles = 6`
- `mappedSymbols = 8382`
- `lowConfidenceSymbols = 0`
- `noisySymbolNames = 0`
- `genericNoisePaths = []`
- `installSuccess = true`
- `tscErrors = 0`
- `eslintErrors = 0`
- `eslintWarnings = 0`
- `reconstructedRows = 41`
- `chunkArtifactRows = 11`

### Lifter Diagnostics Aggregate
- `rows = 41`
- `chunkBridgeMode = 0`
- `placeholderMode = 0`
- `sourceSwitchUsed = 19`
- `recoveryModeUsed = 1`
- `parserRegistryUnpackUsed = 0`

### Active Chunk Artifacts (11)
- `.vite/build/main-Bs98CzMV.js`
- `.vite/build/worker.js`
- `webview/assets/_basePickBy-DkbAhjPl.js`
- `webview/assets/_baseUniq-Ds3QSdgP.js`
- `webview/assets/architectureDiagram-VXUJARFQ-msbZ-ZkB.js`
- `webview/assets/blockDiagram-VD42YOAC-DdBnVuyH.js`
- `webview/assets/ganttDiagram-LVOFAZNH-DeKyPIdq.js`
- `webview/assets/index-X7Ur8m0p.js`
- `webview/assets/treemap-KMMF4GRG-DrZSO-R-.js`
- `webview/assets/worker-CJ6-3-tZ.js`
- `webview/assets/xychartDiagram-PRI3JC2R-5nM4tXmC.js`

## Fixed Regression Suite
- Config: `scripts/ts/reverse/regression-config.ts`
- Runner: `scripts/ts/reverse-regression.ts`
- Baselines: `scripts/reverse/regression-baselines.json`
- Fixed suite:
  - `core-no-binary`
  - `core-no-binary-no-pretty`
  - `core-no-binary-top120`
  - `core-runtime-probe-soft`
- Variants:
  - `baseline`
  - `ownership_boost`
  - `file_recall_boost`

## Known Gaps
- Name semantics in some AST-lifted modules still contain synthetic patterns (especially in non-reference-rich chunks).
- Runtime probe remains environment-sensitive.
- Reference parity depth in some chat/session paths remains partial.

## Current Focus
- Improve semantic quality of reconstructed export names without relaxing gates:
  - targeted rename pass on noisy AST-lift exports
  - stronger module-path ownership rerank
  - keep `chunkBridgeMode = 0` and `placeholderMode = 0`
- Recent validated improvements:
  - removed noisy reconstructed names (`eventGetObjectReadyUse*`, `eventsMathMaxUse`, `expRegRegexpUse`)
  - preserved canonical hook-style exports in target modules (`useAppServerEvents`)

## Recent Commits
- `6a2ff55` `✨ Strengthen symbol-target indexing and recovery heuristics`
- `3e4eaf1` `🚀 Eliminate chunk bridges with ownership source switching and parser unpack`
- `6888d14` `✨ Prefer higher-quality ownership sources over parser-heavy lifts`
