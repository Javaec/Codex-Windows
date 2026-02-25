# AGENTS.md

## Purpose
Build a deterministic decompile/deobfuscation orchestrator that emits a usable TypeScript project from Electron snapshots.

## Goals
- Keep `reverse` flow stage-based and reproducible (`run-manifest.json`).
- Keep quality output readable and stable across runs.
- Keep architecture portable for new snapshots and new Electron apps.

## Constraints
- Quality TS output is generated only from AST-lift bindings.
- No speculative/proxy TS modules in quality output paths.
- One symbol must satisfy ownership compatibility (`layer <-> archetype`) before emitter.
- One chunk is one source artifact (`chunk-artifacts.json`).

## Integration Points
- Tool adapters: `asar`, `webcrack`, `wakaru`, `javascript-deobfuscator`, `synchrony`, `unwebpack-sourcemap`.
- IR stages: `evidence-store`, `semantic-ir`, `naming-memory`, `ownership-resolver`.
- Emit/gates: `template-emitter`, `quality-gates`, `green-gates`.

## Current Decisions
- Snapshot-scoped naming memory lives in `naming-memory-store/snapshots/snapshot-<sha12>.json`.
- New snapshot bootstraps naming memory from legacy file or latest snapshot profile.
- Coverage contour stays in artifacts (`pending-lift-symbols.json`) and does not pollute quality TS tree.
- Regression suite merges evidence at symbol/file level into `merged-evidence.json` to pick best winners across profiles.
- Iteration stop-rule is automated through `regression:cycles` (`quality delta` + `high-confidence delta` stagnation guard).
- `regression:cycles` promotes `merged-evidence` top-N symbols directly into snapshot naming-memory after each cycle.
- Monolith-first naming uses `unified-monolith.js` + `symbol-table.json` as canonical coverage naming sources.
  Verified reason: `monolith-census` now emits deterministic pass-1 (`Class/Func/Var`) and pass-2 (`parse/sum/state/orchestrate`) names for all covered declaration anchors.
- Naming stage maintains two contours: aggressive coverage (`semantic-ir.coverage.named.json`) and strict quality (`semantic-ir.named.json`).
  Verified reason: coverage ownership now tracks full symbol set while quality emitter continues to consume strict quality names only.

## Next Steps
- Continue improving symbol ownership and import shaping for top noisy modules.
- Improve cluster/topic naming so generated module names are more domain-specific.
- Keep regression suite green for all four fixed profiles.
