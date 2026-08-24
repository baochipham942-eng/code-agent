import type { Connector } from '../../../connectors';

interface CalendarEventBeforeSnapshot {
  uid: string;
  calendar: string;
  title: string;
  startAtMs: number;
  endAtMs: number;
  location?: string;
  notes?: string;
  url?: string;
}

interface ReminderBeforeSnapshot {
  id: string;
  list: string;
  title: string;
  completed: boolean;
  notes?: string;
  remindAtMs: number | null;
}

type UndoMetadata<T> =
  | { undoable: true; before: T }
  | { undoable: false; undoUnavailableReason: string };

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

export async function captureCalendarBefore(
  connector: Connector,
  args: Record<string, unknown>,
): Promise<UndoMetadata<CalendarEventBeforeSnapshot>> {
  try {
    const result = await connector.execute('get_event', args);
    const event = result.data;
    if (
      !isRecord(event)
      || typeof event.uid !== 'string'
      || event.uid.length === 0
      || typeof event.calendar !== 'string'
      || event.calendar.length === 0
      || typeof event.title !== 'string'
      || typeof event.startAtMs !== 'number'
      || !Number.isFinite(event.startAtMs)
      || typeof event.endAtMs !== 'number'
      || !Number.isFinite(event.endAtMs)
    ) {
      return {
        undoable: false,
        undoUnavailableReason: 'Calendar event before snapshot was incomplete.',
      };
    }

    return {
      undoable: true,
      before: {
        uid: event.uid,
        calendar: event.calendar,
        title: event.title,
        startAtMs: event.startAtMs,
        endAtMs: event.endAtMs,
        ...(typeof event.location === 'string' ? { location: event.location } : {}),
        ...(typeof event.notes === 'string' ? { notes: event.notes } : {}),
        ...(typeof event.url === 'string' ? { url: event.url } : {}),
      },
    };
  } catch (error) {
    return {
      undoable: false,
      undoUnavailableReason: `Calendar event before snapshot unavailable: ${errorMessage(error)}`,
    };
  }
}

export async function captureReminderBefore(
  connector: Connector,
  args: Record<string, unknown>,
): Promise<UndoMetadata<ReminderBeforeSnapshot>> {
  try {
    const result = await connector.execute('get_reminder', args);
    const reminder = result.data;
    if (
      !isRecord(reminder)
      || typeof reminder.id !== 'string'
      || reminder.id.length === 0
      || typeof reminder.list !== 'string'
      || reminder.list.length === 0
      || typeof reminder.title !== 'string'
      || typeof reminder.completed !== 'boolean'
      || (
        reminder.remindAtMs !== null
        && (typeof reminder.remindAtMs !== 'number' || !Number.isFinite(reminder.remindAtMs))
      )
    ) {
      return {
        undoable: false,
        undoUnavailableReason: 'Reminder before snapshot was incomplete.',
      };
    }

    return {
      undoable: true,
      before: {
        id: reminder.id,
        list: reminder.list,
        title: reminder.title,
        completed: reminder.completed,
        ...(typeof reminder.notes === 'string' ? { notes: reminder.notes } : {}),
        remindAtMs: reminder.remindAtMs,
      },
    };
  } catch (error) {
    return {
      undoable: false,
      undoUnavailableReason: `Reminder before snapshot unavailable: ${errorMessage(error)}`,
    };
  }
}
