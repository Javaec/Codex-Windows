# AGENTS Notes

## Purpose

- Keep the sidebar limits panel small and stable across obfuscated Codex builds.

## Current Decisions

- This mod now depends on `shared/codex-mod-loader/api/renderer-api.js`.
- Declared renderer capabilities:
  - `renderer-ready`
  - `route-change`
  - `sidebar-root`
  - `sidebar-panel`
  - `settings-panel`
  - `bridge-fetch`
  - `dom-observer`
  - `schedule-refresh`
- One source of truth: live `/wham/usage` responses over the Electron fetch bridge.
- The panel shows remaining percentage, matching Settings (`x% left`), not raw `used_percent`.
- Do not parse Settings page text at all; text scraping caused drift and mirrored values.
- Prefer the general root limit entry (`limitName == null`) and then choose the closest 5h/weekly buckets from the same payload shape the Settings hook uses.
- Ignore Spark-specific rows unless there is no general limit entry.
- Panel placement is sidebar-first:
  - choose the best visible sidebar container,
  - place above Settings only if a Settings anchor exists inside that sidebar,
  - otherwise prepend inside the sidebar,
  - use floating fallback only when no visible sidebar exists.

## Why

- Shared bridge/sidebar helpers cut duplicated DOM and fetch wiring out of the mod itself.
- Root `/wham/usage` data survives route changes and updates without needing Settings to be open.
- The root limit entry is not the same as `rate_limit_name`; treating it as a model-specific row produced wrong or missing sidebar values.
- Sidebar-first anchoring survives DOM churn better than searching the whole page for one exact Settings node.
- Shared hooks now own panel placement and refresh cadence:
  - `injectSidebarPanel`
  - `observeSettingsPanel`
  - `scheduleRefresh`
