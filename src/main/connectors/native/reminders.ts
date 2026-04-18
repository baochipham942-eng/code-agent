// ============================================================================
// Native Reminders Connector - macOS Reminders via AppleScript
// ============================================================================

import type { Connector, ConnectorExecutionResult, ConnectorStatus } from '../base';
import {
  buildAppleScriptDateVar,
  escapeAppleScriptString,
  parseAppleScriptDate,
  runAppleScript,
  sharedAppleScriptHandlers,
} from './osascript';

interface ReminderItem {
  id: string;
  list: string;
  title: string;
  completed: boolean;
  notes?: string;
  remindAtMs?: number | null;
}

function parseLine(line: string): string[] {
  return line.split('|').map((part) => part.trim());
}

async function listReminderLists(): Promise<string[]> {
  const output = await runAppleScript([
    ...sharedAppleScriptHandlers(),
    'tell application "Reminders"',
    'set outputLines to {}',
    'repeat with reminderList in every list',
    'set end of outputLines to my sanitizeText(name of reminderList)',
    'end repeat',
    'return my joinLines(outputLines)',
    'end tell',
  ]);

  return output
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
}

async function listReminders(payload: Record<string, unknown>): Promise<ReminderItem[]> {
  const listName = typeof payload.list === 'string' ? payload.list.trim() : '';
  const includeCompleted = payload.include_completed === true;
  const limit = typeof payload.limit === 'number' ? payload.limit : 20;

  const lines = [
    ...sharedAppleScriptHandlers(),
    'tell application "Reminders"',
    'set outputLines to {}',
    `set reminderLimit to ${Math.max(1, Math.min(limit, 200))}`,
    'set emittedCount to 0',
  ];

  if (listName) {
    lines.push(`set targetLists to {list "${escapeAppleScriptString(listName)}"}`);
  } else {
    lines.push('set targetLists to every list');
  }

  lines.push(
    'repeat with reminderList in targetLists',
    includeCompleted
      ? 'set matchingReminders to every reminder of reminderList'
      : 'set matchingReminders to every reminder of reminderList whose completed is false',
    'repeat with reminderItem in matchingReminders',
    'set rawNotes to ""',
    'try',
    'set rawNotes to body of reminderItem',
    'end try',
    'set reminderNotes to my sanitizeText(rawNotes)',
    'set rawRemindDate to ""',
    'try',
    'set rawRemindDate to remind me date of reminderItem',
    'end try',
    'set remindDateText to my sanitizeText(rawRemindDate)',
    'set reminderLine to (id of reminderItem as text) & "|" & (my sanitizeText(name of reminderList)) & "|" & (my sanitizeText(name of reminderItem)) & "|" & (completed of reminderItem as text) & "|" & reminderNotes & "|" & remindDateText',
    'set end of outputLines to reminderLine',
    'set emittedCount to emittedCount + 1',
    'if emittedCount >= reminderLimit then exit repeat',
    'end repeat',
    'if emittedCount >= reminderLimit then exit repeat',
    'end repeat',
    'return my joinLines(outputLines)',
    'end tell'
  );

  const output = await runAppleScript(lines);
  return output
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [id, list, title, completedRaw, notes, remindAtRaw] = parseLine(line);
      return {
        id,
        list,
        title,
        completed: completedRaw === 'true',
        notes: notes || undefined,
        remindAtMs: parseAppleScriptDate(remindAtRaw),
      } satisfies ReminderItem;
    });
}

async function createReminder(payload: Record<string, unknown>): Promise<ReminderItem> {
  const listName = typeof payload.list === 'string' ? payload.list.trim() : '';
  const title = typeof payload.title === 'string' ? payload.title.trim() : '';
  const notes = typeof payload.notes === 'string' ? payload.notes.trim() : '';
  const remindAtMs = typeof payload.remind_at_ms === 'number' ? payload.remind_at_ms : undefined;

  if (!listName) {
    throw new Error('list is required for create_reminder');
  }
  if (!title) {
    throw new Error('title is required for create_reminder');
  }

  const lines = [
    ...sharedAppleScriptHandlers(),
  ];

  if (typeof remindAtMs === 'number' && Number.isFinite(remindAtMs)) {
    lines.push(...buildAppleScriptDateVar('remindDate', remindAtMs));
  }

  lines.push(
    'tell application "Reminders"',
    `tell list "${escapeAppleScriptString(listName)}"`,
    `set newReminder to make new reminder with properties {name:"${escapeAppleScriptString(title)}"}`,
  );

  if (notes) {
    lines.push(`set body of newReminder to "${escapeAppleScriptString(notes)}"`);
  }
  if (typeof remindAtMs === 'number' && Number.isFinite(remindAtMs)) {
    lines.push('set remind me date of newReminder to remindDate');
  }

  lines.push(
    'return (id of newReminder as text) & "|" & (my sanitizeText(name of list of newReminder)) & "|" & (my sanitizeText(name of newReminder)) & "|" & (completed of newReminder as text)',
    'end tell',
    'end tell'
  );

  const output = await runAppleScript(lines);
  const [id, list, parsedTitle, completedRaw] = parseLine(output);
  return {
    id,
    list,
    title: parsedTitle,
    completed: completedRaw === 'true',
  };
}

