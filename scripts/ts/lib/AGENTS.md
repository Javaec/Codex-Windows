# Runner Lib AGENTS

## 2026-03-05
- Added new patch step `webview-settings-limits` in patch pipeline.
- Implemented `patchWebviewSettingsLimitsPanel()` in `launch.ts`:
  - injects sidebar limits panel above `Settings`,
  - idempotent via patch tag `CODEX-WINDOWS-SETTINGS-LIMIT-PANEL-V1`.
- Design choice:
  - runtime DOM injection instead of deep JSX/AST mutation in obfuscated bundles for better version resilience.
