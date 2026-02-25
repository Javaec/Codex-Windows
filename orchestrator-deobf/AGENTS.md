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

## Next Steps
- Continue improving symbol ownership and import shaping for top noisy modules.
- Improve cluster/topic naming so generated module names are more domain-specific.
- Keep regression suite green for all four fixed profiles.
