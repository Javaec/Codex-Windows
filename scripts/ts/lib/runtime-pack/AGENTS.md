# Runtime Pack Notes

- This folder owns creation of portable Windows artifacts and launchers.
- This folder also owns optional SFX/single-file packaging.
- This folder owns direct launch helpers too; launching unpacked app/runtime is packaging/runtime behavior, not patch behavior.
- `direct-launch.ts` owns actual process start logic for unpacked app and portable app.
- `runtime-compare.ts` owns lane compare scripts; `launchers.ts` should only emit launcher files.
- `codex-resources.ts` owns bundling of CLI/runtime companion files.
- `resources/mod-api` is part of the portable runtime contract; launchers and direct-launch must always point `CODEX_MOD_API_DIR` at it.
- `codex-resources.ts` must copy only the small runtime allowlist (`codex.exe`, companion executables, `rg.exe`, `notification.wav`), not entire donor `resources` folders.
- `launchers.ts` owns launcher generation only.
- Portable outputs must be self-contained: bundled `resources/codex.exe`, bundled `resources/mods`, isolated `userdata/cache`.
- Portable launcher lanes now include:
  - stable `no-mods`
  - explicit `with-mods`
  - diagnostic `minimal`
  - diagnostic `isolated-home`
  - `only-<mod>` bisect launchers
- `minimal` means runtime mods disabled and shim reduced via `CODEX_WINDOWS_MINIMAL=1`.
- `isolated-home` means runtime mods disabled and `CODEX_HOME` redirected into the portable artifact, so lane results are not polluted by global `C:\\Users\\lensm\\.codex`.
- Every launcher lane writes its own runtime log bundle under `runtime-logs/<lane>/`:
  - `stdout-latest.log`
  - `chromium.log`
  - `launch.env.txt`
- Portable outputs also include:
  - `Compare-Runtime-Lanes.ps1`
  - `Compare-Runtime-Lanes.cmd`
  which summarize lane differences into `runtime-logs/lane-summary.txt`.
- `dist` is canonical; temporary fallback outputs belong under `work/portable-output`.
