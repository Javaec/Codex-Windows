# Runner Lib AGENTS

## 2026-03-05: Forge-like split (platform patches vs feature mods)

- Platform patches stay in patch-pack (build/repack time):
  - preload bridge
  - webview sunset bypass
  - webview cwd normalization (optional by profile)
  - main Windows runtime shim (env + SQLite path normalization + open-path fix)

- Feature UI tweaks moved out of obfuscated webview bundle patching:
  - runtime modpack under `C:\\Codex-Windows\\shared\\codex-mod-loader\\mods\\*`
  - portable builds bundle it into `resources\\mods\\*`
  - injected by the main runtime shim on `dom-ready` via `webContents.executeJavaScript`
  - must be DOM-only and must not mutate `window.electronBridge` (it can be frozen/read-only)

## 2026-03-05: Launcher sanitizer must include global Codex state

- `sanitizeWorkspaceRegistry(...)` must scan not only run-local `userdata`, but also:
  - `%APPDATA%\\Codex`
  - `CODEX_HOME` / `%USERPROFILE%\\.codex`
- `.codex-global-state.json` is an explicit candidate, even if it does not match generic filename heuristics.
- Reason:
  - stale workspace/worktree references that cause `git-origin-and-roots` noise live in global state, not only in portable launch state.

## 2026-03-05: Native donor/seed discovery must ignore workdir depth

- Native recovery must not derive repo root from `path.dirname(workDir)` only.
- Version-isolated runs like `work/11012-test` must still discover donors from the real repo root:
  - `C:\\Codex-Windows\\dist\\*\\resources\\app`
  - `C:\\Codex-Windows\\scripts\\native-seeds\\<arch>\\app`
- Implementation rule:
  - collect repo-root candidates from `process.cwd()`, script location, and upward walk from `workDir`;
  - then scan donors/seeds from those roots.
- Reason:
  - otherwise patching succeeds for new versions, but native stage fails falsely with
    `No usable native artifacts found...` only because discovery looked under `work\\dist` instead of repo `dist`.

## 2026-03-05: Preload patch must survive comma-operator bundles

- New preload bundles can chain top-level side effects with comma operators:
  - `ipcRenderer.on(...),contextBridge.exposeInMainWorld(...)`
- Injected process bridge must therefore be prefixed with an explicit statement break:
  - consume the leading comma before the anchor and replace it with a statement boundary
  - result shape:
    - `...);const __codexWindowsProcessBridge=...;contextBridge.exposeInMainWorld(...)`
- Reason:
  - plain insertion before the anchor generates invalid syntax (`...,const ...` or `...),;const ...`) and portable builds fail at runtime with:
    - `Unable to load preload script`
    - `SyntaxError: Unexpected token 'const'`

## 2026-03-05: Expected-recovery paths must log as info, not warnings

- Tolerated recovery paths are not regressions and must not pollute the warning channel:
  - optional patch skips for unknown obfuscation signatures,
  - `7z` exit codes when required payload files are already present,
  - native cache misses followed by donor/seed recovery.
- Keep warnings only for real blockers or for validations that still fail at the end of the stage.

## 2026-03-06: Main shim must fail fast on escaped renderer wrapper

- `shared/patch-pack/runtime/codex-windows-main-shim.template.cjs` is the source of truth for renderer mod injection.
- The renderer wrapper must contain real line breaks:
  - good: ``const wrapped = `/* CODEX-MOD:${mod.id} */\n${mod.script}\n`;`` as actual multiline source
  - bad: ``const wrapped = `/* CODEX-MOD:${mod.id} */\\n${mod.script}\\n`;``
- The bad form causes every renderer mod to fail with:
  - `SyntaxError: Invalid or unexpected token`
  - black screen / missing UI content
- `scripts/ts/lib/platform-patches/bundle-patches.ts` must validate this contract before writing `codex-windows-main-shim.cjs`.

## 2026-03-06: Ripgrep bootstrap is PATH-or-repo-local only

- `scripts/ts/lib/env.ts` must not mutate the user PATH and must not call `winget` for ripgrep.
- `scripts/ts/lib/source-bundle/extract.ts` must not call `winget` for 7-Zip either.
- Allowed sources for `rg`:
  - already available in current process PATH
  - official Windows Codex runtime donor (`WindowsApps`) via `rg.exe`
  - repo-local portable cache under `work/tools/ripgrep`
- No network download of ripgrep archives during verify/build.
- If `rg.exe` resolves from `WindowsApps\\OpenAI.Codex_*`, classify it as `windows-runtime-donor`, not plain `path`, so donor/runtime coupling stays visible in logs.
- Allowed sources for `7z`:
  - already available in current process PATH
  - standard installed path under `Program Files/7-Zip`
  - repo-local portable cache under `work/tools/7zip`
- Reason:
  - PATH persistence and package-manager side effects make the runner less deterministic than the app it builds.

## 2026-03-06: Verify mode is the short preflight, not a second pipeline

- `node scripts/node/run.js verify ...` is the compact fail-fast operator check.
- It must validate only:
  - environment contract
  - ripgrep availability
  - DMG resolution
  - patch profile selection + patch-pack preflight
  - CLI resolution
  - native donor/seed availability
