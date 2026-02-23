# Codex App Reverse Pipeline

This tool extracts and indexes Codex App logic/UI artifacts from an already extracted app directory.
By default every run loads `reference/analysis/1code-codexmonitor-architecture-map.md` and injects it as reference priors.

Progress snapshot: see `scripts/reverse/PROGRESS.md`.

Current milestone (2026-02-23):
- AST reconstruction runs with `chunkBridgeMode=0` and `placeholderMode=0` in latest validated run.
- Ownership-based source switching is enabled to avoid parser-heavy chunk selection when cleaner ownership candidates exist.
- Quality gates remain strict and green (`mappedFiles=6`, project checks clean).
- Contextual rename + ownership rerank now suppress common noisy AST-lift names in generated modules while preserving canonical hook exports.
- Hook/transport focused rename-pass now produces cleaner domain exports (`useAppServerEvents`, `AcpChatTransport`, `IpcChatTransportRuntime`, etc.).

## Pipeline modules

- `scripts/ts/reverse/reference-model.ts` unified reference source-of-truth (architecture map + symbol maps + extracted path map).
- `scripts/ts/reverse/domain-boundaries.ts` domain scoring + component boundary extraction stage.
- `scripts/ts/reverse/domain-flow-parity.ts` orchestration stage for domain/boundary/session/parity reports wired to unified reference-model.
- `scripts/ts/reverse/match-v2.ts` multi-signal file/symbol matching.
- `scripts/ts/reverse/ipc-contract-map.ts` IPC contract map extraction stage.
- `scripts/ts/reverse/ipc-wrapper-decode.ts` IPC wrapper decode internals (alias/wrapper/global lookup extraction) used by IPC contract stage.
- `scripts/ts/reverse/runtime-probe.ts` runtime probe orchestration + warning/error line classification.
- `scripts/ts/reverse/rpc-schema.ts` RPC schema extraction (bundle + binary + runtime + AST static signals).
- `scripts/ts/reverse/session-route-flow.ts` session flow + route-boundary graph.
- `scripts/ts/reverse/reference-parity.ts` reference parity gaps report.
- `scripts/ts/reverse/architecture-report.ts` architecture markdown builder extracted from reverse orchestrator.
- `scripts/ts/reverse/summary-composer.ts` summary.json composition extracted from reverse orchestrator.
- `scripts/ts/reverse/report-writer.ts` report artifact writer (json/markdown/csv/txt outputs).
- `scripts/ts/reverse/quality-gates.ts` hard quality gate enforcement (mappedFiles/symbol growth/generic noise/project checks/artifact integrity).
- `scripts/ts/reverse/regression-config.ts` fixed regression runs + match-v2 calibrated weight profile.
- `scripts/ts/reverse/output-discipline.ts` stable `latest` output sync + archived runs keep-last-N cleanup.
- `scripts/ts/reverse/webstorm-project.ts` TS-first project reconstruction.
- `scripts/ts/reverse-regression.ts` fixed-suite regression driver + match-v2 variant auto-calibration.

## Run

```powershell
npm run build:runner
npm run reverse:codex-app -- -AppDir C:\Codex-Windows\work\app
npm run reverse:regression -- -AppDir C:\Codex-Windows\work\app
```

Default stable output roots:
- reverse latest: `C:\Codex-Windows\work\reverse\latest`
- reverse runs archive: `C:\Codex-Windows\work\reverse\runs`
- regression latest: `C:\Codex-Windows\work\reverse\regression-latest`
- regression runs archive: `C:\Codex-Windows\work\reverse\regression-runs`

Regression baselines are pinned by app snapshot version (`name@version`) in:
`scripts/reverse/regression-baselines.json`.

Current hard quality gates include:
- `mappedFiles` in `4..6`
- `mappedSymbols >= 12` and no regression versus history
- no generic-path noise (`types/utils/index/common/shared`)
- generated project checks must pass (`npm install`, `tsc`, `eslint`)

Reference inputs are owned by `reference-model.ts` only (architecture map + both symbol maps + path map extraction),
and consumed by downstream stages through thin adapters.

## Output

- `report/summary.json`
- `report/architecture.md`
- `report/chunk-graph.json`
- `report/ipc-channels.json`
- `report/methods.json`
- `report/rpc-catalog.json`
- `report/ipc-contract-map.json`
- `report/routes.json`
- `report/message-types.json`
- `report/statuses.json`
- `report/state-keys.json`
- `report/domain-report.json`
- `report/component-boundaries.json`
- `report/deobfuscation-table.json`
- `report/deobfuscation-table.md`
- `report/deobfuscation-table.csv`
- `report/rename-plan.md`
- `report/session-flow.json`
- `report/session-flow.md`
- `report/route-boundary-graph.json`
- `report/runtime-probe.json` (when `-RuntimeProbe` is enabled)
- `report/design-system.json`
- `report/reference-signals.json`
- `report/reference-symbols.json`
- `report/reference-model.json` (unified reference source-of-truth from architecture map + both symbol maps + path map)
- `report/reference-parity-gaps.json`
- `report/quality-gates.json` (hard gate result + failures/metrics)
- `report/1code-codexmonitor-architecture-map.md` (copied reference context, when found)
- `project/*` generated IDE-friendly test project (clean re-create on each run)
  - `project/src/chunks/*` (single source artifact per chunk)
  - `project/src/main/*`
  - `project/src/renderer/*`
  - `project/src/services/*`
  - `project/src-tauri-adapter/*`
  - `project/mapping/*`
  - `project/mapping/chunk-artifacts.json` (chunk source map)
  - `project/meta/checks.json` (npm install + tsc + eslint checks)
- `raw/*` source snapshot
- `decompiled/*` TypeScript-printer output for JS bundles

## Options

- `-NoPretty` skip printer decompile pass
- `-NoBinary` skip extraction from bundled `codex` binary
- `-NoClean` keep previous output dir
- `-RuntimeProbe` launch app with Electron and isolated `--user-data-dir` sandbox profile
- `-RuntimeProbeMs <num>` probe duration in ms (default: 45000)
- `-ElectronExe <path>` explicit Electron executable path for probe
- `-MaxPrettyMb <num>` cap per-file size for pretty pass
- `-Top <num>` top rows in markdown report sections
- `-ReferenceMap <path>` explicit reference architecture map (default is auto-loaded from `reference/analysis/1code-codexmonitor-architecture-map.md`)
- `-RunsRoot <path>` archive root for run snapshots (default: `work/reverse/runs`)
- `-KeepLastRuns <num>` keep latest N archived runs (default: `12`)
- `-RunId <value>` explicit stable run id
- `-NoLatestSync` disable `latest` sync + keep-last cleanup discipline

Regression-only options:
- `-RunsRoot <path>` archive root for regression suites (default: `work/reverse/regression-runs`)
- `-KeepLastRuns <num>` keep latest N regression suites (default: `8`)
- `-RunId <value>` explicit stable regression run id
- `-NoLatestSync` disable stable `regression-latest` sync
- `-NoAutocalibrate` run only baseline match-v2 variant
- `-MatchVariant <id>` run a single explicit match-v2 variant id (`baseline`, `ownership_boost`, `file_recall_boost`)
