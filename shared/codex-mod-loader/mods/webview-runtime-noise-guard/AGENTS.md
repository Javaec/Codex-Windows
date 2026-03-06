# AGENTS Notes

## Purpose

- Keep renderer diagnostics readable by suppressing known non-actionable log spam.

## Current Decisions

- Suppress `No promise for request ID` noise.
- Keep only the first `[desktop-notifications] service starting` line.
- Do not hide business errors or transport failures.

## Why

- These lines add noise during normal startup and bury real regressions in the log stream.
