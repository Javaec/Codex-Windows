# Codex Provider Sync

Standalone Windows utility for retagging Codex sessions when switching between the official provider and a custom provider.

Codex stores the provider in two places:

- `sessions/**/rollout-*.jsonl` and `archived_sessions/rollout-*.jsonl`, inside every `session_meta` record;
- `state_5.sqlite`, in the `threads.model_provider` column.

Both surfaces must be updated or the session can disappear from the history/resume list. Newer Codex versions also index paginated history in `thread_history_1.sqlite`. Rewriting a rollout changes byte offsets, so the utility backs up the selected thread's index and removes its local projection. Codex rebuilds that projection on `thread/resume`; opening paginated history through read-only listing calls alone does not rebuild it. History before `session_meta.history_base` is retained because its source may no longer be in the current rollout.

During a migration, the package also repairs replay data that is tied to the old provider: it removes empty reasoning response items whose ID has no encrypted content, strips provider-specific reasoning ciphertext while preserving visible summaries, converts readable compaction text accidentally stored in `encrypted_content` into an assistant message, and removes opaque compaction ciphertext that the new provider cannot decrypt. Compaction replacement history and its per-item metadata stay aligned. The same repair is available without changing providers through `--repair-encrypted`. The package preserves account ownership fields, titles, and rollout ordinals, and does not modify `auth.json` or `config.toml`.

## Usage

Double-click `Run-Codex-Provider-Sync.cmd` for the interactive PowerShell interface. If Windows Terminal is installed, the launcher opens a new styled Windows Terminal tab. It shows provider counts, asks for source and target providers, previews the changes, and asks for confirmation before writing.

From the repository root, `Run-CodexProviderRetag.cmd` opens the same utility. The command-line entrypoint is `npm.cmd run provider-retag -- <options>` on Windows; `npm run test:provider-sync` runs its tests. No separate preparation step is needed.

The same launcher remains scriptable; when arguments are supplied it runs synchronously without opening a new tab. Preview a migration:

```text
Run-Codex-Provider-Sync.cmd --from openai --to codex --dry-run
```

Apply it after closing Codex, the Codex CLI, and app-server:

```text
Run-Codex-Provider-Sync.cmd --from openai --to codex --yes
```

On Windows, apply also checks access to each selected chat's writer lock before creating backups or changing data. A loaded chat must be unloaded before its rollout can be replaced safely.

To test or migrate one thread only:

```text
Run-Codex-Provider-Sync.cmd --session-id 01... --from openai --to codex --yes
```

To repair a known rollout without changing its provider:

```text
Run-Codex-Provider-Sync.cmd --repair-history --session-id 01... --yes
```

To scan and repair all active and archived rollouts:

```text
Run-Codex-Provider-Sync.cmd --repair-all --dry-run
Run-Codex-Provider-Sync.cmd --repair-all --yes
```

To repair provider-specific encrypted reasoning and nested compaction history:

```text
Run-Codex-Provider-Sync.cmd --repair-encrypted --session-id 01... --dry-run
Run-Codex-Provider-Sync.cmd --repair-encrypted --session-id 01... --yes
```

Omit `--session-id` to scan all active and archived rollouts. The interactive PowerShell launcher exposes this as a separate operation.

Backups are created under `<CODEX_HOME>\backups\provider-sync\<timestamp>` before every write. The state backup is a consistent SQLite snapshot, including committed WAL data. The history backup contains only the selected threads' rows, rather than a copy of the entire history database. It is a row snapshot for restoring those threads, not a replacement for the live history database. The default state database follows `sqlite_home` from `config.toml`, then root `state_5.sqlite`, then `sqlite\state_5.sqlite`. Use `--state-db` when an explicit database is required. The history database is resolved beside the selected state database.

The preview reports mixed `session_meta` files, empty-history candidates, encrypted replay candidates, and nested plaintext/opaque compaction candidates. The apply report shows how many reasoning items were sanitized, readable compactions converted, and opaque compactions removed. Every write has a backup and a post-write scan.

Rollout inspection and rewriting use bounded streaming buffers, so large histories do not need to be loaded into memory as one document. A targeted `--session-id` scan uses SQLite's current rollout path first. It leaves older immutable segments of the same chat untouched, including compressed segments. When the index does not resolve the session, it searches matching filenames and then other rollout files. `--status --session-id ID` is also scoped to one chat. For a rotated rollout, the history index is keyed by the rollout ID in its filename, which can differ from the stable chat ID.

The tool intentionally fails when selected `.jsonl.zst` rollouts are present because it cannot safely rewrite compressed rollouts without a zstd runtime. Unrelated compressed rollouts do not block a targeted migration. No partial write is started in that case.

Cross-provider continuation can still fail when the backend cannot decrypt provider-specific `encrypted_content`; retagging restores local visibility, not backend compatibility.

Requires Node.js 22.5+ for the built-in `node:sqlite` module. Tests use only Node built-ins.

## Validation on 2026-11-16

An isolated copy of the current official-provider chat was converted `openai -> codex -> openai`. The installed Windows CLI `0.169.0-alpha.11.1` successfully handled `thread/resume`, `thread/read`, and `thread/turns/list` after both conversions. All 72 projected history items were recovered and the projection cursor matched the rewritten rollout size. Ownership fields and user messages were preserved. The source chat and its live databases were not changed. No model turn was submitted to either backend; this validates local resume and history compatibility.

The local report is `work/provider-sync-validation/report.json`. The regression suite covers the launchers, targeted scans, inherited-history preservation, compaction metadata alignment, and a failed file replacement.

The existing chat `01a10c06-f043-78a0-9ce6-c02906685005` was also migrated from `codex` to `openai`. Its current rollout uses a separate rollout ID. The 3330 items and 22 turns of that rollout were recovered with a projection cursor matching the rewritten file size, and the desktop history reader could read its latest turn. Older compressed segments were left intact. The original rollout and state database are backed up under `C:\Users\lensm\.codex\backups\provider-sync\2026-11-16T19-15-04-770Z`; the correct rollout-keyed history snapshot is in the following backup `2026-11-16T19-16-27-367Z`. The live report is `work/provider-sync-validation/ecs-live-report.json`.

Full standalone CLI `thread/resume` for this large existing chat did not complete within 120 seconds, despite completing its history projection. Provider metadata and desktop history reads were verified; sending a new model turn was not tested.

`reference/decompile/*` was absent in this checkout. The relevant upstream references reviewed were [history materialization](https://github.com/openai/codex/blob/main/codex-rs/thread-store/src/local/thread_history_materialization.rs) and [history projection writes](https://github.com/openai/codex/blob/main/codex-rs/thread-store/src/local/thread_history.rs).