async function updateReminder(payload: Record<string, unknown>): Promise<ReminderItem> {
  const listName = typeof payload.list === 'string' ? payload.list.trim() : '';
  const reminderId = typeof payload.reminder_id === 'string' ? payload.reminder_id.trim() : '';
  const hasTitle = typeof payload.title === 'string';
  const title = hasTitle ? (payload.title as string).trim() : '';
  const hasNotes = Object.prototype.hasOwnProperty.call(payload, 'notes') && typeof payload.notes === 'string';
  const notes = hasNotes ? (payload.notes as string) : '';
  const hasCompleted = typeof payload.completed === 'boolean';
  const completed = hasCompleted ? payload.completed : false;
  const hasRemindAt = typeof payload.remind_at_ms === 'number' && Number.isFinite(payload.remind_at_ms);
  const remindAtMs = hasRemindAt ? payload.remind_at_ms as number : undefined;
  const clearRemindAt = payload.clear_remind_at === true;

  if (!listName) {
    throw new Error('list is required for update_reminder');
  }
  if (!reminderId) {
    throw new Error('reminder_id is required for update_reminder');
  }
  if (!hasTitle && !hasNotes && !hasCompleted && !hasRemindAt && !clearRemindAt) {
    throw new Error('at least one field must be provided for update_reminder');
  }

  const lines = [
    ...sharedAppleScriptHandlers(),
  ];

  if (typeof remindAtMs === 'number') {
    lines.push(...buildAppleScriptDateVar('remindDate', remindAtMs));
  }

  lines.push(
    'tell application "Reminders"',
    `tell list "${escapeAppleScriptString(listName)}"`,
    `set targetReminder to first reminder whose id is "${escapeAppleScriptString(reminderId)}"`,
  );

  if (hasTitle && title) {
    lines.push(`set name of targetReminder to "${escapeAppleScriptString(title)}"`);
  }
  if (hasNotes) {
    lines.push(`set body of targetReminder to "${escapeAppleScriptString(notes)}"`);
  }
  if (typeof remindAtMs === 'number') {
    lines.push('set remind me date of targetReminder to remindDate');
  }
  if (clearRemindAt) {
    lines.push('set remind me date of targetReminder to missing value');
  }
  if (hasCompleted) {
    lines.push(`set completed of targetReminder to ${completed ? 'true' : 'false'}`);
  }

  lines.push(
    'return (id of targetReminder as text) & "|" & (my sanitizeText(name of list of targetReminder)) & "|" & (my sanitizeText(name of targetReminder)) & "|" & (completed of targetReminder as text)',
    'end tell',
    'end tell',
  );

  const output = await runAppleScript(lines);
  const [id, list, parsedTitle, completedRaw] = parseLine(output);
  return {
    id,
    list,
    title: parsedTitle,
    completed: completedRaw === 'true',
  };
}

async function deleteReminder(payload: Record<string, unknown>): Promise<{
  id: string;
  list: string;
  title: string;
  deleted: boolean;
}> {
  const listName = typeof payload.list === 'string' ? payload.list.trim() : '';
  const reminderId = typeof payload.reminder_id === 'string' ? payload.reminder_id.trim() : '';

  if (!listName) {
    throw new Error('list is required for delete_reminder');
  }
  if (!reminderId) {
    throw new Error('reminder_id is required for delete_reminder');
  }

  const output = await runAppleScript([
    ...sharedAppleScriptHandlers(),
    'tell application "Reminders"',
    `tell list "${escapeAppleScriptString(listName)}"`,
    `set targetReminder to first reminder whose id is "${escapeAppleScriptString(reminderId)}"`,
    'set reminderTitle to my sanitizeText(name of targetReminder)',
    'delete targetReminder',
    'return reminderTitle',
    'end tell',
    'end tell',
  ]);

  return {
    id: reminderId,
    list: listName,
    title: output,
    deleted: true,
  };
}

export const remindersConnector: Connector = {
  id: 'reminders',
  label: 'Reminders',
  capabilities: ['get_status', 'list_lists', 'list_reminders', 'create_reminder', 'update_reminder', 'delete_reminder'],
  async getStatus(): Promise<ConnectorStatus> {
    // Keep startup status checks side-effect free. Enumerating reminder lists
    // via AppleScript will auto-launch Reminders, so the real probe moves to
    // first use.
    return {
      connected: process.platform === 'darwin',
      detail: process.platform === 'darwin'
        ? '按需访问本地 Reminders；为避免启动时拉起 Reminders，列表探测改为首轮使用时执行。'
        : 'Reminders connector 仅在 macOS 可用。',
      capabilities: this.capabilities,
    };
  },
  async execute(action: string, payload: Record<string, unknown>): Promise<ConnectorExecutionResult> {
    switch (action) {
      case 'get_status':
        return { data: await this.getStatus() };
      case 'list_lists': {
        const lists = await listReminderLists();
        return {
          data: lists,
          summary: lists.length > 0 ? `找到 ${lists.length} 个提醒列表` : '没有找到可访问的提醒列表',
        };
      }
      case 'list_reminders': {
        const reminders = await listReminders(payload);
        return {
          data: reminders,
          summary: reminders.length > 0 ? `找到 ${reminders.length} 条提醒` : '没有找到匹配的提醒',
        };
      }
      case 'create_reminder': {
        const reminder = await createReminder(payload);
        return {
          data: reminder,
          summary: `已创建提醒：${reminder.title}`,
        };
      }
      case 'update_reminder': {
        const reminder = await updateReminder(payload);
        return {
          data: reminder,
          summary: `已更新提醒：${reminder.title}`,
        };
      }
      case 'delete_reminder': {
        const reminder = await deleteReminder(payload);
        return {
          data: reminder,
          summary: `已删除提醒：${reminder.title}`,
        };
      }
      default:
        throw new Error(`Unsupported reminders action: ${action}`);
    }
  },
};
