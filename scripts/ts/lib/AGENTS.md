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
