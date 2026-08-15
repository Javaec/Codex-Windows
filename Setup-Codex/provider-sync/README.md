# Codex Provider Sync

Standalone Windows utility for retagging Codex sessions when switching between the official provider and a custom provider.

Codex stores the provider in two places:

- `sessions/**/rollout-*.jsonl` and `archived_sessions/rollout-*.jsonl`, inside the first `session_meta` record;
- `state_5.sqlite`, in the `threads.model_provider` column.

Both surfaces must be updated or the session can disappear from the history/resume list. The package changes only that metadata field. It does not modify message bodies, `auth.json`, titles, or `config.toml`.

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

Backups are created under `<CODEX_HOME>\backups\provider-sync\<timestamp>` before every write. The default state database follows the current Codex layout: root `state_5.sqlite`, then `sqlite\state_5.sqlite` only if the root database is absent. Use `--state-db` when an explicit database is required.

The tool intentionally fails when `.jsonl.zst` rollouts are present because it cannot safely rewrite compressed rollouts without a zstd runtime. No partial write is started in that case.

Cross-provider continuation can still fail when the backend cannot decrypt provider-specific `encrypted_content`; retagging restores local visibility, not backend compatibility.

Requires Node.js 22.5+ for the built-in `node:sqlite` module. Tests use only Node built-ins.
