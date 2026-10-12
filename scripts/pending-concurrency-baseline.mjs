import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';

const DEFAULT_DB_PATH = path.join(os.homedir(), '.code-agent', 'code-agent.db');
const WAIT_NOTE =
  'For approvals paired to tool_call_end, wait is an upper bound because tool execution follows approval; timeout verdicts end at their verdict.';

function usage() {
  return [
    'Usage: node scripts/pending-concurrency-baseline.mjs [--db <path>] [--since <epoch-ms-or-ISO>] [--json]',
    '  --db <path>                  SQLite database (default: ~/.code-agent/code-agent.db)',
    '  --since <epoch-ms-or-ISO>    Include rows at or after this timestamp',
    '  --json                       Print machine-readable JSON',
  ].join('\n');
}

function parseSince(value) {
  if (/^-?\d+$/u.test(value)) {
    const epoch = Number(value);
    if (Number.isSafeInteger(epoch)) return epoch;
  }

  const parsed = Date.parse(value);
  if (Number.isFinite(parsed)) return parsed;
  throw new Error(`Invalid --since value: ${value}`);
}

function parseArgs(argv) {
  const options = { dbPath: DEFAULT_DB_PATH, since: null, json: false };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--json') {
      options.json = true;
      continue;
    }
    if (argument === '--db' || argument === '--since') {
      const value = argv[index + 1];
      if (!value || value.startsWith('--')) throw new Error(`${argument} requires a value`);
      index += 1;
      if (argument === '--db') options.dbPath = path.resolve(value);
      else options.since = parseSince(value);
      continue;
    }
    throw new Error(`Unknown argument: ${argument}`);
  }
  return options;
}

function parseEventData(raw) {
  if (typeof raw !== 'string') return null;
  try {
    const value = JSON.parse(raw);
    return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
  } catch {
    return null;
  }
}

function compareRows(left, right) {
  return left.timestamp - right.timestamp || left.id - right.id;
}

function findClosingRow(rows, opening, openingIndex) {
  for (let index = openingIndex + 1; index < rows.length; index += 1) {
    const row = rows[index];
    if (row.session_id !== opening.sessionId) continue;
    const data = parseEventData(row.event_data);
    if (row.event_type === 'tool_call_end'
      && opening.toolCallId
      && data?.toolCallId === opening.toolCallId) {
      return row;
    }
    if (row.event_type === 'permission_request'
      && data?.resolved === true
      && opening.requestId
      && data.id === opening.requestId) {
      return row;
    }
  }
  return null;
}

function nearestRank(values, percentile) {
  if (values.length === 0) return null;
  return values[Math.ceil(values.length * percentile) - 1];
}

function mergeSessionIntervals(intervals) {
  const bySession = new Map();
  for (const interval of intervals) {
    const sessionIntervals = bySession.get(interval.sessionId) ?? [];
    sessionIntervals.push(interval);
    bySession.set(interval.sessionId, sessionIntervals);
  }

  const merged = [];
  for (const sessionIntervals of bySession.values()) {
    sessionIntervals.sort((left, right) => left.start - right.start || left.end - right.end);
    let current = null;
    for (const interval of sessionIntervals) {
      if (!current || interval.start > current.end) {
        if (current) merged.push(current);
        current = { ...interval };
      } else {
        current.end = Math.max(current.end, interval.end);
      }
    }
    if (current) merged.push(current);
  }
  return merged;
}

function concurrencyStats(intervals) {
  const events = new Map();
  for (const interval of intervals) {
    if (interval.end <= interval.start) continue;
    const startEvent = events.get(interval.start) ?? { starts: [], ends: [] };
    startEvent.starts.push(interval.sessionId);
    events.set(interval.start, startEvent);
    const endEvent = events.get(interval.end) ?? { starts: [], ends: [] };
    endEvent.ends.push(interval.sessionId);
    events.set(interval.end, endEvent);
  }

  const times = [...events.keys()].sort((left, right) => left - right);
  const active = new Set();
  let totalPendingTimeMs = 0;
  let overlapDurationMs = 0;
  let overlapWindows = 0;
  let maxSimultaneousSessions = 0;
  let previousActiveCount = 0;

  for (let index = 0; index < times.length; index += 1) {
    const time = times[index];
    const event = events.get(time);
    for (const sessionId of event.ends) active.delete(sessionId);
    for (const sessionId of event.starts) active.add(sessionId);
    if (previousActiveCount < 2 && active.size >= 2) overlapWindows += 1;
    maxSimultaneousSessions = Math.max(maxSimultaneousSessions, active.size);
    const nextTime = times[index + 1];
    if (nextTime === undefined) {
      previousActiveCount = active.size;
      continue;
    }
    const duration = nextTime - time;
    if (active.size > 0) totalPendingTimeMs += duration;
    if (active.size >= 2) overlapDurationMs += duration;
    previousActiveCount = active.size;
  }

  return {
    overlapWindows,
    overlapDurationMs,
    totalPendingTimeMs,
    overlapShare: totalPendingTimeMs === 0 ? 0 : overlapDurationMs / totalPendingTimeMs,
    maxSimultaneousSessions,
  };
}