- It must not extract DMG or execute the full repack pipeline.

## 2026-03-06: Runner must ignore ambient CODEX_* state

- The runner must delete inherited runtime variables before verify/build:
  - `CODEX_CLI_PATH`
  - `CODEX_MODS_DIR`
  - `CODEX_MOD_API_DIR`
  - `CODEX_WINDOWS_PROFILE`
  - `CODEX_GIT_CAPABILITY_CACHE`
  - `CODEX_BUILD_NUMBER`
  - `CODEX_BUILD_FLAVOR`
  - `BUILD_FLAVOR`
  - `ELECTRON_RENDERER_URL`
  - `ELECTRON_FORCE_IS_PACKAGED`
- Reason:
  - build/repack must not depend on stale shell state from an older portable build.
  - this was a concrete source of nondeterministic gray-screen builds.

## 2026-03-06: CLI resolution must not silently prefer repo-global stale dist artifacts

- `resolvePreferredCodexCliPath(...)` should only honor an explicit CLI path.
- The runner must not look inside the target output directory for its CLI source.
- The runner must not silently read `C:\\Codex-Windows\\dist\\...` from a previous build.
- If no explicit path is provided, the normal resolver must decide (npm vendor / `where`), not a stale packaged artifact.

## 2026-03-06: Portable build must bundle CLI, never fall back to PATH

- The portable packager must throw if it cannot copy a valid `codex.exe` source into `resources\\codex.exe`.
- `Launch-Codex.cmd` must fail fast if bundled:
  - `resources\\codex.exe`
  - `resources\\mods`
  are missing.
- Reason:
  - a portable app that depends on ambient PATH is not a real portable build and is a direct source of gray-screen regressions.

## 2026-03-06: dist must expose one canonical latest launcher

- Default portable builds must refresh `dist\\Launch-Codex-latest.cmd`.
- Default portable builds must also refresh `dist\\Launch-Codex-latest-no-mods.cmd`.
- That launcher must delegate to the canonical latest output:
  - `dist\\Codex-win32-x64\\Launch-Codex.cmd`
  - and the no-mods lane must delegate to:
    - `dist\\Codex-win32-x64\\Launch-Codex-no-mods.cmd`
  - or the active arch equivalent.
- Stale sibling outputs such as `-work` and `-next*` should be pruned after a successful default build.
- Reason:
  - multiple similarly named portable outputs caused repeated launches of the wrong artifact.
  - UI regressions now need an immediate A/B lane: with mods and without mods.

## 2026-03-06: Portable build writes build-metadata.json

- Every portable output must include `build-metadata.json` in the root of the packaged directory.
- Required fields:
  - `builtAtIso`
  - `dmgPath`
  - `dmgFileName`
  - `appVersion`
  - `buildNumber`
  - `buildFlavor`
  - `profileName`
  - `patchProfileId`
  - `patchReportPath`
  - `codexCliPath`
  - `codexCliSource`
- Reason:
  - when a build regresses, we need to see exactly which DMG/profile/CLI produced it.

## 2026-03-06: Portable diagnostic launchers must isolate browser state

- Every portable build now emits:
  - `Launch-Codex-no-mods.cmd`
  - `Launch-Codex-only-<modId>.cmd`
- Each diagnostic launcher must use its own `userdata` and `cache` suffix.
- Reason:
  - mod bisecting is invalid if modded and unmodded runs reuse the same Electron browser state.

## 2026-03-06: Portable default lane must be no-mods

- `Launch-Codex.cmd` is now the stable no-mods lane.
- `dist\Launch-Codex-latest.cmd` must point to the stable no-mods lane.
- `dist\Launch-Codex-latest-with-mods.cmd` is the explicit experimental lane.
- Reason:
  - feature mods are not release-safe yet; the safe baseline must not depend on them.

## 2026-03-06: Runner lib split by responsibility, not by step order

- `source-bundle/*` owns upstream payload intake only.
- `runtime-donor/*` owns Windows donor/native reuse only.
- `runtime-pack/*` owns portable artifact assembly and launchers only.
- `platform-patches/*` owns profile selection and platform-critical patch execution only.
- `runner/*` owns top-level orchestration only (`verify` and full pipeline wiring).
- `scripts/ts/run.ts` should remain a thin dispatcher, not a second orchestration layer.
- Keep these boundaries strict; do not move feature logic back into patching or bundle extraction.

## 2026-03-06: Windows runtime donor CLI is copy-only, branding is local-only

- `windows-runtime-donor` CLI paths from `WindowsApps` are valid packaging sources even when direct execution from the install location returns `EPERM`.
- `verify` and build preflight must treat them as copy-only donors, not as in-place executables.
- `branding.ts` must not download `rcedit` from the network during build.
- Allowed branding sources:
  - explicit `CODEX_RCEDIT_PATH`
  - local PATH
  - repo-local cached `work\\tools\\rcedit\\rcedit-<arch>.exe`
- If `rcedit` is absent, branding is skipped with a warning; packaging must continue.
