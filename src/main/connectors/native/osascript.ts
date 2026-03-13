// ============================================================================
// AppleScript helpers for native macOS office connectors
// ============================================================================

import { execFile } from 'child_process';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

const MAX_BUFFER = 1024 * 1024 * 10;
const DEFAULT_TIMEOUT = 15_000;

export async function runAppleScript(lines: string[]): Promise<string> {
  const args = lines.flatMap((line) => ['-e', line]);
  const { stdout } = await execFileAsync('osascript', args, {
    timeout: DEFAULT_TIMEOUT,
    maxBuffer: MAX_BUFFER,
  });
  return stdout.trim();
}

export function escapeAppleScriptString(value: string): string {
  return value
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"');
}

export function parseAppleScriptDate(value: string): number | null {
  const match = value.match(
    /^(?:[A-Za-z]+,\s+)?([A-Za-z]+)\s+(\d{1,2}),\s+(\d{4})\s+at\s+(\d{1,2}):(\d{2}):(\d{2})$/
  );
  if (!match) return null;

  const [, monthName, day, year, hour, minute, second] = match;
  const monthMap: Record<string, number> = {
    January: 0,
    February: 1,
    March: 2,
    April: 3,
    May: 4,
    June: 5,
    July: 6,
    August: 7,
    September: 8,
    October: 9,
    November: 10,
    December: 11,
  };

  const month = monthMap[monthName];
  if (month === undefined) return null;

  return new Date(
    Number(year),
    month,
    Number(day),
    Number(hour),
    Number(minute),
    Number(second)
  ).getTime();
}

export function buildAppleScriptDateVar(varName: string, timestampMs: number): string[] {
  const date = new Date(timestampMs);
  const monthNames = [
    'January',
    'February',
    'March',
    'April',
    'May',
    'June',
    'July',
    'August',
    'September',
    'October',
    'November',
    'December',
  ];

  const midnightSeconds =
    (date.getHours() * 60 * 60)
    + (date.getMinutes() * 60)
    + date.getSeconds();

  return [
    `set ${varName} to current date`,
    `set year of ${varName} to ${date.getFullYear()}`,
    `set month of ${varName} to ${monthNames[date.getMonth()]}`,
    `set day of ${varName} to ${date.getDate()}`,
    `set time of ${varName} to ${midnightSeconds}`,
  ];
}

export function sharedAppleScriptHandlers(): string[] {
  return [
    'on sanitizeText(valueText)',
    'if valueText is missing value then return ""',
    'set safeText to valueText as text',
    'set {oldTID, AppleScript\'s text item delimiters} to {AppleScript\'s text item delimiters, {"|", return, linefeed, tab}}',
    'set safeText to (text items of safeText) as text',
    'set AppleScript\'s text item delimiters to " "',
    'set safeText to safeText as text',
    'set AppleScript\'s text item delimiters to oldTID',
    'return safeText',
    'end sanitizeText',
    'on joinLines(lineItems)',
    'set {oldTID, AppleScript\'s text item delimiters} to {AppleScript\'s text item delimiters, linefeed}',
    'set joinedText to lineItems as text',
    'set AppleScript\'s text item delimiters to oldTID',
    'return joinedText',
    'end joinLines',
  ];
}
