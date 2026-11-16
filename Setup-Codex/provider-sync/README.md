# Codex Provider Sync

Standalone Windows utility for retagging Codex sessions when switching between the official provider and a custom provider.

## Fast bulk switching

```text
Run-Codex-Provider-Sync.cmd --all --to openai --dry-run
Run-Codex-Provider-Sync.cmd --all --to openai --yes
```

`--all` selects every indexed provider except the target. Use `--from codex --to openai` to select one source instead. Both commands use the same bulk path when `--session-id` is omitted. Active and archived chats are included. Already selected target-provider chats are untouched. `--status` reads SQLite and file metadata only, so opening the menu no longer parses gigabytes of history.

The bulk path creates a new immutable rollout containing the latest compaction checkpoint and its suffix, sanitizes provider-specific replay state, and switches the existing chat's provider and file pointer in one SQLite transaction. The new header uses `history_base` to retain the older visible history at its original byte cutoff. Originals and their history projections stay intact, including ancestors referenced by other chats. Without a checkpoint in the current segment, it follows frozen ancestor cutoffs until it finds one or reaches the beginning.

Two persistent workers stream plain or `.jsonl.zst` histories using Node's built-in zstd decoder. Memory retains the latest checkpoint and suffix rather than every compaction. Each output is synced before publication. Selected chats must be unloaded. Writer locks and source changes are checked before publication, and a concurrent SQLite pointer change cancels the whole transaction. Failed preparation removes unpublished output files.

The backup contains a consistent state database snapshot and `manifest.json` with each chat's original provider, path, and new path. Original rollout files are the unchanged body backups; do not delete them after switching. Existing missing histories are reported as `missingRollouts`: only their provider metadata can be switched. The utility cannot recover a previously deleted history.

Bulk zstd support requires Node.js 22.15+ or 23.8+. Targeted in-place repairs retain their previous behavior and compression restriction.

The installed CLI `0.169.0-alpha.11.1` verified a bulk round trip on an isolated copy of the ECS chat, including compressed input. All 24 turns and 3728 full history items remained available. A 65,597,978-byte source produced a 6,081,343-byte continuation in 935 ms locally; reverse migration of its compressed continuation took 804 ms. These are single local measurements, not a throughput guarantee. Detailed reports: `work/provider-sync-validation/bulk-native-report.json` and `bulk-native-ecs-report.json`.

### Live bulk validation on 2026-11-16

The live migration switched 558 indexed chats to `openai` in 38.209 seconds. It created continuations for 449 available histories, including 311 compressed inputs; 109 previously missing histories received provider metadata updates only. Selected source files occupied 6,573,077,259 bytes. New continuations occupied 899,594,286 bytes. The process used 77.297 CPU seconds across its workers and peaked at 458 MiB RSS. A subsequent status query took 35 ms locally.

Verification checked all 449 new headers and confirmed every original file's size and modification time remained unchanged. All 579 rows then present in SQLite used `openai`. The two previously running chats were unloaded and returned from the archive. Native `thread/resume` with `excludeTurns=true` and full paginated history reads succeeded for both; their first 100 turns contained 10,098 and 13,267 items respectively. These page counts are not totals for the complete chats.

The migrated Disconnects context (192 items) passed the official WebSocket diagnostic tool call and `previous_response_id` continuation, returning `PROBE_OK`. No model turn was submitted to either live chat. This sample establishes continuation compatibility for the tested context; it does not test every migrated chat against the backend.

Backup: `C:\Users\lensm\.codex\backups\provider-sync\2026-11-16T20-50-43-374Z-bulk`. Local evidence lives in `work/provider-sync-validation/`: `bulk-live-report.json`, `bulk-live-verification.json`, `bulk-live-native-report.json`, and `bulk-context-probe-report.json`. These files contain private local paths/history and are not committed.

`npm run test:provider-sync` now runs 34 tests, including compressed archived histories, frozen ancestor cutoffs, immutable originals, replay sanitization, missing files, byte-range locks, source writes during preparation, and atomic cancellation on concurrent SQLite changes.

