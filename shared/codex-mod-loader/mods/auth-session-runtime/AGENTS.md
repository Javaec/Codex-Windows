# AGENTS Notes

## Purpose

- Establish a real auth runtime contract instead of treating `auth.json` and session refresh as incidental side effects.

## Current Decisions

- This is a main-process mod.
- Declared main capability:
  - `app-start`
- It does not force relaunches.
- It owns:
  - `auth.json` watching
  - transport-level structured logs for auth/session messages
  - contract artifacts for auth/session surfaces

## Logging Contract

- Structured log prefix:
  - `[codex-auth-runtime]`
- Required events:
  - `auth-file-snapshot`
  - `auth-file-changed`
  - `get-auth-status-request`
  - `get-auth-status-response`
  - `account-updated-notification`
  - `account-login-completed-notification`
  - `codex-transport-spawn`
  - `codex-transport-close`
- Never log raw tokens or raw auth.json contents.

## Why

- Hot auth swap needs observability before it needs more heuristics.
- Transport-level instrumentation is less invasive than patching upstream auth classes directly.
- Keeping target contracts beside the mod makes build drift easier to audit.
