# App-Host Office Write Acceptance

## Purpose

Run real write-path acceptance through the desktop app host instead of standalone CLI.

## Safety

- All commands go through `/api/dev/exec-tool` with `allowWrite=true`.
- The script still requires explicit test targets.
- `mail-send` also requires `--confirm-send`.
- Prefer dedicated acceptance targets, not real work calendars or reminder lists.

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

## Expected Workflow

- `calendar-cycle` creates a unique event, updates it, then deletes it.
- `reminders-cycle` creates a unique reminder, updates it, then deletes it.
- `mail-draft` creates a unique draft and leaves it in Mail.
- `mail-send` sends a real message and requires an explicit extra flag.
