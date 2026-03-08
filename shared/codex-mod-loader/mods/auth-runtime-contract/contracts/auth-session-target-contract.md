# Auth Session Target Contract

## Purpose

Define the stable auth/session surfaces the Windows mod platform relies on.

## Surface 1: Auth File

- Path:
  - `%CODEX_HOME%\\auth.json`
  - fallback `%USERPROFILE%\\.codex\\auth.json`
- Stability class:
  - medium
- Allowed behavior:
  - observe file replacement or content rewrite
  - emit structured metadata-only logs
- Forbidden behavior:
  - mutate auth contents
  - force app relaunch solely because the file changed

## Surface 2: Outbound Auth Status Request

- Transport:
  - app main process -> bundled `codex.exe` stdio
- Stable signal:
  - JSON line with `method == "getAuthStatus"`
  - request id prefix often `electron-auth:`
- Important params:
  - `includeToken`
  - `refreshToken`
- Allowed behavior:
  - structured logging
  - conservative debounce elsewhere in the platform
- Forbidden behavior:
  - dropping the only refresh after a real auth file change

## Surface 3: Inbound Auth Notifications

- Transport:
  - bundled `codex.exe` stdio -> app main process
- Stable signals:
  - `method == "account/updated"`
  - `method == "account/login/completed"`
- Allowed behavior:
  - structured logging
  - cache invalidation
- Forbidden behavior:
  - hard relaunch without a stronger failure reason

## Surface 4: Auth Status Response

- Transport:
  - bundled `codex.exe` stdio -> app main process
- Stable signal:
  - response id starts with `electron-auth:`
- Stable fields:
  - `result.authMethod`
  - token/account/user/email/plan presence
- Forbidden behavior:
  - logging raw token strings

## Surface 5: Window Recovery

- Runtime signal:
  - `webcontents.render-process-gone`
- Requirement:
  - renderer mod reinjection state must reset after crash recovery
- Reason:
  - auth debugging is invalid if recovery silently drops runtime mods
