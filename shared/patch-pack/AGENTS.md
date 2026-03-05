# Patch Pack AGENTS

## Purpose
Single source of truth for patch profiles across repacker, generator, and manual project.

## Scope
- patch step catalog
- stage registry (`extract -> deobf -> mods -> runtime-pack`)
- version selectors
- profile plans with required/optional steps
- mod manifests (`mods/*.json`) with deterministic ordering and conflict rules

## Rules
- No duplicated profile definitions inside app-specific code.
- Profile selection must be deterministic: forced override > selector rules > default profile.
- Mod execution order must be deterministic: `stage` rank -> `priority` -> `id`.
- Any conflict in selected mods must fail fast.
- Additive profile evolution only; no implicit fallback chains.
- Mod manifests must declare explicit injector contracts (`stageId`, `inputContract`, `outputContract`) that exactly match stage-registry.

## 2026-03-04 Decisions
- Added `preflight.mjs` as a single fail-fast validator for the shared patch-pack.
- Preflight validates:
  - selector + catalog schema,
  - all profile files and mod manifests,
  - duplicate mods and step-id integrity,
  - mod conflict graph per profile,
  - compatibility of selected profile for provided snapshot/build/app-version input.
- This is now the required first check before version migration work (`106x -> 10711+`).
- Added test fixture profile `profiles/test-mod-conflict.json` with intentionally conflicting sunset mods.
- Added conflict assertion command `test-mod-conflict.mjs`.
  - It expects preflight to fail with conflict diagnostics (`webview-sunset-strict` x `webview-sunset-optional`).
  - Test fixture profiles are excluded from normal preflight unless `--include-test-profiles` is passed.
- Added `stage-registry.json` as the only source of stage ordering and IO contracts:
  - required stages: `extract`, `deobf`, `mods`, `runtime-pack`,
  - injector mods are allowed only on `mods` stage by policy,
  - all mod manifests now use `lane + injector` instead of legacy free-form stage ranking.

## 2026-03-05 Decisions
- Added sidebar UI mod `webview-settings-limits-panel`:
  - new patch step id: `webview-settings-limits`,
  - injects a small limits card above `Settings` using DOM observer runtime injection,
  - enabled in `codex-106x`, `codex-10711`, and `generic` profiles.
- Rationale:
  - avoid brittle AST patch points in obfuscated renderer bundles,
  - keep mod resilient across snapshot obfuscation drift.
- Upgraded limits panel injector to V2:
  - patch tag: `CODEX-WINDOWS-SETTINGS-LIMIT-PANEL-V2`,
  - panel values are runtime-updated from intercepted `fetch`/`XMLHttpRequest` JSON payloads,
  - values are cached in `localStorage` (`codex-windows-limits-panel-cache-v1`) and restored on reload.
- Upgraded limits panel injector to V3 and moved code to one file source:
  - patch tag: `CODEX-WINDOWS-SETTINGS-LIMIT-PANEL-V3`,
  - injector source path: `shared/patch-pack/injections/webview-settings-limits-panel.v3.js`,
  - runner loads injector from file (no giant inline string in launch pipeline).
- V3 data sources for panel values:
  - `fetch` / `XMLHttpRequest` payload scan,
  - `window.message` payload scan,
  - direct Settings DOM scan (`5h` / `7d` rows) as fallback for IPC-only flows.
- V3 patch upgrades legacy V2/V1 injected blocks in-place on `-Reuse`.
- Upgraded limits panel injector to V6:
  - patch tag: `CODEX-WINDOWS-SETTINGS-LIMIT-PANEL-V6`,
  - primary source switched to renderer bridge messages (`window.message`) + Settings DOM burst,
  - removed network interception hooks from injector to reduce runtime side-effects on 10711 builds.
- Follow-up patch tag bump: `CODEX-WINDOWS-SETTINGS-LIMIT-PANEL-V7` to force reinjection on reused bundles after V6 script updates.
- V7 keeps in-place upgrade path for legacy tags V1..V6 on reused app bundles.
- Follow-up patch tag bump: `CODEX-WINDOWS-SETTINGS-LIMIT-PANEL-V8`:
  - adds Settings page text-near-label parser (`5 hour` / `weekly`) as deterministic fallback,
  - accepts JSON-string message payloads from bridge `window.message`,
  - increases payload hint traversal depth for nested data envelopes.
- Follow-up patch tag bump: `CODEX-WINDOWS-SETTINGS-LIMIT-PANEL-V9`:
  - tie-break now prefers fresher/higher usage snapshots when scores are equal,
  - parser scans all Settings label occurrences and handles duplicated sections (`general` / `spark`),
  - bridge payload parse runs unconditionally for object/JSON-string messages.
- Follow-up patch tag bump: `CODEX-WINDOWS-SETTINGS-LIMIT-PANEL-V10`:
  - settings DOM values became authoritative for panel state,
  - bridge payload path remains fallback-only and cannot overwrite settings snapshots,
  - panel output normalized to `% left` to match Usage Settings semantics.
- Follow-up patch tag bump: `CODEX-WINDOWS-SETTINGS-LIMIT-PANEL-V11`:
  - text fallback only patches missing windows (avoids 5h/weekly mirroring),
  - persistent mount fallback added (sidebar, then floating) to keep panel always visible,
  - periodic 45-second refresh added for continuous panel presence/update.
- Follow-up patch tag bump: `CODEX-WINDOWS-SETTINGS-LIMIT-PANEL-V12`:
  - compact summary line output: `5h X% | wk Y%` (no header),
  - Settings DOM scan excludes the injected panel (prevents self-reading),
  - drops mirrored snapshots that would overwrite already-distinct windows (reduces flapping).

## 2026-03-05: Thread List Default Limit (10 -> 6)

- Added webview patch step `webview-thread-per-project-cap`:
  - patch tag: `CODEX-WINDOWS-THREADS-PER-PROJECT-CAP-V2`,
  - rewrites outgoing `thread/list` requests with `limit=10` to `limit=6`,
  - keeps existing Show more/Show less behavior intact (only changes the default collapsed limit).

## 2026-03-05 Updates: Limits + Threads Cap + CLI 0.110.0 History

- Limits panel injector is now V15 (`CODEX-WINDOWS-SETTINGS-LIMIT-PANEL-V15`):
  - mounts as a sibling directly above the real sidebar Settings row when possible,
  - compact single-line output (`5h X% | wk Y%`),
  - avoids flapping by refusing to overwrite known values with unknown/partial snapshots,
  - fixes percent derivation (`remaining` is treated as count only when `limit` exists; generic `%` parsing removed),
  - refreshes mount/render on a 30s timer to keep the panel visible without navigating to Settings.
- Thread list cap patch is now V8 (`CODEX-WINDOWS-THREADS-PER-PROJECT-CAP-V8`):
  - primary strategy: rewrite the renderer-side `maxItems:<id>` constant (`const <id>=10` -> `6`) so the default collapsed view shows 6,
  - legacy fallback: keep older request-level limit rewriting for builds that do not expose `maxItems` caps,
  - no renderer monkeypatching of `electronBridge` (it can be frozen/read-only on newer builds).
- Added webview patch step `webview-persist-extended-history` (`CODEX-WINDOWS-WEBVIEW-PERSIST-EXTENDED-HISTORY-V1`):
  - forces `persistExtendedHistory=true` in the webview config,
  - fixes missing legacy conversations after upgrading Codex CLI to `0.110.0` (older rollouts remain on disk under `.codex/sessions` / `.codex/archived_sessions`).
