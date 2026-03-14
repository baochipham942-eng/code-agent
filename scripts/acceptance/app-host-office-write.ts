import fs from 'fs';
import path from 'path';
import {
  finishWithError,
  getNumberOption,
  getStringArrayOption,
  getStringOption,
  hasFlag,
  parseArgs,
  printJson,
  printKeyValue,
} from './_helpers.ts';

interface HostExecResult<T = unknown> {
  tool: string;
  params: Record<string, unknown>;
  project: string;
  sessionId: string;
  success: boolean;
  output?: string;
  error?: string;
  result?: T;
}

function usage(): void {
  console.log(`App-host office write acceptance

Usage:
  npm run acceptance:app-host-office-write -- <command> [options]

Commands:
  calendar-cycle --calendar <name> [--title-prefix <text>] [--start-minutes-from-now <n>] [--duration-minutes <n>] [--location <text>]
  reminders-cycle --list <name> [--title-prefix <text>] [--notes <text>]
  mail-draft --to <a@x.com,b@y.com> [--subject-prefix <text>] [--content <text>] [--attachments <p1,p2>]
  mail-send --to <a@x.com,b@y.com> [--subject-prefix <text>] [--content <text>] [--attachments <p1,p2>] --confirm-send

Options:
  --base-url <url>   App-host base URL. Default: http://127.0.0.1:8080
  --token <token>    Optional auth token. If omitted, try CODE_AGENT_TOKEN env, then page HTML.
  --project <path>   Optional project root passed to the host executor.
  --session <id>     Optional session id.
  --json             Print JSON only.
  --help             Show this help.
`);
}

function normalizeBaseUrl(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, '');
}

async function resolveToken(baseUrl: string, explicitToken?: string): Promise<string> {
  if (explicitToken?.trim()) return explicitToken.trim();
  if (process.env.CODE_AGENT_TOKEN?.trim()) return process.env.CODE_AGENT_TOKEN.trim();

  const response = await fetch(`${baseUrl}/`, { redirect: 'follow' });
  if (!response.ok) {
    throw new Error(`Failed to fetch ${baseUrl}/ for auth token: ${response.status}`);
  }

  const html = await response.text();
  const match = html.match(/window\.__CODE_AGENT_TOKEN__="([^"]+)"/);
  if (match?.[1]) {
    return match[1];
  }

  throw new Error('Unable to resolve auth token. Pass --token or export CODE_AGENT_TOKEN.');
}

