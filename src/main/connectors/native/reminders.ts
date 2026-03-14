// ============================================================================
// Native Reminders Connector - macOS Reminders via AppleScript
// ============================================================================

import type { Connector, ConnectorExecutionResult, ConnectorStatus } from '../base';
import {
  buildAppleScriptDateVar,
  escapeAppleScriptString,
  runAppleScript,
  sharedAppleScriptHandlers,
} from './osascript';

interface ReminderItem {
  id: string;
  list: string;
  title: string;
  completed: boolean;
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
  ];

  if (listName) {
    lines.push(`set targetLists to {list "${escapeAppleScriptString(listName)}"}`);
  } else {
    lines.push('set targetLists to every list');
  }

  lines.push(
    'repeat with reminderList in targetLists',
    'repeat with reminderItem in every reminder of reminderList',
    'set reminderLine to (id of reminderItem as text) & "|" & (my sanitizeText(name of reminderList)) & "|" & (my sanitizeText(name of reminderItem)) & "|" & (completed of reminderItem as text)',
    'set end of outputLines to reminderLine',
    'end repeat',
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
      const [id, list, title, completedRaw] = parseLine(line);
      return {
        id,
        list,
        title,
        completed: completedRaw === 'true',
      } satisfies ReminderItem;
    })
    .filter((item) => includeCompleted || !item.completed)
    .slice(0, limit);
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

export const remindersConnector: Connector = {
  id: 'reminders',
  label: 'Reminders',
  capabilities: ['get_status', 'list_lists', 'list_reminders', 'create_reminder', 'update_reminder'],
  async getStatus(): Promise<ConnectorStatus> {
    try {
      const lists = await listReminderLists();
      return {
        connected: true,
        detail: `可访问 ${lists.length} 个提醒列表`,
        capabilities: this.capabilities,
      };
    } catch (error) {
      return {
        connected: false,
        detail: error instanceof Error ? error.message : String(error),
        capabilities: this.capabilities,
      };
    }
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
      default:
        throw new Error(`Unsupported reminders action: ${action}`);
    }
  },
};
