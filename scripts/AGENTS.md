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
- 2026-03-04: Introduced a profile-driven patch pipeline in runner (`scripts/ts/lib/patch-pipeline.ts`).
  - Patch flow is now a single orchestrated stage with explicit profile selection.
  - Profiles are no longer hardcoded in runner code; they are loaded from shared patch-pack:
    - `C:\Codex-Windows\shared\patch-pack\profile-selector.json`
    - `C:\Codex-Windows\shared\patch-pack\profiles\*.json`
    - `C:\Codex-Windows\shared\patch-pack\mods\*.json`
    - `C:\Codex-Windows\shared\patch-pack\patch-catalog.json`
  - Step contract is explicit (`preload`, `webview-sunset`, `webview-cwd`, `main-runtime-shim`) with per-step required/optional semantics.
  - `run.ts` no longer hardcodes independent patch calls; it invokes one patch pipeline entrypoint and writes `patch-pipeline-report.json`.
  - Auto profile resolver now uses snapshot label (`Codex-10711.dmg` style) before package metadata because newer builds may expose low/ambiguous `codexBuildNumber`.
  - `-PatchProfile` override added for deterministic version-transition runs.
  - Why: lower coupling, less legacy branching in `run.ts`, easier migration across obfuscation shifts between Codex builds.
- 2026-03-04: Patch-pack is now mod-loader based.
  - Profiles select ordered mod sets; runner merges steps from selected mods only.
  - Step report includes `sourceModId` for deterministic provenance.
  - Stage orchestration is now registry-driven via `shared/patch-pack/stage-registry.json`:
    - required stages: `extract -> deobf -> mods -> runtime-pack`,
    - mods are injectors (`lane` + `injector.stageId/inputContract/outputContract`),
    - stage order is loaded from registry (no stage-rank fallback in code).
  - Added shared fail-fast preflight command: `npm run patch-pack:preflight`.
  - Added snapshot-pinned preflight command for daily migration checks:
    - `npm run patch-pack:preflight:10711`
  - Added conflict fixture assertion:
    - `npm run patch-pack:test:mod-conflict`
  - Why: one patch source-of-truth for repacker/generator/manual, easier upgrade between Codex versions.
- 2026-03-04: Webview patch APIs now return structured summaries.
  - `patchWebviewAppSunsetGate` and `patchWebviewCwdNormalization` now support strict/optional mode via `allowMissingPatchPoint`.
  - Why: pipeline can enforce fail-fast in known profiles and controlled recovery in generic profile without hidden behavior.

### Reference files used for this design
- `reference/decompile/asar/src/asar.ts` (clear stage boundaries and deterministic flow).
- `reference/decompile/pkg-unpacker/src/unpacker.ts` (strict parsing path and explicit error-first control flow).

- Webview sunset-gate patching is signature-tolerant:
  - keep legacy exact needles for known bundles;
  - fallback to semantic detection (`appSunset.title` / `Update required`) and patch the gating branch by component reference.
- 2026-03-04: Webview patching for `Codex-10711.dmg` is now best-effort for signature drift.
  - `patchWebviewAppSunsetGate` no longer fails the whole pipeline when patch point is missing; it logs a warning.
  - `patchWebviewCwdNormalization` now uses the same behavior for unknown obfuscation signatures.
  - Rationale: new bundle signatures changed and strict hard-fail blocked repack despite all required payload files being present.
- 2026-03-04: Added explicit Codex-10711 sunset gate signature support.
  - New direct needle handled: `const s=ys(i);if(r){`.
  - Semantic matcher now also tracks React calls with `f.jsx/f.jsxs` (in addition to `h.jsx/h.jsxs`).
  - Verified output bundle now contains `/* CODEX-WINDOWS-APP-SUNSET-BYPASS-V1 */` and replaces gate with `const s=!1;if(r){`.
- 2026-03-04: Extended SQLite path migration for chat/thread loading compatibility on newer builds.
  - Migration now targets both `threads.cwd` and `threads.rollout_path`.
  - Handles prefixes: `\\?\`, `//?/`, `/??/`, and leading slash/backslash drive forms.
  - Reason: newer builds read rollout/session paths more strictly; leaving prefixed paths can hide existing chats.
- 2026-03-04: Hardened SQLite thread-path migration to row-level normalization.
  - Replaced bulk SQL prefix updates with deterministic per-row normalization for `threads.cwd` and `threads.rollout_path`.
  - Added shared path normalization in runtime sanitizer for `\\?\`, `//?/`, `/??/`, and stray leading drive slash forms.
  - Reason: on some obfuscated builds, bulk SQL pattern matching was inconsistent during startup; row-level normalization is stable.
- 2026-03-04: Added DB-level path normalization triggers for chat thread paths.
  - Runtime shim now creates `threads` triggers for both `cwd` and `rollout_path` on INSERT/UPDATE.
  - Triggers enforce normalization of `\\?\`, `//?/`, `/??/`, and malformed leading drive slash forms.
  - Reason: newer builds were reintroducing prefixed paths after startup via runtime writes; startup migration alone was not enough.
- 2026-03-04: Canonical runbook for the three repack-critical patches.
  - Patch A: `patchWebviewAppSunsetGate`
    - keep direct needles (`Xs`, `Cs`, `ys`) and semantic fallback by `appSunset.title` / `Update required`.
    - branch matcher must accept both `h.jsx/h.jsxs` and `f.jsx/f.jsxs`.
    - patch result must force gate false (`const <gateVar>=!1`).
    - unknown signature must not abort full repack.
  - Patch B: `patchWebviewCwdNormalization`
    - keep optional signature matching; warning-only on mismatch.
    - normalize `\\`, `//?/`, `/??/`, `/C:/` forms in webview-side path compare.
  - Patch C: run/build CLI source policy
    - prefer local bundled CLI (`dist/*/resources/codex.exe`) before npm-vendor discovery.
    - this is required for app-server contract compatibility and stable chat/session behavior.
  - SQLite escaping/migration policy:
    - normalize both `threads.cwd` and `threads.rollout_path`.
    - strip `\\?\`, `//?/`, `/??/`, and malformed leading drive slash.
    - keep row-level startup migration + DB triggers on INSERT/UPDATE so prefix reintroduction is impossible.
    - post-launch checks:
      - `cwd`/`rollout_path` prefixed counts are `0`;
      - `codex_windows_threads_*_normalize_*` triggers exist.
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

### 2026-03-03 Windows Path Open Reliability
- Repack runtime shim upgraded to `CODEX-WINDOWS-ENV-SHIM-V7`.
- `patchMainForWindowsEnvironment` now enforces open-file path cleanup patch point in bundled `main.js` and fails fast if missing.
- Added shell-level path sanitizer for `electron.shell.openPath` and `electron.shell.showItemInFolder`.
- Sanitizer removes accidental drive-leading slash/backslash prefixes while keeping UNC paths untouched.

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
