# App-Host Office Smoke

## Purpose

Validate Mail / Calendar / Reminders from the desktop app host path instead of standalone CLI.

## Commands

Run the bundled office smoke:

```bash
npm run acceptance:app-host-office -- smoke --base-url http://127.0.0.1:8080 --token "<token>"
```

Run one tool directly through the host bridge:

```bash
npm run acceptance:app-host-office -- exec \
  --base-url http://127.0.0.1:8080 \
  --token "<token>" \
  --tool calendar \
  --params '{"action":"get_status"}'
```

Write tools are blocked unless `--allow-write` is passed:

```bash
npm run acceptance:app-host-office -- exec \
  --base-url http://127.0.0.1:8080 \
  --token "<token>" \
  --tool mail_send \
  --allow-write \
  --params '{"subject":"test","to":["you@example.com"],"content":"hello"}'
```

## Notes

- The server-side bridge is dev-only: `/api/dev/exec-tool` and `/api/dev/smoke/office`.
- Allowed tools are intentionally limited to native desktop and office acceptance targets.
- `smoke` checks:
  - `mail`: `get_status`, `list_accounts`, `list_mailboxes`
  - `calendar`: `get_status`, `list_calendars`
  - `reminders`: `get_status`, `list_lists`
