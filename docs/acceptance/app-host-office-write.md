# App-Host Office Write Acceptance

## Purpose

Run office connector write-path acceptance through the desktop app host web server instead of standalone CLI.

This document now separates two different goals:

- Connector smoke / host-exec validation: verify that `/api/dev/exec-tool` can drive the desktop-host connector write path.
- Real approval E2E: verify that a permission request is emitted to the UI, approved by a real client, and then resumes tool execution.

The default path is still the first one. The web host now also has a C1b-lite real-approval path for `requireRealApproval=true`, but it is a web-mode SSE approval loop, not the full desktop `AgentAppService / AgentOrchestrator` chain.

## Safety

- All commands go through `/api/dev/exec-tool` with `allowWrite=true`.
- By default, `/api/dev/exec-tool` runs through the CLI-backed `ToolExecutor`, which is currently auto-approved.
- The script still requires explicit test targets.
- `mail-send` also requires `--confirm-send`.
- Prefer dedicated acceptance targets, not real work calendars or reminder lists.

## Modes

- Default mode: connector smoke / host-exec validation only. This proves the desktop-host bridge can execute the write tool.
- `--real-approval`: request the web-mode real approval path. This now emits `permission_request` over SSE and waits for a real UI response.
- `--real-approval` still fails fast when the approval loop cannot complete:
  - `NO_APPROVAL_CLIENT_CONNECTED`
  - `REAL_APPROVAL_TIMEOUT`
  - `REAL_APPROVAL_DENIED`

## Commands

Calendar create / update / delete:

```bash
npm run acceptance:app-host-office-write -- calendar-cycle \
  --base-url http://127.0.0.1:8080 \
  --token "<token>" \
  --calendar "Code Agent Acceptance"
```

Reminders create / update / delete:

```bash
npm run acceptance:app-host-office-write -- reminders-cycle \
  --base-url http://127.0.0.1:8080 \
  --token "<token>" \
  --list "Code Agent Acceptance"
```

Create a local Mail draft:

```bash
npm run acceptance:app-host-office-write -- mail-draft \
  --base-url http://127.0.0.1:8080 \
  --token "<token>" \
  --to "your-self@example.com"
```

Send a real Mail message:

```bash
npm run acceptance:app-host-office-write -- mail-send \
  --base-url http://127.0.0.1:8080 \
  --token "<token>" \
  --to "your-self@example.com" \
  --confirm-send
```

Run the web-mode real approval path:

```bash
npm run acceptance:app-host-office-write -- calendar-cycle \
  --base-url http://127.0.0.1:8080 \
  --token "<token>" \
  --calendar "Code Agent Acceptance" \
  --real-approval
```

Expected result:

- If a web client is connected and you approve the request, the write path continues.
- If no approval client is connected, it fails with `NO_APPROVAL_CLIENT_CONNECTED`.
- If the request is not answered in time, it fails with `REAL_APPROVAL_TIMEOUT`.
- If you deny it in the UI, it fails with `REAL_APPROVAL_DENIED`.

## Expected Workflow

- `calendar-cycle` creates a unique event, updates it, then deletes it.
- `reminders-cycle` creates a unique reminder, updates it, then deletes it.
- `mail-draft` creates a unique draft and leaves it in Mail.
- `mail-send` sends a real message and requires an explicit extra flag.
- With `--real-approval`, the request must not silently fall back to auto-approve. It now waits for a real SSE-driven approval response from the UI.
