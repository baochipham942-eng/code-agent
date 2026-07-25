// Schema-only file（三个 self-wake 工具共处一处：单一真源）
import type { ToolSchema } from '../../../protocol/tools';

const COMMON_REASON = {
  type: 'string',
  description:
    'Why you are pausing and what you will do when you wake up. This text is handed back to you verbatim on wake-up, '
    + 'so write it as a note to yourself, e.g. "waiting for the nightly export to finish, then summarise the diff".',
} as const;

export const sleepUntilSchema: ToolSchema = {
  name: 'sleep_until',
  description:
    'Park the current task until a given time, then continue automatically. '
    + 'Use when the next useful step simply cannot happen yet (a deadline, a scheduled export, "check back in 2 hours"). '
    + 'This ends the current turn — you are not blocking or polling, and nothing runs while you wait. '
    + 'You will be woken with your own reason text. For work that should repeat on a schedule, create an automation instead.',
  inputSchema: {
    type: 'object',
    properties: {
      until: {
        type: 'string',
        description: 'Absolute wake-up time as an ISO 8601 timestamp, e.g. "2026-07-26T09:00:00+08:00".',
      },
      reason: COMMON_REASON,
    },
    required: ['until', 'reason'],
  },
  category: 'planning',
  permissionLevel: 'write',
  readOnly: false,
  allowInPlanMode: false,
};

export const wakeOnSchema: ToolSchema = {
  name: 'wake_on',
  description:
    'Park the current task until a specific automation (cron job) finishes, then continue automatically. '
    + 'Use when your next step needs the output of a scheduled task that is already set up. '
    + 'This ends the current turn; nothing runs while you wait.',
  inputSchema: {
    type: 'object',
    properties: {
      job_id: {
        type: 'string',
        description: 'The id of the automation to wait for.',
      },
      reason: COMMON_REASON,
    },
    required: ['job_id', 'reason'],
  },
  category: 'planning',
  permissionLevel: 'write',
  readOnly: false,
  allowInPlanMode: false,
};

export const wakeOnEventSchema: ToolSchema = {
  name: 'wake_on_event',
  description:
    'Park the current task until a named event happens, then continue automatically. '
    + 'Use for "when X happens, do Y" work. Event names are the names of the user\'s automations. '
    + 'For a plain scheduled automation, the event fires every time it finishes a run. '
    + 'For a business-event watcher (e.g. a calendar-conflict or table-change monitor), the event fires only '
    + 'when the watcher actually finds something new — a quiet scheduled check with nothing to report does not fire it. '
    + 'This ends the current turn; nothing runs while you wait.',
  inputSchema: {
    type: 'object',
    properties: {
      event: {
        type: 'string',
        description: 'The event name to wait for — the exact name of the automation that reports it.',
      },
      reason: COMMON_REASON,
    },
    required: ['event', 'reason'],
  },
  category: 'planning',
  permissionLevel: 'write',
  readOnly: false,
  allowInPlanMode: false,
};
