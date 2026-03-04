# Naming AGENTS

## Purpose
Keep naming-memory artifacts compact and deterministic.

## Rules
- Naming-memory files are hard-limited to 100MB.
- `compact.ts` is the single compaction implementation.
- Compaction keeps only minimal evidence and short accepted history.
- Oversized files must fail fast instead of fallback behavior.

## Commands
- `npm run naming-memory:compact`
  - compacts `naming-memory.json` and snapshot files,
  - optional `--include-runs` also compacts run snapshots.
