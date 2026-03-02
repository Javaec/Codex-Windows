# Manual Sync Contracts

This directory is the stable bridge between:
- generated project output (`output/*/project`), and
- manual-first refactoring project.

## Files

1. `symbol-name-overrides.json`
- Per-symbol authoritative rename decisions.
- Applied in `naming-memory` stage before naming memory update.

2. `module-path-overrides.json`
- Per-symbol authoritative module placement decisions.
- Applied in `template-emitter` during module planning.

3. `module-surface-overrides.json`
- Per-module export surface and owner layer decisions from manual project.
- Exported by `manual-sync:export` and validated before generator run.

4. `last-export-report.json`
- Last export run diagnostics and counts.
- Produced by `npm run manual-sync:export`.

5. `contract-changelog.md`
- Append-only auto-log for contract mutations (`actor/when/why`).

## Contract Law

- Contract fields are strict:
  - top-level: `contractVersion=2`, `migrationVersion=1`.
- every override requires: `symbolKey`, `preferredName/filePath`, `confidence`, `provenance`, `updatedAtIso`.
- module-surface requires: `moduleFilePath`, `ownerLayer`, `exportSurface`, `symbolKeys`, `confidence`, `provenance`, `updatedAtIso`.
- Loader is fail-fast on malformed entries.
- Migration is explicit, never implicit.

## Export Flow

1. Ensure generated project contains:
- `runtime/manual-sync-index.json`

2. Run export:
```powershell
npm run manual-sync:export -- --manual-project "C:\path\to\manual-project"
```

3. Validate contracts:
```powershell
npm run manual-sync:validate
```

Round-trip guard (fails on quality degradation):
```powershell
npm run manual-sync:roundtrip -- --snapshot "C:\path\to\app.asar" --manual-project "C:\path\to\manual-project"
```

If contracts are still old (pre-v2), run:
```powershell
npm run manual-sync:migrate
```

4. Review and commit changes in:
- `shared/manual-sync/symbol-name-overrides.json`
- `shared/manual-sync/module-path-overrides.json`
- `shared/manual-sync/module-surface-overrides.json`
- `shared/manual-sync/last-export-report.json`
- `shared/manual-sync/contract-changelog.md`

5. Re-run generator with manual sync enabled to apply overrides.

Detailed full workflow:
- `docs/manual-sync-workflow.md`

## Safety

- Invalid override entries are rejected/fail-fast during load.
- Generator does not silently ignore malformed contract data.
