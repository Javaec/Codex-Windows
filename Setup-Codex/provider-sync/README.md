# Codex Provider Sync

Standalone Windows utility for retagging Codex sessions when switching between the official provider and a custom provider.

Codex stores the provider in two places:

- `sessions/**/rollout-*.jsonl` and `archived_sessions/rollout-*.jsonl`, inside every `session_meta` record;
- `state_5.sqlite`, in the `threads.model_provider` column.

Both surfaces must be updated or the session can disappear from the history/resume list. During a migration, the package also repairs replay data that is tied to the old provider: it removes empty reasoning response items whose ID has no encrypted content, strips provider-specific reasoning ciphertext while preserving visible summaries, converts readable compaction text accidentally stored in `encrypted_content` into an assistant message, and removes opaque compaction ciphertext that the new provider cannot decrypt. The same repair is available without changing providers through `--repair-encrypted`. The package does not modify `auth.json`, titles, or `config.toml`.

## Usage

Double-click `Run-Codex-Provider-Sync.cmd` for the interactive PowerShell interface. If Windows Terminal is installed, the launcher opens a new styled Windows Terminal tab. It shows provider counts, asks for source and target providers, previews the changes, and asks for confirmation before writing.

The same launcher remains scriptable; when arguments are supplied it runs synchronously without opening a new tab. Preview a migration:

```text
Run-Codex-Provider-Sync.cmd --from openai --to codex --dry-run
```

Apply it after closing Codex, the Codex CLI, and app-server:

```text
Run-Codex-Provider-Sync.cmd --from openai --to codex --yes
```

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

Backups are created under `<CODEX_HOME>\backups\provider-sync\<timestamp>` before every write. The default state database follows the current Codex layout: root `state_5.sqlite`, then `sqlite\state_5.sqlite` only if the root database is absent. Use `--state-db` when an explicit database is required.

The preview reports mixed `session_meta` files, empty-history candidates, encrypted replay candidates, and nested plaintext/opaque compaction candidates. The apply report shows how many reasoning items were sanitized, readable compactions converted, and opaque compactions removed. Every write has a backup and a post-write scan.

The tool intentionally fails when `.jsonl.zst` rollouts are present because it cannot safely rewrite compressed rollouts without a zstd runtime. No partial write is started in that case.

Cross-provider continuation can still fail when the backend cannot decrypt provider-specific `encrypted_content`; retagging restores local visibility, not backend compatibility.

Requires Node.js 22.5+ for the built-in `node:sqlite` module. Tests use only Node built-ins.
