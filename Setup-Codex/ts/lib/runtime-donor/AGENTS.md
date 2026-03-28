# Runtime Donor Notes

- This folder owns Windows runtime donor discovery and native artifact reuse.
- Prefer official Windows Codex installs (`WindowsApps`) and known local installs as donor sources before any rebuild path.
- `windows-apps.ts` now also provides donor-first runtime tool discovery (`codex.exe`, `rg.exe`, companion executables).
- `windows-apps.ts` also exposes the donor `better-sqlite3` package path for read-only audit/reporting.
- Host-side audits still need a host-compatible native binding; donor package layout is the logic source, not a promise of ABI compatibility with the current Node runtime.
- On Windows, direct enumeration of `C:\\Program Files\\WindowsApps` is not reliable (`EPERM` / access denied). Use `Get-AppxPackage OpenAI.Codex*` as the single discovery source and derive `app\\resources` from `InstallLocation`.
- `windows-runtime-donor` CLI paths are copy-only sources for packaging. Do not require direct `--version` execution from the WindowsApps install location; the bundled copy is the executable contract.
- Keep donor logic separate from source-bundle extraction and portable packaging.
