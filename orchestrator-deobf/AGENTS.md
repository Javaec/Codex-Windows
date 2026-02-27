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
- Merged-evidence promotion now prioritizes `selected != currentName` upgrade candidates before insert-heavy picks.
  Verified reason: selection and monotonic fallback are tuned to increase `promotionUpdatedCount` per cycle while keeping anti-generic and quality guards.
- Quality emitter now runs a heavier logic-first synthesis profile:
  - aggressive chunk-index dependency inline (threshold `6`),
  - expanded hot chunk full-lift window (`90`, min `40`, closure `768`),
  - stronger module consolidation with guarded split/merge rebalancing,
  - no redundant default `api` glue object in generated modules.
  Verified reason: reduce import/proxy noise and keep more real lifted logic directly in `src/*`.
- Quality emitter naming now applies anti-generic guards for `channelDispatch`/alphabet-run patterns and uses chunk/domain hints before route/event flow tokens.
  Verified reason: generated exports shifted from synthetic `*ChannelDispatch*` to domain-oriented names (`*Asar*`, `*AngularHtml*`, `*ApacheEvent*`, etc.) while keeping quality gates green.
- Quality emitter enforces unique module output paths after cohesion merge/split.
  Verified reason: avoided `filePath` collisions where multiple module plans were overwriting the same `src/*` target (`state` vs `state-store`), preserving deterministic one-plan-per-file output.
- Quality emitter deduplicates exports by lifted source (`chunkId + sourceIdentifier`) and keeps the highest-quality alias only.
  Verified reason: reduced alias noise in generated module export surfaces without reducing lifted coverage.
- Topic splitting now uses chunk-hint buckets before budget split when a topic is too dense.
  Verified reason: reduces random mixed-domain buckets and keeps giant store/service topics more coherent before emitter merge/split passes.
- Global cross-chunk import alias reuse was intentionally rolled back.
  Verified reason: this optimization caused syntax corruption in heavy lifted modules; current stable path keeps green gates (`npm install`, `typecheck`, `lint`, `build`, `dev:smoke`) green on latest snapshot.
- Heavy `store/service` readability tuning is now applied before emit:
  - chunk-index inline is disabled for heavy selections (statement/import-local thresholds) and falls back to direct chunk imports,
  - service/store topics can split up to 5 parts (`maxPartsForArchetype`) to avoid giant 2-5MB single files,
  - domain alias rename pass drops alphabet-run/weak tokens (`run`, `impl`, etc.) to prevent names like `*Abcdefghijklmnopqrstuvwxyz*`.
  Verified reason: reduced top service/store module sizes from multi-megabyte outliers and removed noisy fallback naming while keeping green gates and zero proxy-in-quality.
- AST-lift hot-chunk prioritization now explicitly boosts `store` ownership and expands lift window (`hotChunkMax 120`, target coverage `0.985`, min hot chunks `56`).
  Verified reason: keeps quality emit anchored to lifted declarations for service/store-heavy snapshots without reopening generic-path noise.
- Chunk-index import shaping is now namespace-based in quality modules (`import * as ...Chunk`) with generated local alias lines (`const serviceX = chunk["aA"]`).
  Verified reason: removes obfuscated `aA as ...` style from import clauses and centralizes low-level symbol keys in one shaping block while preserving module behavior and green gates.
- Targeted full-lift for noisy chunk-index imports is enabled with strict guardrails (max statements/imports/chars, payload/bootstrap deny checks, collision checks).
  Verified reason: allows selective inlining of useful chunk-index declarations into quality modules to shrink import-shaping noise incrementally without reintroducing giant module bloat or breaking green gates.
- Quality emitter now enforces logic-first density:
  - module split pressure reduced (fewer tiny part files),
  - targeted chunk-index inline limits raised for fuller declaration lift,
  - fallback to import-only behavior only for extreme service/store chunk selections,
  - fail-fast if a quality module would emit with zero lifted declaration blocks.
  Verified reason: keep `src/*` centered on lifted logic instead of proxy-style glue and reduce noisy file proliferation.
- Ownership resolver now normalizes domain kind for payload-heavy symbols (`service/store/usecase -> ui`) using symbol/chunk token hints (themes/grammars/diagram/monaco/language bundles).
  Verified reason: prevent large UI/payload registries from polluting `services/store` modules and push them to renderer/ui ownership before template emission.
- Chunk-index declaration inline is now archetype-gated in quality emit (`ui/hook/transport` only).
  Verified reason: prevents `service/store` modules from inlining Vite/bootstrap registries (`__vite__mapDeps`, `modulepreload`) that massively bloat readability.
- Chunk alias naming now prioritizes symbol/module/chunk domain tokens before plan-wide flow tokens and injects stable identifier tags for weak/obfuscated stems.
  Verified reason: reduces repetitive `storeAgentSettingsNN`-style suffix chains in heavy `store/service` outputs while keeping deterministic naming and green gates.
