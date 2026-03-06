# Runner Orchestration Notes

- This folder owns top-level runner orchestration only.
- `context.ts` holds runner-global environment policy and repo-root resolution.
- `verify.ts` is the short operator preflight.
- `pipeline.ts` is the full run/build orchestration path.
- `smoke.ts` is the reusable launchability/usability smoke entrypoint; it must call domain helpers instead of duplicating the pipeline.
- `shared-home-audit.ts` is the read-only contention audit for the real `C:\\Users\\<user>\\.codex`; it must never mutate that directory.
- `smoke.ts` may fail on shared-home lanes because of real user-state contention; do not add repair/cleanup behavior there.
- `shared-home-audit.ts` may surface an explicit SQLite adapter error if host-compatible native bindings are unavailable. That is an audit finding, not a reason to mutate `.codex`.
- Keep business logic in domain folders (`source-bundle`, `runtime-donor`, `runtime-pack`, `platform-patches`) and keep this folder thin.