function analyzeRows(rows) {
  const orderedRows = [...rows].sort(compareRows);
  const openings = [];
  for (let index = 0; index < orderedRows.length; index += 1) {
    const row = orderedRows[index];
    if (row.event_type !== 'permission_request') continue;
    const data = parseEventData(row.event_data);
    if (data?.resolved === true) continue;
    const requestId = typeof data?.id === 'string' ? data.id : null;
    const toolCallId = typeof data?.parentToolUseId === 'string' && data.parentToolUseId
      ? data.parentToolUseId
      : requestId;
    // Keep the database session_id as the identity used for concurrency.
    const sessionId = row.session_id;
    const closingRow = findClosingRow(orderedRows, { sessionId, requestId, toolCallId }, index);
    openings.push({
      sessionId,
      start: row.timestamp,
      end: closingRow?.timestamp ?? null,
    });
  }

  const paired = openings.filter((opening) => opening.end !== null);
  const waits = paired
    .map((opening) => opening.end - opening.start)
    .sort((left, right) => left - right);
  const intervals = mergeSessionIntervals(paired);
  const concurrency = concurrencyStats(intervals);

  return {
    totalRequests: openings.length,
    pairedRequests: paired.length,
    unpairedRequests: openings.length - paired.length,
    waitMs: {
      p50: nearestRank(waits, 0.5),
      p90: nearestRank(waits, 0.9),
    },
    concurrency,
    waitNote: WAIT_NOTE,
  };
}

function readReport(options) {
  const database = new Database(options.dbPath, { readonly: true, fileMustExist: true });
  try {
    const baseQuery = `
      SELECT id, session_id, event_type, event_data, timestamp
      FROM session_events
    `;
    const statement = options.since === null
      ? database.prepare(`${baseQuery} ORDER BY timestamp ASC, id ASC`)
      : database.prepare(`${baseQuery} WHERE timestamp >= ? ORDER BY timestamp ASC, id ASC`);
    const rows = options.since === null ? statement.all() : statement.all(options.since);
    return analyzeRows(rows);
  } finally {
    database.close();
  }
}

function formatHuman(report) {
  const percentage = (report.concurrency.overlapShare * 100).toFixed(2);
  return [
    `Total permission requests: ${report.totalRequests}`,
    `Paired: ${report.pairedRequests}`,
    `Unpaired: ${report.unpairedRequests} (excluded from wait and overlap statistics)`,
    `Wait P50: ${report.waitMs.p50 ?? 'n/a'} ms`,
    `Wait P90: ${report.waitMs.p90 ?? 'n/a'} ms`,
    `Overlap windows (>=2 distinct sessions): ${report.concurrency.overlapWindows}`,
    `Overlap duration: ${report.concurrency.overlapDurationMs} ms`,
    `Total pending time: ${report.concurrency.totalPendingTimeMs} ms`,
    `Overlap share of total pending time: ${percentage}%`,
    `Max simultaneous sessions: ${report.concurrency.maxSimultaneousSessions}`,
    `Note: ${report.waitNote}`,
  ].join('\n');
}

function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  const report = readReport(options);
  process.stdout.write(options.json ? `${JSON.stringify(report, null, 2)}\n` : `${formatHuman(report)}\n`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (error) {
    console.error(`[pending-concurrency-baseline] ${error instanceof Error ? error.message : String(error)}`);
    console.error(usage());
    process.exitCode = 1;
  }
}
