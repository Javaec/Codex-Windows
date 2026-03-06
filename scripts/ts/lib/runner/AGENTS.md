# Runner Orchestration Notes

- This folder owns top-level runner orchestration only.
- `context.ts` holds runner-global environment policy and repo-root resolution.
- `verify.ts` is the short operator preflight.
- `pipeline.ts` is the full run/build orchestration path.
- Keep business logic in domain folders (`source-bundle`, `runtime-donor`, `runtime-pack`, `platform-patches`) and keep this folder thin.
