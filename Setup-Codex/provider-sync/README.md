# Codex Provider Sync

Standalone Windows utility for retagging Codex sessions when switching between the official provider and a custom provider.

Codex stores the provider in two places:

- `sessions/**/rollout-*.jsonl` and `archived_sessions/rollout-*.jsonl`, inside every `session_meta` record;
- `state_5.sqlite`, in the `threads.model_provider` column.

Both surfaces must be updated or the session can disappear from the history/resume list. Newer Codex versions also index paginated history in `thread_history_1.sqlite`. Rewriting a rollout changes byte offsets, so the utility backs up the selected thread's index and removes its local projection. Codex rebuilds that projection on `thread/resume`; opening paginated history through read-only listing calls alone does not rebuild it. History before `session_meta.history_base` is retained because its source may no longer be in the current rollout.

During a migration, the package converts visible reasoning summaries and content into ordinary assistant text messages and removes reasoning items without visible text. Merely deleting `encrypted_content` leaves summary-only reasoning that Rustponses cannot replay through `previous_response_id`. The repair covers response items, compaction replacement history, and `guardian_history`. Readable compaction text accidentally stored in `encrypted_content` becomes an assistant message; opaque compaction ciphertext is removed. Parallel history metadata stays aligned. The same repair is available without changing providers through `--repair-replay` (`--repair-encrypted` is also accepted). The package preserves account ownership fields, titles, rollout ordinals, tool calls, tool results, and visible reasoning text, and does not modify `auth.json` or `config.toml`.

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

On Windows, apply probes each selected chat's writer lock by reading one byte before creating backups or changing data. Opening the file alone does not detect Codex's byte-range lock. This also covers SQLite-only provider updates. A loaded chat must be unloaded before applying changes.

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

To repair provider-specific replay state, including summary-only reasoning and nested guardian history:

```text
Run-Codex-Provider-Sync.cmd --repair-replay --session-id 01... --dry-run
Run-Codex-Provider-Sync.cmd --repair-replay --session-id 01... --yes
```

Omit `--session-id` to scan all active and archived rollouts. The interactive PowerShell launcher exposes this as a separate operation.

Backups are created under `<CODEX_HOME>\backups\provider-sync\<timestamp>` before every write. The state backup is a consistent SQLite snapshot, including committed WAL data. The history backup contains only the selected threads' rows, rather than a copy of the entire history database. It is a row snapshot for restoring those threads, not a replacement for the live history database. The default state database follows `sqlite_home` from `config.toml`, then root `state_5.sqlite`, then `sqlite\state_5.sqlite`. Use `--state-db` when an explicit database is required. The history database is resolved beside the selected state database.

The preview reports mixed `session_meta` files, empty-history candidates, all reasoning replay candidates, encrypted replay candidates, and nested plaintext/opaque compaction candidates. The apply report shows how many reasoning items became text messages, readable compactions were converted, and opaque compactions were removed. Every write has a backup and a post-write scan.

Rollout inspection and rewriting use 1 MiB read blocks and a bounded output queue. Incomplete records are joined once, so memory scales with the largest JSONL record rather than the entire history. A targeted `--session-id` scan uses SQLite's current rollout path first. It leaves older immutable segments of the same chat untouched, including compressed segments. When the index does not resolve the session, it searches matching filenames and then other rollout files. `--status --session-id ID` is also scoped to one chat. For a rotated rollout, the history index is keyed by the rollout ID in its filename, which can differ from the stable chat ID.

Post-write verification reads only the planned rollouts and checks the updated SQLite rows. It rejects missing rows, changed session identities, and remaining replay problems without rescanning unrelated histories or treating concurrently created chats as failed migrations. Bulk history resets reuse prepared SQL statements. Buffered output uses [`fs.writeFileSync`](https://nodejs.org/api/fs.html#fswritefilesyncfile-data-options) on the open temporary descriptor before syncing and replacing the original file.

The tool intentionally fails when selected `.jsonl.zst` rollouts are present because it cannot safely rewrite compressed rollouts without a zstd runtime. Unrelated compressed rollouts do not block a targeted migration. No partial write is started in that case.

Local provider counts and history scans alone cannot establish backend continuation compatibility. Validate both the initial model request and continuation after a tool result.

Requires Node.js 22.5+ for the built-in `node:sqlite` module. Tests use only Node built-ins.

## Validation on 2026-11-16

`npm run test:provider-sync` runs 26 tests covering provider migration, nested replay repair, inherited history, byte-range writer locks, concurrent SQLite changes, UTF-8 split across read blocks, large records, CRLF, and files without a final newline. Tests use the same on-disk rewrite as the CLI.

The installed Windows CLI `0.169.0-alpha.11.1` resumed an isolated official-provider chat after both `openai -> codex -> openai` conversions, preserving all 72 projected history items. The existing chat `01a10c06-f043-78a0-9ce6-c02906685005` was migrated to `openai` and repaired after reproducing `unsupported_persisted_item_context` with summary-only reasoning. Its repaired 106-item context passed an official WebSocket tool round trip ending in `PROBE_OK` and matched the live context by SHA-256. Native projection recovered all 3333 items and 23 turns. A full standalone CLI resume of this large chat was not confirmed; earlier attempts exceeded 120 seconds.

Original migration backup: `C:\Users\lensm\.codex\backups\provider-sync\2026-11-16T19-15-04-770Z`. Replay repair backup: `2026-11-16T19-49-36-429Z` in the same directory. Detailed local reports are under `work/provider-sync-validation/`: `report.json`, `ecs-live-report.json`, `replay-probe-report.json`, `ecs-context-probe-report.json`, and `ecs-replay-live-report.json`. Backend probes ran separately from the chat and executed only the diagnostic readiness tool.

### Local performance comparison

Three sequential before/after pairs used the same 63,125,423-byte history copy with Node.js `v26.13.0`, comparing the previous implementation at `c609cab` with the streaming refactor. Medians:

| Measurement | Before | After |
| --- | ---: | ---: |
| Peak process RSS | 359.25 MiB | 198.85 MiB |
| CPU time | 1.219 s | 1.032 s |
| Elapsed time | 2.064 s | 1.876 s |

All six runs produced identical 59,816,074-byte files with SHA-256 `a6aa3bacde41d00d77750a5ffa4df53c8fa2afcea81712d2448015bf3d91ecac`, converting 1873 reasoning records and removing 40 empty records. These are local measurements on one history; elapsed time also reflects other work on the machine. The benchmark leaves live chats unchanged. Raw measurements and source hashes are in `work/provider-sync-validation/polish-final-comparison.jsonl` and `polish-report.json`.

`reference/decompile/*` was absent in this checkout. Upstream references reviewed: [history materialization](https://github.com/openai/codex/blob/main/codex-rs/thread-store/src/local/thread_history_materialization.rs), [history projection writes](https://github.com/openai/codex/blob/main/codex-rs/thread-store/src/local/thread_history.rs), and [writer locks](https://github.com/openai/codex/blob/main/codex-rs/rollout/src/writer_lock.rs).
