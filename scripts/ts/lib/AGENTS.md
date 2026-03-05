# Runner Lib AGENTS

## 2026-03-05
- Added new patch step `webview-settings-limits` in patch pipeline.
- Implemented `patchWebviewSettingsLimitsPanel()` in `launch.ts`:
  - injects sidebar limits panel above `Settings`,
  - idempotent via patch tag `CODEX-WINDOWS-SETTINGS-LIMIT-PANEL-V1`.
- Design choice:
  - runtime DOM injection instead of deep JSX/AST mutation in obfuscated bundles for better version resilience.
- Upgraded injector to `CODEX-WINDOWS-SETTINGS-LIMIT-PANEL-V2`:
  - captures candidate limits from network JSON (`fetch` + `XMLHttpRequest`),
  - classifies 5h/weekly windows heuristically (`window_seconds`/labels),
  - caches latest snapshot in local storage and re-renders panel on DOM churn.
- Upgraded injector to `CODEX-WINDOWS-SETTINGS-LIMIT-PANEL-V3`:
  - moved script body to `shared/patch-pack/injections/webview-settings-limits-panel.v3.js` (single source),
  - loader in `launch.ts` reads injector from file and fails fast if missing/empty,
  - V3 additionally parses `window.message` payloads and Settings DOM rows (`5h`/`7d`) for IPC-first builds.
- Legacy handling:
  - V2/V1 injected blocks are replaced in-place when patching reused app payloads.

## 2026-03-05 (V6 limits panel stabilization)
- Upgraded limits injector tag to `CODEX-WINDOWS-SETTINGS-LIMIT-PANEL-V6`.
- Removed `fetch`/`XMLHttpRequest` interception from limits panel injector.
- Limits source now reuses renderer settings data flow:
  - consumes `window.message` bridge payloads and extracts `rate_limit.primary_window/secondary_window`,
  - parses Settings DOM rows on Settings click burst.
- Rationale:
  - new app builds expose limits through bridge/state instead of direct renderer network requests,
  - lighter runtime hook reduces UI freeze risk and keeps patch deterministic.
- Follow-up: bumped patch tag to `CODEX-WINDOWS-SETTINGS-LIMIT-PANEL-V7` so `-Reuse` forces reinjection after V6 script changes.
- Follow-up: bumped patch tag to `CODEX-WINDOWS-SETTINGS-LIMIT-PANEL-V8`:
  - Settings parser now also scans full Settings page text near `5 hour` / `weekly` labels,
  - message interceptor accepts JSON string payloads in `window.message` events,
  - parser depth for payload hints increased for nested bridge payloads.
- Follow-up: bumped patch tag to `CODEX-WINDOWS-SETTINGS-LIMIT-PANEL-V9`:
  - tie-breaker now prefers fresher/higher-pressure entries (higher `used_percent`) instead of keeping old equal-score snapshots,
  - Settings text parser now scans all label occurrences (general + spark blocks) and picks the strongest usage entry,
  - bridge message handler now always attempts payload parse (no strict hint gate).
- Follow-up: bumped patch tag to `CODEX-WINDOWS-SETTINGS-LIMIT-PANEL-V10`:
  - settings-derived values are now authoritative and cannot be overwritten by bridge fallback,
  - panel display aligns with Settings (`% left`),
  - DOM row filter narrowed to explicit usage-limit rows to avoid unrelated 100% payload noise.
- Follow-up: bumped patch tag to `CODEX-WINDOWS-SETTINGS-LIMIT-PANEL-V11`:
  - text fallback now fills only missing windows (prevents five-hour/weekly duplication),
  - panel mount now has persistent fallback targets (sidebar, then floating) so it stays visible without opening Settings,
  - periodic refresh added (`45s`) for steady re-mount/re-render.
- Follow-up: bumped patch tag to `CODEX-WINDOWS-SETTINGS-LIMIT-PANEL-V12`:
  - removed `Usage limits` title and made the output compact: `5h X% | wk Y%`,
  - Settings DOM parser skips the injected panel subtree to avoid self-parsing loops,
  - ignores mirrored Settings snapshots when they would overwrite already-distinct windows (prevents 100% -> 0% flapping).
