# Scripts AGENTS

## Purpose
Keep Windows runner tooling deterministic, debuggable, and easy to automate.

## Goals
- Preserve stable `run/build` behavior.
- Add standalone utilities without coupling them into launch path.
- Prefer repeatable outputs (JSON/Markdown artifacts) over ad-hoc logs.

## Why
Scripts are the single operational entrypoint for packaging, patching, and diagnostics.

## Constraints
- Do not change existing run/build behavior unless explicitly requested.
- Keep Node/TypeScript tooling dependency-light.
- Use explicit hard failures instead of silent fallbacks.

## Integration Points
- `scripts/ts/run.ts` -> main pipeline.
- `scripts/ts/lib/*` -> shared helpers.
- `scripts/node/*` -> compiled runtime artifacts.

## Current Decisions
- Reverse-engineering tooling is implemented as a separate CLI (`reverse.ts`) and not mixed into launch/build pipeline.

## Next Steps
- Add focused analyzers for React component boundaries and route ownership when source maps become available.
