# Codex App Reverse Pipeline

This tool extracts and indexes Codex App logic/UI artifacts from an already extracted app directory.
By default every run loads `reference/analysis/1code-codexmonitor-architecture-map.md` and injects it as reference priors.

## Run

```powershell
npm run build:runner
npm run reverse:codex-app -- -AppDir C:\Codex-Windows\work\app -OutDir C:\Codex-Windows\work\reverse-codex-app
```

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
- `report/session-flow.json`
- `report/session-flow.md`
- `report/route-boundary-graph.json`
- `report/runtime-probe.json` (when `-RuntimeProbe` is enabled)
- `report/design-system.json`
- `report/reference-signals.json`
- `report/1code-codexmonitor-architecture-map.md` (copied reference context, when found)
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
