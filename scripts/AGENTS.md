# Scripts AGENTS

## Purpose
Keep Windows runner tooling deterministic, debuggable, and easy to automate.

## Goals
- Preserve stable `run/build` behavior.
- Add standalone utilities without coupling them into launch path.
- Prefer repeatable outputs (JSON/Markdown artifacts) over ad-hoc logs.

## Why
Scripts are the single operational entrypoint for packaging, patching, and diagnostics.

## Constraints
- Do not change existing run/build behavior unless explicitly requested.
- Keep Node/TypeScript tooling dependency-light.
- Use explicit hard failures instead of silent fallbacks.
- For every task, review at least 2 relevant files from reference projects under `reference/decompile/*` before designing or changing implementation.

## Reference-First Workflow
- Minimum input for any task: 2 closest files from reference projects that solve a similar problem.
- Use those files to guide architecture decisions, naming, and stage boundaries.
- If no close reference exists, document that explicitly and proceed with the strictest modular option.

## Integration Points
- `scripts/ts/run.ts` -> main pipeline.
- `scripts/ts/lib/*` -> shared helpers.
- `scripts/node/*` -> compiled runtime artifacts.

## Current Decisions
- Reverse-engineering tooling is implemented as a separate CLI (`reverse.ts`) and not mixed into launch/build pipeline.
- Webview sunset-gate patching is signature-tolerant:
  - keep legacy exact needles for known bundles;
  - fallback to semantic detection (`appSunset.title` / `Update required`) and patch the gating branch by component reference.
- Legacy webview auto-scroll artifacts are removed during repack so stale injected scripts cannot survive into new builds.

## Reverse Pipeline Status (2026-02-23)

### Latest Stable Validation
- Latest reverse run: `C:\Codex-Windows\work\reverse\latest`
- Latest archived run id: `run-20260223-123314Z`
- Quality gates report: `C:\Codex-Windows\work\reverse\latest\report\quality-gates.json`
- Project diagnostics: `C:\Codex-Windows\work\reverse\latest\project\mapping\lifter-diagnostics.json`

### Current Hard Metrics
- `mappedFiles = 6` (target range: `4..6`)
- `mappedSymbols = 8382` (non-regressing)
- `lowConfidenceSymbols = 0`
- `noisySymbolNames = 0`
- `genericNoisePaths = []`
- Generated project checks:
  - `npm install = success`
  - `tsc errors = 0`
  - `eslint errors = 0`
  - `eslint warnings = 0`
- Reconstructed modules: `41`
- Chunk artifacts: `11` unique source artifacts

### AST Lift and Reconstruction Milestone
- `chunkBridgeMode` is now eliminated (`0` modules).
- `placeholderMode` is now eliminated (`0` modules).
- Parser-heavy modules are no longer forced through bridge fallback:
  - ownership-aware source switching selects better source chunks when available.
  - parser/registry unpack is available in symbol lifter and can be enabled per module when required.
- Current diagnostics snapshot:
  - source switches used in `23` reconstructed modules
  - targeted unresolved recovery used in `1` module
  - parser unpack currently `0` after quality rerank (cleaner alternative sources won)

### Architectural Guardrails
- Single reference truth remains `scripts/ts/reverse/reference-model.ts` for:
  - `reference/analysis/1code-codexmonitor-architecture-map.md`
  - `reference/analysis/1code-symbol-map.json`
  - `reference/analysis/CodexMonitor-symbol-map.json`
- Match stage is `match-v2` only (multi-signal scoring with AST + IPC/RPC + state + boundaries + flow + layer alignment).
- Generated project remains TS-first and constrained to:
  - `project/src/main/*`
  - `project/src/renderer/*`
  - `project/src/services/*`
  - `project/src-tauri-adapter/*`
- Artifact integrity remains strict:
  - one source chunk -> one source artifact in `project/src/chunks/*`
  - correspondence tracked in `project/mapping/chunk-artifacts.json`

### Recent Reverse Milestones
- `6a2ff55` `✨ Strengthen symbol-target indexing and recovery heuristics`
- `3e4eaf1` `🚀 Eliminate chunk bridges with ownership source switching and parser unpack`
- `6888d14` `✨ Prefer higher-quality ownership sources over parser-heavy lifts`

## Active Workstream
- Improve semantic quality of exported names in AST-lifted modules:
  - targeted rename of noisy exports
  - stronger ownership-based rerank with module-path alignment
  - keep quality gates strict and avoid reintroducing bridge/placeholders
- Current validated pass removed noisy patterns from reconstructed modules:
  - `eventGetObjectReadyUse*` removed
  - `eventsMathMaxUse` / `expRegRegexpUse` removed
  - hook modules now preserve canonical `use*` export names (example: `useAppServerEvents`)
  - transport modules now emit readable class/runtime names (examples: `AcpChatTransport`, `IpcChatTransportRuntime`)

## Next Steps
- Finish contextual export naming pass for AST-lift modules to reduce synthetic names and align closer to CodexMonitor style.
- Keep reducing reverse orchestrator complexity while preserving single-source-of-truth boundaries.
