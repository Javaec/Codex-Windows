# Codex App Reverse Pipeline

This tool extracts and indexes Codex App logic/UI artifacts from an already extracted app directory.
By default every run loads `reference/analysis/1code-codexmonitor-architecture-map.md` and injects it as reference priors.

Progress snapshot: see `scripts/reverse/PROGRESS.md`.

## Pipeline modules

- `scripts/ts/reverse/reference-model.ts` unified reference source-of-truth (architecture map + symbol maps + extracted path map).
- `scripts/ts/reverse/domain-boundaries.ts` domain scoring + component boundary extraction stage.
- `scripts/ts/reverse/match-v2.ts` multi-signal file/symbol matching.
- `scripts/ts/reverse/ipc-contract-map.ts` IPC contract map extraction stage.
- `scripts/ts/reverse/ipc-wrapper-decode.ts` IPC wrapper decode internals (alias/wrapper/global lookup extraction) used by IPC contract stage.
- `scripts/ts/reverse/rpc-schema.ts` RPC schema extraction (bundle + binary + runtime + AST static signals).
- `scripts/ts/reverse/session-route-flow.ts` session flow + route-boundary graph.
- `scripts/ts/reverse/reference-parity.ts` reference parity gaps report.
- `scripts/ts/reverse/quality-gates.ts` hard quality gate enforcement (mappedFiles/symbol growth/generic noise/project checks/artifact integrity).
- `scripts/ts/reverse/regression-config.ts` fixed regression runs + match-v2 calibrated weight profile.
- `scripts/ts/reverse/webstorm-project.ts` TS-first project reconstruction.
- `scripts/ts/reverse-regression.ts` locked regression-run driver over fixed run-set.

## Run

```powershell
npm run build:runner
npm run reverse:codex-app -- -AppDir C:\Codex-Windows\work\app -OutDir C:\Codex-Windows\work\reverse-codex-app
npm run reverse:regression -- -AppDir C:\Codex-Windows\work\app -OutRoot C:\Codex-Windows\work\reverse-regression
```

Regression baselines are pinned by app snapshot version (`name@version`) in:
`scripts/reverse/regression-baselines.json`.

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