- Identifier collision suffixes in quality emitter now use deterministic alphabetic tags (hash-derived) instead of numeric increments.
  Verified reason: significantly cuts `...Node2/3/...` growth in heavy modules and keeps naming deterministic across runs.
- Domain export canonicalizer is now a separate quality-emitter layer for `store/service` modules.
  Verified reason: rewrites weak export tails (`storeStateStateNN`, `...EventD5`-style suffix exports) into domain-based `*State/*Service` names before final export emission while preserving green/quality gates.
- Export canonicalizer now applies semantic collision disambiguation from local/source identifiers (`...LState`, `...SState`) before hash fallback.
  Verified reason: avoids opaque collision suffixes and keeps grouped store/service exports human-readable under heavy symbol density.
- Hot-module local canonicalizer now also renames inline lifted declarations/references (not only export aliases) for `store-state-g002.ts` and `service-run.ts`.
  Verified reason: removed `...EventD5/StateNN/NodeNN` identifier noise inside heavy store/service function bodies while keeping quality and green gates green.
- Hot-module alias cleanup now runs a safe import-shaping canonicalizer plus domain local rerank (`call-graph/state` seeded) for `store-state-g002.ts` and `service-run.ts`.
  Verified reason: removed `...EventRef*` and `storeAgentSettings*` naming series from shaped imports/locals without touching risky inline AST transforms; run `targeted-alias-domain-pass-v3` stayed green (`quality-gates` + `green-gates` passed).
- Hot-module import-family canonicalizer is now explicit for `store/service` hot modules:
  - `core` (`chunk-index/chunk-chunk`),
  - `channel`,
  - `language` (lang/theme bundles),
  - `diagram`,
  - `runtime`.
  Verified reason: compressed `storeNavigatePageDep*`/`svcNavigatePageDep*` noise into stable readable families (`storeCoreDep*`, `svcLanguageDep*`, etc.) while keeping deterministic aliases.
- Targeted full-lift is now enabled for `store-state-g002.ts` and `service-run.ts` with module-scoped higher inline budgets; `service-run` uses safe full-lift mode (skip function-declaration inline candidates that cause `no-func-assign`).
  Verified reason: raised lifted declaration density in hot modules without breaking green gates; run `targeted-family-full-lift-v3` is fully green.
- Hot-module alias entropy stabilizer now canonicalizes noisy import/local tails in `store-state-g002.ts` and `service-run.ts`:
  - strips alphabet-run / navigate-node noise,
  - collapses `DepDep*` chains,
  - replaces obfuscated `Dep*` tails with deterministic short tags.
  Verified reason: removed `DepDepono`/`...EventNavigate...` style tails from quality output while keeping `quality-gates` and `green-gates` green (run `targeted-local-rename-v2`).

## Next Steps
- Continue improving symbol ownership and import shaping for top noisy modules.
- Improve cluster/topic naming so generated module names are more domain-specific.
- Keep regression suite green for all four fixed profiles.
- Hot store safe-pass now includes a final module-content canonicalizer for noisy lifted identifiers (`EventFlowNode`, `AbnormalExit`, `NneTne`) after declaration assembly.
  Verified reason: deterministic whole-file identifier replacement on declaration tokens reduced these series to zero in `src/services/store/store-state-g002.ts` while keeping `quality-gates` and `green-gates` green (run `targeted-store-local-safe-v7`, `--no-stage-cache`).
- Hot store safe-pass now includes a residual local-noise sweep for `storeIae...LocalXX` / `serviceIae...LocalXX` series on final content.
  Verified reason: deterministic post-pass closed remaining gaps after declaration-level rename and reduced these series to zero in `output/regression-latest/project/src` on run `targeted-store-local-safe-v9`.
- Hot store local canonicalizer now treats synthetic alias stems (`SaeSie`, two-syllable obfuscated stems like `AoeRue`) as noise and normalizes them to stable family names.
  Verified reason: `storeSaeSieLocal*` and follow-up synthetic stem series were removed from `src/services/store/store-state-g002.ts` via targeted runs (`targeted-store-saesie-v11`, `targeted-store-synthetic-v12`) while keeping quality/dev gates green and generic-path noise at zero.
- Hot store top-level `*Qe*` alias names are now included in the same safe canonicalizer (`eQe...`, `aQe...`, etc.).
  Verified reason: obfuscated function-name tail series dropped to zero in `src/services/store/store-state-g002.ts` on run `targeted-store-qe-v13`, preserving deterministic output and green quality/dev gates.
- Hot store canonicalizer now has contextual core-family routing (`React`, `Runtime`, `Preload`, `State`, `Language`, `Diagram`) for `storeCoreLocal*` series.
  Verified reason: large undifferentiated `storeCoreLocal*` pool is now partitioned by declaration context in `src/services/store/store-state-g002.ts` (run `targeted-store-core-family-v14`) while keeping deterministic output and zero regression on quality/dev gates.
