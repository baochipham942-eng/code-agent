// ============================================================================
// Native Calendar Connector - macOS Calendar via AppleScript
// ============================================================================

import type { Connector, ConnectorExecutionResult, ConnectorStatus } from '../base';
import {
  buildAppleScriptDateVar,
  escapeAppleScriptString,
  parseAppleScriptDate,
  runAppleScript,
  sharedAppleScriptHandlers,
} from './osascript';

interface CalendarEventItem {
  uid: string;
  calendar: string;
  title: string;
  startAtMs: number | null;
  endAtMs: number | null;
  location?: string;
}

function parseLine(line: string): string[] {
  return line.split('|').map((part) => part.trim());
}

async function listCalendars(): Promise<string[]> {
  const output = await runAppleScript([
    ...sharedAppleScriptHandlers(),
    'tell application "Calendar"',
    'set outputLines to {}',
    'repeat with cal in every calendar',
    'set end of outputLines to my sanitizeText(name of cal)',
    'end repeat',
    'return my joinLines(outputLines)',
    'end tell',
  ]);

  return output
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
}

async function listEvents(payload: Record<string, unknown>): Promise<CalendarEventItem[]> {
  const calendarName = typeof payload.calendar === 'string' ? payload.calendar.trim() : '';
  const fromMs = typeof payload.from_ms === 'number' ? payload.from_ms : new Date().setHours(0, 0, 0, 0);
  const toMs = typeof payload.to_ms === 'number' ? payload.to_ms : Date.now() + 14 * 24 * 60 * 60 * 1000;
  const limit = typeof payload.limit === 'number' ? payload.limit : 20;

  const lines = [
    ...sharedAppleScriptHandlers(),
    'tell application "Calendar"',
    'set outputLines to {}',
  ];

  if (calendarName) {
    lines.push(`set targetCalendars to {calendar "${escapeAppleScriptString(calendarName)}"}`);
  } else {
    lines.push('set targetCalendars to every calendar');
  }

  lines.push(
    'repeat with cal in targetCalendars',
    'repeat with ev in every event of cal',
    'set eventLine to (uid of ev as text) & "|" & (my sanitizeText(name of cal)) & "|" & (my sanitizeText(summary of ev)) & "|" & (my sanitizeText((start date of ev) as text)) & "|" & (my sanitizeText((end date of ev) as text)) & "|" & (my sanitizeText(location of ev))',
    'set end of outputLines to eventLine',
    'end repeat',
    'end repeat',
    'return my joinLines(outputLines)',
    'end tell'
  );

  const output = await runAppleScript(lines);
  const events = output
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [uid, calendar, title, startRaw, endRaw, location] = parseLine(line);
      return {
        uid,
        calendar,
        title,
        startAtMs: parseAppleScriptDate(startRaw),
        endAtMs: parseAppleScriptDate(endRaw),
        location: location || undefined,
      } satisfies CalendarEventItem;
    })
    .filter((event) => {
      if (event.startAtMs === null && event.endAtMs === null) return true;
      const start = event.startAtMs ?? event.endAtMs ?? 0;
      const end = event.endAtMs ?? event.startAtMs ?? start;
      return end >= fromMs && start <= toMs;
    })
    .sort((a, b) => {
      const aTime = a.startAtMs ?? Number.MAX_SAFE_INTEGER;
      const bTime = b.startAtMs ?? Number.MAX_SAFE_INTEGER;
      return aTime - bTime;
    })
    .slice(0, limit);

  return events;
}

async function createEvent(payload: Record<string, unknown>): Promise<CalendarEventItem> {
  const calendarName = typeof payload.calendar === 'string' ? payload.calendar.trim() : '';
  const title = typeof payload.title === 'string' ? payload.title.trim() : '';
  const startMs = typeof payload.start_ms === 'number' ? payload.start_ms : NaN;
  const endMs = typeof payload.end_ms === 'number' ? payload.end_ms : startMs + 30 * 60 * 1000;
  const location = typeof payload.location === 'string' ? payload.location.trim() : '';

  if (!calendarName) {
    throw new Error('calendar is required for create_event');
  }
  if (!title) {
    throw new Error('title is required for create_event');
  }
  if (!Number.isFinite(startMs)) {
    throw new Error('start_ms is required for create_event');
  }
  if (!Number.isFinite(endMs) || endMs < startMs) {
    throw new Error('end_ms must be greater than or equal to start_ms');
  }

  const propertyParts = [
    `summary:"${escapeAppleScriptString(title)}"`,
    'start date:startDate',
    'end date:endDate',
  ];

  if (location) {
    propertyParts.push(`location:"${escapeAppleScriptString(location)}"`);
  }

  const output = await runAppleScript([
    ...sharedAppleScriptHandlers(),
    ...buildAppleScriptDateVar('startDate', startMs),
    ...buildAppleScriptDateVar('endDate', endMs),
    'tell application "Calendar"',
    `tell calendar "${escapeAppleScriptString(calendarName)}"`,
    `set newEvent to make new event at end with properties {${propertyParts.join(', ')}}`,
    'return (uid of newEvent as text) & "|" & (my sanitizeText(name of calendar of newEvent)) & "|" & (my sanitizeText(summary of newEvent)) & "|" & (my sanitizeText((start date of newEvent) as text)) & "|" & (my sanitizeText((end date of newEvent) as text)) & "|" & (my sanitizeText(location of newEvent))',
    'end tell',
    'end tell',
  ]);

  const [uid, calendar, parsedTitle, startRaw, endRaw, parsedLocation] = parseLine(output);
  return {
    uid,
    calendar,
    title: parsedTitle,
    startAtMs: parseAppleScriptDate(startRaw),
    endAtMs: parseAppleScriptDate(endRaw),
    location: parsedLocation || undefined,
  };
}

