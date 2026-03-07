# Version Identity AGENTS

## Purpose
- Keep app-version/build-number detection in one shared place for:
  - repacker scripts
  - patch-pack preflight
  - orchestrator migration
  - future mod compatibility reports

## Rules
- Internal package metadata is primary:
  - explicit appVersion/buildNumber
  - then nearby package.json
  - snapshot filename only as fallback
- `known-builds.json` is the single shared mapping for:
  - `appVersion -> buildHint`
  - `buildNumber -> buildHint`
  - patch-profile reporting/matrix targets
- Mod compatibility matrix generation also consumes this file; do not fork build lists between patch-pack and mod loader.
- Do not reintroduce separate hardcoded version hint tables in scripts or orchestrator code.
