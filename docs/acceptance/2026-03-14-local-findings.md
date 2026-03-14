# 2026-03-14 Local Acceptance Findings

## Summary

- `npm run acceptance:native-desktop -- --json --skip-sqlite` failed because the default root `/Users/linchen/.code-agent/native-desktop` does not exist on this machine yet.
- `npm run acceptance:mail -- status --json`
- `npm run acceptance:calendar -- status --json`
- `npm run acceptance:reminders -- status --json`

The three office connector smoke scripts start correctly, but on this machine they are currently blocked when executed from a plain Node host process.

- `npm run acceptance:app-host-office -- smoke --base-url http://127.0.0.1:8091 --token "<token>" --json`

The new app-host smoke passes from the desktop host web server path:

- Mail: connected, 2 accounts, 19 mailboxes
- Calendar: connected, 8 calendars
- Reminders: connected, 4 lists

Important scope clarification as of 2026-03-14:

- `/api/dev/exec-tool` in web mode currently routes through `src/web/webServer.ts -> src/cli/bootstrap.ts`.
- The CLI-backed `ToolExecutor` still uses `requestPermission: async () => true`.
- Therefore current app-host office smoke remains connector smoke / host-exec validation, not real permission approval E2E.
- `/api/dev/exec-tool` now also has a dedicated `requireRealApproval=true` path in `src/web/webServer.ts` that emits `permission_request` over SSE and waits for a real UI response.
- This is intentionally C1b-lite: it is a web-host local approval loop, not the full desktop `AgentAppService / AgentOrchestrator` chain.
- When the loop cannot complete, it now fails explicitly with `NO_APPROVAL_CLIENT_CONNECTED`, `REAL_APPROVAL_TIMEOUT`, or `REAL_APPROVAL_DENIED` instead of silently auto-approving.

## Observed Behavior

- Direct shell invocation of `osascript` can read Mail / Calendar / Reminders.
- The same AppleScript calls fail when spawned from Node-based smoke scripts, with errors such as:
  - `Connection Invalid error for service com.apple.hiservices-xpcservice`
  - `Expected class name but found identifier. (-2741)`
  - `Can’t get application "Reminders". (-1728)`

## Working Hypothesis

- This looks like a host-process / automation / TCC issue specific to Node-hosted execution on this machine, not a TypeScript packaging issue.
- Because office connectors are intended to run from the desktop app host, the next validation step should happen inside the Electron/Tauri runtime, not only from standalone Node smoke scripts.
- However, web-mode host execution still does not prove the desktop main-process approval round-trip, because it bypasses the desktop `AgentAppService / AgentOrchestrator` approval chain and uses a web-host SSE approval loop instead.

## Next Step

1. Keep standalone Node smoke scripts as a CLI harness for argument validation and non-destructive preflight.
2. Use the app-host smoke bridge as the primary read-path acceptance entry for desktop host validation.
3. Use the app-host office write script in two modes: default connector write-path validation, or `--real-approval` for the web-host SSE approval loop.
4. If stricter parity is still required, replace the C1b-lite loop with a real desktop `AppService / AgentOrchestrator` approval chain.