async function updateEvent(payload: Record<string, unknown>): Promise<CalendarEventItem> {
  const calendarName = typeof payload.calendar === 'string' ? payload.calendar.trim() : '';
  const eventUid = typeof payload.event_uid === 'string' ? payload.event_uid.trim() : '';
  const hasTitle = typeof payload.title === 'string';
  const title = hasTitle ? (payload.title as string).trim() : '';
  const hasStart = typeof payload.start_ms === 'number' && Number.isFinite(payload.start_ms);
  const startMs = hasStart ? payload.start_ms as number : undefined;
  const hasEnd = typeof payload.end_ms === 'number' && Number.isFinite(payload.end_ms);
  const endMs = hasEnd ? payload.end_ms as number : undefined;
  const hasLocation = Object.prototype.hasOwnProperty.call(payload, 'location') && typeof payload.location === 'string';
  const location = hasLocation ? (payload.location as string).trim() : '';

  if (!calendarName) {
    throw new Error('calendar is required for update_event');
  }
  if (!eventUid) {
    throw new Error('event_uid is required for update_event');
  }
  if (!hasTitle && !hasStart && !hasEnd && !hasLocation) {
    throw new Error('at least one field must be provided for update_event');
  }
  if (hasEnd && !hasStart && typeof endMs === 'number') {
    throw new Error('start_ms is required when end_ms is provided');
  }
  if (typeof startMs === 'number' && typeof endMs === 'number' && endMs < startMs) {
    throw new Error('end_ms must be greater than or equal to start_ms');
  }

  const lines = [
    ...sharedAppleScriptHandlers(),
  ];

  if (typeof startMs === 'number') {
    lines.push(...buildAppleScriptDateVar('startDate', startMs));
  }
  if (typeof endMs === 'number') {
    lines.push(...buildAppleScriptDateVar('endDate', endMs));
  }

  lines.push(
    'tell application "Calendar"',
    `tell calendar "${escapeAppleScriptString(calendarName)}"`,
    `set targetEvent to first event whose uid is "${escapeAppleScriptString(eventUid)}"`,
  );

  if (hasTitle && title) {
    lines.push(`set summary of targetEvent to "${escapeAppleScriptString(title)}"`);
  }
  if (typeof startMs === 'number') {
    lines.push('set start date of targetEvent to startDate');
  }
  if (typeof endMs === 'number') {
    lines.push('set end date of targetEvent to endDate');
  }
  if (hasLocation) {
    lines.push(`set location of targetEvent to "${escapeAppleScriptString(location)}"`);
  }

  lines.push(
    'return (uid of targetEvent as text) & "|" & (my sanitizeText(name of calendar of targetEvent)) & "|" & (my sanitizeText(summary of targetEvent)) & "|" & (my sanitizeText((start date of targetEvent) as text)) & "|" & (my sanitizeText((end date of targetEvent) as text)) & "|" & (my sanitizeText(location of targetEvent))',
    'end tell',
    'end tell',
  );

  const output = await runAppleScript(lines);
  const [uid, calendar, parsedTitle, startRaw, endRaw, parsedLocation] = parseLine(output);
  return {
    uid,
    calendar,
    title: parsedTitle,
    startAtMs: parseAppleScriptDate(startRaw),
    endAtMs: parseAppleScriptDate(endRaw),
    location: parsedLocation || undefined,
  };
}

export const calendarConnector: Connector = {
  id: 'calendar',
  label: 'Calendar',
  capabilities: ['get_status', 'list_calendars', 'list_events', 'create_event', 'update_event'],
  async getStatus(): Promise<ConnectorStatus> {
    try {
      const calendars = await listCalendars();
      return {
        connected: true,
        detail: `可访问 ${calendars.length} 个日历`,
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
      case 'list_calendars': {
        const calendars = await listCalendars();
        return {
          data: calendars,
          summary: calendars.length > 0 ? `找到 ${calendars.length} 个日历` : '没有找到可访问的日历',
        };
      }
      case 'list_events': {
        const events = await listEvents(payload);
        return {
          data: events,
          summary: events.length > 0 ? `找到 ${events.length} 条日历事件` : '没有找到匹配的日历事件',
        };
      }
      case 'create_event': {
        const event = await createEvent(payload);
        return {
          data: event,
          summary: `已创建日历事件：${event.title}`,
        };
      }
      case 'update_event': {
        const event = await updateEvent(payload);
        return {
          data: event,
          summary: `已更新日历事件：${event.title}`,
        };
      }
      default:
        throw new Error(`Unsupported calendar action: ${action}`);
    }
  },
};
