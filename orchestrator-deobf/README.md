# orchestrator-deobf

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
- `naming-memory.json` (project root): monotonic naming memory across runs.

## Step 3 artifacts

- `artifacts/ownership-model.json`: hard ownership (`one symbol = one layer`) + archetype from semantic-ir v2 domains.
- `artifacts/chunk-artifacts.json`: strict `1 chunk = 1 source artifact` model + symbol mappings.
- `artifacts/project/*`: template-driven TypeScript-first emitted project with archetype contracts and cluster-driven module synthesis.
- `artifacts/emitted-files.json`: deterministic file ordering index.
- `quality-gates.json`: gate report for generation quality checks.
- `output/latest/project` and `output/regression-latest/project`: stable generated outputs.

## Step 4 artifacts

- `run-metrics.json`: baseline metrics (`mappedFiles`, `mappedSymbols`, `nameQuality`, `buildHealth`, `devHealth`).
- `green-gates.json` + `green-gates-logs/*`: `npm install`, `typecheck`, `lint`, `build`, `dev:smoke` checks with runtime log analysis.
- `decision-dashboard.json` and `decision-dashboard.md`: action split into orchestrator changes, external tool patches, and post-rename pass.
- `regression/baseline-metrics.json`: fixed-suite baseline report (4 profiles).

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

## Auto Calibration

```powershell
npm run build
npm run regression:calibrate -- --snapshot "C:\Codex-Windows\work\electron\Codex Installer\Codex.app\Contents\Resources\app.asar"
```

Calibration iterates tool weight candidates only on regression suite and writes the best result to `config/tool-weights.json`.
Use `--max-candidates <n>` to limit calibration runtime.