async function postJson<T>(
  baseUrl: string,
  token: string,
  endpoint: string,
  body: Record<string, unknown>
): Promise<T> {
  const response = await fetch(`${baseUrl}${endpoint}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });

  const text = await response.text();
  const data = text ? JSON.parse(text) : null;
  if (!response.ok) {
    const message = typeof data?.error === 'string'
      ? data.error
      : `HTTP ${response.status}`;
    throw new Error(message);
  }

  return data as T;
}

async function execHostTool<T>(
  baseUrl: string,
  token: string,
  payload: {
    tool: string;
    params: Record<string, unknown>;
    project?: string;
    sessionId?: string;
  }
): Promise<HostExecResult<T>> {
  const result = await postJson<HostExecResult<T>>(baseUrl, token, '/api/dev/exec-tool', {
    tool: payload.tool,
    params: payload.params,
    project: payload.project,
    sessionId: payload.sessionId,
    allowWrite: true,
  });

  if (!result.success) {
    throw new Error(result.error || `Tool ${payload.tool} failed.`);
  }
  return result;
}

function buildUniqueTitle(prefix: string): string {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  return `${prefix} ${stamp}`;
}

function ensureExistingAttachmentPaths(paths: string[]): string[] {
  return paths
    .map((item) => path.resolve(item))
    .filter((item) => fs.existsSync(item));
}

async function runCalendarCycle(baseUrl: string, token: string, args: ReturnType<typeof parseArgs>, json: boolean): Promise<void> {
  const calendar = getStringOption(args, 'calendar');
  if (!calendar) {
    throw new Error('calendar-cycle requires --calendar');
  }

  const titlePrefix = getStringOption(args, 'title-prefix') || 'Code Agent Acceptance Event';
  const location = getStringOption(args, 'location') || 'Code Agent Acceptance';
  const startMinutesFromNow = getNumberOption(args, 'start-minutes-from-now') ?? 10;
  const durationMinutes = getNumberOption(args, 'duration-minutes') ?? 30;
  const project = getStringOption(args, 'project');
  const sessionId = getStringOption(args, 'session');
  const startMs = Date.now() + startMinutesFromNow * 60_000;
  const endMs = startMs + durationMinutes * 60_000;
  const createTitle = buildUniqueTitle(titlePrefix);
  let createdUid: string | null = null;
  let deleted = false;

  try {
    const created = await execHostTool<{ uid: string; calendar: string; title: string; startAtMs: number | null; endAtMs: number | null; location?: string }>(
      baseUrl,
      token,
      {
        tool: 'calendar_create_event',
        params: {
          calendar,
          title: createTitle,
          start_ms: startMs,
          end_ms: endMs,
          location,
        },
        project,
        sessionId,
      }
    );
    createdUid = created.result?.uid || null;
    if (!createdUid) {
      throw new Error('calendar_create_event did not return uid.');
    }

    const updated = await execHostTool<{ uid: string; calendar: string; title: string; startAtMs: number | null; endAtMs: number | null; location?: string }>(
      baseUrl,
      token,
      {
        tool: 'calendar_update_event',
        params: {
          calendar,
          event_uid: createdUid,
          title: `${createTitle} Updated`,
          start_ms: startMs + 15 * 60_000,
          end_ms: endMs + 15 * 60_000,
          location: `${location} Updated`,
        },
        project,
        sessionId,
      }
    );

    const removed = await execHostTool<{ uid: string; calendar: string; title: string; deleted: boolean }>(
      baseUrl,
      token,
      {
        tool: 'calendar_delete_event',
        params: {
          calendar,
          event_uid: createdUid,
        },
        project,
        sessionId,
      }
    );
    deleted = true;

    const result = {
      ok: true,
      createTitle,
      calendar,
      created: created.result,
      updated: updated.result,
      deleted: removed.result,
    };

    if (json) {
      printJson(result);
    } else {
      printKeyValue('Calendar Cycle', [
        ['calendar', calendar],
        ['createdUid', createdUid],
        ['deleted', deleted],
      ]);
      console.log(`\n${JSON.stringify(result, null, 2)}`);
    }
  } finally {
    if (createdUid && !deleted) {
      try {
        await execHostTool(
          baseUrl,
          token,
          {
            tool: 'calendar_delete_event',
            params: { calendar, event_uid: createdUid },
            project,
            sessionId,
          }
        );
      } catch {
        // Cleanup best effort only.
      }
    }
  }
}

async function runRemindersCycle(baseUrl: string, token: string, args: ReturnType<typeof parseArgs>, json: boolean): Promise<void> {
  const list = getStringOption(args, 'list');
  if (!list) {
    throw new Error('reminders-cycle requires --list');
  }

  const titlePrefix = getStringOption(args, 'title-prefix') || 'Code Agent Acceptance Reminder';
  const notes = getStringOption(args, 'notes') || 'created by app-host acceptance';
  const project = getStringOption(args, 'project');
  const sessionId = getStringOption(args, 'session');
  const createTitle = buildUniqueTitle(titlePrefix);
  let reminderId: string | null = null;
  let deleted = false;

  try {
    const created = await execHostTool<{ id: string; list: string; title: string; completed: boolean }>(
      baseUrl,
      token,
      {
        tool: 'reminders_create',
        params: {
          list,
          title: createTitle,
          notes,
        },
        project,
        sessionId,
      }
    );
    reminderId = created.result?.id || null;
    if (!reminderId) {
      throw new Error('reminders_create did not return id.');
    }

    const updated = await execHostTool<{ id: string; list: string; title: string; completed: boolean }>(
      baseUrl,
      token,
      {
        tool: 'reminders_update',
        params: {
          list,
          reminder_id: reminderId,
          title: `${createTitle} Updated`,
          notes: `${notes} / updated`,
          completed: true,
        },
        project,
        sessionId,
      }
    );

    const removed = await execHostTool<{ id: string; list: string; title: string; deleted: boolean }>(
      baseUrl,
      token,
      {
        tool: 'reminders_delete',
        params: {
          list,
          reminder_id: reminderId,
        },
        project,
        sessionId,
      }
    );
    deleted = true;

    const result = {
      ok: true,
      list,
      reminderId,
      created: created.result,
      updated: updated.result,
      deleted: removed.result,
    };

    if (json) {
      printJson(result);
    } else {
      printKeyValue('Reminders Cycle', [
        ['list', list],
        ['reminderId', reminderId],
        ['deleted', deleted],
      ]);
      console.log(`\n${JSON.stringify(result, null, 2)}`);
    }
  } finally {
    if (reminderId && !deleted) {
      try {
        await execHostTool(
          baseUrl,
          token,
          {
            tool: 'reminders_delete',
            params: { list, reminder_id: reminderId },
            project,
            sessionId,
          }
        );
      } catch {
        // Cleanup best effort only.
      }
    }
  }
}

async function runMailDraft(baseUrl: string, token: string, args: ReturnType<typeof parseArgs>, json: boolean): Promise<void> {
  const to = getStringArrayOption(args, 'to');
  if (to.length === 0) {
    throw new Error('mail-draft requires --to');
  }

  const project = getStringOption(args, 'project');
  const sessionId = getStringOption(args, 'session');
  const attachments = ensureExistingAttachmentPaths(getStringArrayOption(args, 'attachments'));
  const result = await execHostTool<{
    subject: string;
    to: string[];
    cc: string[];
    bcc: string[];
    attachments: string[];
    saved: boolean;
  }>(
    baseUrl,
    token,
    {
      tool: 'mail_draft',
      params: {
        subject: buildUniqueTitle(getStringOption(args, 'subject-prefix') || 'Code Agent Acceptance Draft'),
        to,
        cc: getStringArrayOption(args, 'cc'),
        bcc: getStringArrayOption(args, 'bcc'),
        content: getStringOption(args, 'content') || 'created by app-host acceptance',
        attachments,
      },
      project,
      sessionId,
    }
  );

  if (json) {
    printJson(result);
  } else {
    printKeyValue('Mail Draft', [
      ['subject', result.result?.subject || result.params.subject as string],
      ['saved', result.result?.saved ?? null],
      ['attachments', result.result?.attachments?.length ?? 0],
    ]);
    console.log(`\n${result.output || JSON.stringify(result.result, null, 2)}`);
  }
}

async function runMailSend(baseUrl: string, token: string, args: ReturnType<typeof parseArgs>, json: boolean): Promise<void> {
  const to = getStringArrayOption(args, 'to');
  if (to.length === 0) {
    throw new Error('mail-send requires --to');
  }
  if (!hasFlag(args, 'confirm-send')) {
    throw new Error('mail-send requires --confirm-send');
  }

  const project = getStringOption(args, 'project');
  const sessionId = getStringOption(args, 'session');
  const attachments = ensureExistingAttachmentPaths(getStringArrayOption(args, 'attachments'));
  const result = await execHostTool<{
    subject: string;
    to: string[];
    cc: string[];
    bcc: string[];
    attachments: string[];
    sent: boolean;
  }>(
    baseUrl,
    token,
    {
      tool: 'mail_send',
      params: {
        subject: buildUniqueTitle(getStringOption(args, 'subject-prefix') || 'Code Agent Acceptance Send'),
        to,
        cc: getStringArrayOption(args, 'cc'),
        bcc: getStringArrayOption(args, 'bcc'),
        content: getStringOption(args, 'content') || 'sent by app-host acceptance',
        attachments,
      },
      project,
      sessionId,
    }
  );

  if (json) {
    printJson(result);
  } else {
    printKeyValue('Mail Send', [
      ['subject', result.result?.subject || result.params.subject as string],
      ['sent', result.result?.sent ?? null],
      ['attachments', result.result?.attachments?.length ?? 0],
    ]);
    console.log(`\n${result.output || JSON.stringify(result.result, null, 2)}`);
  }
}

async function run(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (hasFlag(args, 'help') || args.positionals.length === 0) {
    usage();
    return;
  }

  const command = args.positionals[0];
  const json = hasFlag(args, 'json');
  const baseUrl = normalizeBaseUrl(getStringOption(args, 'base-url') || 'http://127.0.0.1:8080');
  const token = await resolveToken(baseUrl, getStringOption(args, 'token'));

  switch (command) {
    case 'calendar-cycle':
      await runCalendarCycle(baseUrl, token, args, json);
      return;
    case 'reminders-cycle':
      await runRemindersCycle(baseUrl, token, args, json);
      return;
    case 'mail-draft':
      await runMailDraft(baseUrl, token, args, json);
      return;
    case 'mail-send':
      await runMailSend(baseUrl, token, args, json);
      return;
    default:
      throw new Error(`Unknown command: ${command}`);
  }
}

run().catch(finishWithError);
