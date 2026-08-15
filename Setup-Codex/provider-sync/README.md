# Codex Provider Sync

Standalone Windows utility for retagging Codex sessions when switching between the official provider and a custom provider.

Codex stores the provider in two places:

- `sessions/**/rollout-*.jsonl` and `archived_sessions/rollout-*.jsonl`, inside every `session_meta` record;
- `state_5.sqlite`, in the `threads.model_provider` column.

Both surfaces must be updated or the session can disappear from the history/resume list. During a migration, the package also removes only empty reasoning response items whose ID has no encrypted content and whose summary is invisible. These items are not useful history, but a later cross-provider `/responses/compact` call can submit their stale ID and receive a 404. Real messages and reasoning items with content remain unchanged. The package does not modify `auth.json`, titles, or `config.toml`.

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

Backups are created under `<CODEX_HOME>\backups\provider-sync\<timestamp>` before every write. The default state database follows the current Codex layout: root `state_5.sqlite`, then `sqlite\state_5.sqlite` only if the root database is absent. Use `--state-db` when an explicit database is required.

The preview reports mixed `session_meta` files and repair candidates. The apply report shows how many history items were removed. This repair is deliberately narrow: a visible summary-only reasoning item is preserved, as are all items with encrypted content.

The tool intentionally fails when `.jsonl.zst` rollouts are present because it cannot safely rewrite compressed rollouts without a zstd runtime. No partial write is started in that case.

Cross-provider continuation can still fail when the backend cannot decrypt provider-specific `encrypted_content`; retagging restores local visibility, not backend compatibility.

Requires Node.js 22.5+ for the built-in `node:sqlite` module. Tests use only Node built-ins.
