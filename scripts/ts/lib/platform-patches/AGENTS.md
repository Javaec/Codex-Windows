# Platform Patches Notes

- This folder owns only platform-critical patch selection and execution.
- `bundle-patches.ts` is the source of truth for preload/webview/main-bundle patching.
- Keep feature behavior out of patch steps; feature tweaks belong in the runtime mod loader.
- Default profiles should stay minimal: preload bridge, sunset bypass, runtime shim bootstrap.
- Build/profile hint logic must come from `C:\\Codex-Windows\\shared\\version-identity\\*`, not from local hardcoded version tables.
- `patch-pipeline-report.json` should include current-build runtime mod compatibility summary so repack diagnostics show:
  - selected compatible mods
  - load order
  - incompatible mods
  - recommended disabled mods