The design follows upstream [immutable revert segments](https://github.com/openai/codex/blob/main/codex-rs/thread-store/src/local/revert_thread.rs), [model-context checkpoint boundaries](https://github.com/openai/codex/blob/main/codex-rs/rollout/src/model_context.rs), and [rollout compression](https://github.com/openai/codex/blob/main/codex-rs/rollout/src/compression.rs).

### Bulk implementation polish

Bulk switching now parses and serializes each retained record once. The same record sanitizer serves targeted repair and bulk continuation files. The streaming reader splits decoded buffers before UTF-8 conversion, so byte offsets come directly from buffer lengths. The writer uses a character-bounded queue and reads the actual output byte count once after syncing. Preview and no-op operations skip the rollout directory catalog. File sizes and the SQLite verification statement are reused, and workers take jobs by index without copying and shifting a queue. A failed worker immediately cancels the other worker before unpublished files are removed.

Three sequential before/after pairs compared this version with `ccfc17e`, using Node.js `v26.13.0` and isolated copies of two real histories, each in plain and zstd form. Medians:

| Input | CPU ms before → after | Peak RSS MiB before → after | Elapsed ms before → after |
| --- | ---: | ---: | ---: |
| Original history, 65.6 MB, plain | 344 → 203 | 151 → 138 | 624 → 1014 |
| Original history, 65.6 MB decoded, zstd | 438 → 422 | 165 → 149 | 774 → 746 |
| Continuation, 8.95 MB, plain | 187 → 109 | 138 → 124 | 707 → 664 |
| Continuation, 8.95 MB decoded, zstd | 172 → 171 | 159 → 122 | 731 → 662 |

The read-only no-match preview against the real home took 147.55 ms before and 2.92 ms after (20 measured calls per version, following warm-up). All six runs per input produced byte-identical output: original history SHA-256 `6ef8aedd819010451895e240dd788d1aa6c2912037ddd3d90dee429c67336715`, continuation SHA-256 `7d77e9beda08fec3b9f0c4ac0c7bf327d72a433612894ccc33c085b0bf2c122b`. End-to-end elapsed time varied; the plain original-history case was slower despite using less CPU and memory. These local measurements do not establish a universal wall-clock speedup.

The installed CLI also verified another isolated round trip, including zstd input, preserving all 25 turns and 3834 full history items. The current suite has 40 tests, including split UTF-8/emoji, CRLF, unterminated records, worker cancellation, no-op/preview directory isolation, invalid records, and prototype-named provider IDs. Detailed local evidence: `work/provider-sync-validation/bulk-polish-measurements.json`, `bulk-polish-inputs.json`, and `bulk-polish-native-report.json`. No live chat provider or history was changed by these polish checks.

### Seek to the retained plain-file suffix

Plain rollouts now locate a canonical compaction record header from the end in overlapping 1 MiB blocks. The reader loads the original session metadata and streams forward from that offset, preserving exact byte cutoffs. Nested payload markers cannot become seek points. Records with different formatting still pass through the existing forward reader, so a newer checkpoint remains authoritative. Large metadata records and files without a recognized checkpoint use the full forward scan. Zstd input remains sequential. Checkpoint validation now reuses the parsed output record instead of parsing the large checkpoint payload twice.

Three before/after pairs compared frozen copies of `67886e3` and this implementation with Node.js `v26.13.0`. The same two real histories were tested in plain and zstd form. Medians:

| Input | CPU ms before → after | Peak RSS MiB before → after | Elapsed ms before → after |
| --- | ---: | ---: | ---: |
| Original history, 65.6 MB, plain | 375 → 203 | 155 → 118 | 1399 → 1199 |
| Original history, 65.6 MB decoded, zstd | 704 → 719 | 164 → 178 | 2703 → 1931 |
| Continuation, 8.95 MB, plain | 203 → 172 | 131 → 125 | 944 → 750 |
| Continuation, 8.95 MB decoded, zstd | 328 → 282 | 128 → 131 | 1087 → 1010 |

All six outputs per input remained byte-identical, with the same SHA-256 hashes recorded above. The plain-history case used 46% less CPU and 24% less peak RSS in this sample. Compressed-input CPU and memory did not improve consistently; these local measurements do not establish a universal speedup. Read-only no-match preview remained approximately 6 ms in this run.

The suite now has 47 tests, including headers split across reverse-read blocks, nested markers, newer noncanonical checkpoints, plain and compressed frozen ancestor cutoffs, large metadata with and without checkpoints, and atomic failure on incomplete compactions. The installed CLI verified both directions on another isolated copy, including zstd input, preserving all 25 turns and 3834 full history items. No live chat was migrated during these checks. Local measurements and frozen source hashes: `work/provider-sync-validation/reverse-measurements.json` and `reverse-summary.json`. Native validation: `reverse-native-report.json`. References under `reference/decompile/*` remain absent; the approach was checked against upstream [model-context reads](https://github.com/openai/codex/blob/main/codex-rs/thread-store/src/local/model_context.rs) and [blocking rollout reads](https://github.com/openai/codex/blob/main/codex-rs/rollout/src/compression/blocking_reader.rs).

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

Targeted in-place migration and history repair fail when selected `.jsonl.zst` rollouts are present. Bulk provider switching supports compressed input through immutable continuation files. Unrelated compressed rollouts do not block a targeted migration.

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
