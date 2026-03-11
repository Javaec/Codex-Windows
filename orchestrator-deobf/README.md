# orchestrator-deobf

Legacy deobfuscation workspace. It is kept for occasional recovery/migration work and is not part of the normal `Codex Lite` repack path.

Stage-based orchestrator for decompile/deobfuscation pipelines.

## Design rules

- Each stage is file-contract based: reads `input.json`, writes `output.json`.
- No hidden shared state between stages.
- Every run is reproducible through `run-manifest.json`.
- Optional accelerators are explicit flags and not enabled by default.

## Pipeline

1. `asar-extract`
2. `webcrack`
3. `wakaru`
4. `javascript-deobfuscator` (optional)
5. `synchrony` (optional)
6. `unwebpack-sourcemap` (optional)
7. `evidence-store`
8. `semantic-ir`
9. `naming-memory`
10. `ownership-resolver`
11. `chunk-artifact-model`
12. `template-emitter`
13. `quality-gates`
14. `green-gates`
15. `decision-dashboard`

## Step 2 artifacts

- `artifacts/evidence-store.json`: unified evidence (file/symbol/call/state/sourcemap hints).
- `artifacts/semantic-ir.json`: semantic-ir v2 with domain declarations (`service/use-case/store/hook/transport/ui`) and declaration clusters.
- `artifacts/semantic-ir.named.json`: IR after naming-memory application.
- `artifacts/semantic-ir.coverage.named.json`: aggressive coverage contour naming.
- `artifacts/semantic-ir.named.json`: strict quality contour naming.
- `naming-memory.json` (project root): monotonic naming memory across runs.
- `artifacts/monolith-census/unified-monolith.js`: canonical pass-2 monolith (rough semantic names).
- `artifacts/monolith-census/symbol-table.json`: canonical naming map for coverage contour (class/function/callable/variable).

## Step 3 artifacts

- `artifacts/ownership-model.json`: hard ownership (`one symbol = one layer`) + archetype from semantic-ir v2 domains.
- `artifacts/chunk-artifacts.json`: strict `1 chunk = 1 source artifact` model + symbol mappings.
- `artifacts/project/*`: quality-only TypeScript output emitted from AST-lift bindings (no speculative/proxy TS modules).
- `artifacts/project/artifacts/pending-lift-symbols.json`: unresolved symbols that remain in coverage contour and are not emitted as quality TS.
- `artifacts/emitted-files.json`: deterministic file ordering index.
- `quality-gates.json`: gate report for generation quality checks.
- `output/latest/project` and `output/regression-latest/project`: stable generated outputs.

## Step 4 artifacts

- `run-metrics.json`: baseline metrics (`mappedFiles`, `mappedSymbols`, `highConfidenceSymbols`, `nameQuality`, `variableCoverage`, `buildHealth`, `devHealth`).
- `green-gates.json` + `green-gates-logs/*`: `npm install`, `typecheck`, `lint`, `build`, `dev:smoke` checks with runtime log analysis.
- `decision-dashboard.json` and `decision-dashboard.md`: action split into orchestrator changes, external tool patches, and post-rename pass.
- `regression/baseline-metrics.json`: fixed-suite baseline report (4 profiles).
- `regression/runs/<suiteRunId>/merged-evidence.json`: merged symbol/file winners across suite profiles (confidence/provenance aware).
- `regression/cycle-report.json`: stop-rule cycle history (`quality delta`, `high-confidence delta`, stagnation strikes).
- `naming-memory-store/snapshots/snapshot-<sha12>.json`: cycle-level naming memory promoted from `merged-evidence.json` top-N winners.

## Run

```powershell
npm install
npm run build
node dist/index.js --snapshot "C:\Codex-Windows\work\electron\Codex Installer\Codex.app\Contents\Resources\app.asar"
```

## Optional accelerators

```powershell
node dist/index.js --snapshot "<path>" --enable-synchrony
node dist/index.js --snapshot "<path>" --enable-javascript-deobfuscator
node dist/index.js --snapshot "<path>" --enable-unwebpack-sourcemap --python python --unwebpack-sourcemap-max-maps 20
```

Additional flags:

- `--javascript-deobfuscator-module`
- `--synchrony-rename`
- `--synchrony-loose`
- `--wakaru-concurrency <n>`
- `--profile <latest|regression-latest>`
- `--statement-budget <n>`
- `--no-force-overwrite`

Run artifacts are written to `runs/<runId>/`.

## Regression Suite

```powershell
npm run build
npm run regression:suite -- --snapshot "C:\Codex-Windows\work\electron\Codex Installer\Codex.app\Contents\Resources\app.asar"
```

The suite is fixed in `config/regression-suite.json` and keeps only last N suite runs.

## Regression Cycles (Stop-Rule)

```powershell
npm run build
npm run regression:cycles -- --snapshot "C:\Codex-Windows\work\electron\Codex Installer\Codex.app\Contents\Resources\app.asar"
```

Cycle runner applies stop-rule: when quality gain is below threshold and high-confidence symbols do not grow for N consecutive cycles.
After each cycle, `merged-evidence.json` is consumed as naming-memory promotion input (`top-N per cycle`).
Use `--promotion-budget-per-cycle <n>` to control promotion throughput (default `100`).
