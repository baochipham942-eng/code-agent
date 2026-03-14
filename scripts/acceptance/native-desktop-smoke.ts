import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFileSync } from 'child_process';
import type { DesktopActivityEvent, DesktopCollectorStatus } from '../../src/shared/types/desktop.ts';
import {
  finishWithError,
  formatTimestamp,
  getBooleanOption,
  getNumberOption,
  getStringOption,
  hasFlag,
  parseArgs,
  printJson,
  printKeyValue,
} from './_helpers.ts';

interface SqliteStats {
  totalEvents: number;
  lastEventAtMs: number | null;
}

function usage(): void {
  console.log(`Native desktop smoke

Usage:
  npm run acceptance:native-desktop -- [options]

Options:
  --root <path>                Native desktop root. Defaults to auto-detect.
  --min-events <number>        Minimum expected events. Default: 1.
  --freshness-minutes <number> Latest event must be newer than this. Default: 60.
  --require-running <bool>     Require collector status running=true. Default: false.
  --skip-sqlite                Skip sqlite validation.
  --json                       Print JSON only.
  --help                       Show this help.

Examples:
  npm run acceptance:native-desktop -- --require-running true
  npm run acceptance:native-desktop -- --root ~/.code-agent/native-desktop --freshness-minutes 15`);
}

function candidateRoots(): string[] {
  const roots = new Set<string>();
  const envRoot = process.env.CODE_AGENT_DATA_DIR;
  const home = os.homedir();

  if (envRoot) roots.add(path.join(envRoot, 'native-desktop'));
  roots.add(path.join(home, '.code-agent', 'native-desktop'));
  roots.add(path.join(home, 'Library', 'Application Support', 'code-agent', 'native-desktop'));

  return Array.from(roots);
}

function resolveRoot(rootOverride?: string): string {
  if (rootOverride) {
    return path.resolve(rootOverride.replace(/^~(?=$|\/)/, os.homedir()));
  }

  const found = candidateRoots().find((candidate) => fs.existsSync(candidate));
  if (!found) {
    return candidateRoots()[0];
  }
  return found;
}

function readJsonFile<T>(filePath: string): T | null {
  if (!fs.existsSync(filePath)) return null;
  return JSON.parse(fs.readFileSync(filePath, 'utf-8')) as T;
}

function readLatestJsonlEvent(eventsDir: string): DesktopActivityEvent | null {
  if (!fs.existsSync(eventsDir)) return null;

  const files = fs.readdirSync(eventsDir)
    .filter((file) => file.endsWith('.jsonl'))
    .sort()
    .reverse();

  for (const file of files) {
    const filePath = path.join(eventsDir, file);
    const lines = fs.readFileSync(filePath, 'utf-8')
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
      .reverse();

    for (const line of lines) {
      try {
        return JSON.parse(line) as DesktopActivityEvent;
      } catch {
        // Skip malformed line and continue.
      }
    }
  }

  return null;
}

function readSqliteStats(sqlitePath: string): SqliteStats | null {
  if (!fs.existsSync(sqlitePath)) return null;

  try {
    const output = execFileSync(
      'sqlite3',
      [
        '-json',
        sqlitePath,
        'SELECT COUNT(*) AS totalEvents, MAX(captured_at_ms) AS lastEventAtMs FROM desktop_activity_events;',
      ],
      { encoding: 'utf-8' }
    ).trim();

    if (!output) return null;
    const rows = JSON.parse(output) as Array<{ totalEvents?: number; lastEventAtMs?: number | null }>;
    const row = rows[0] || {};
    return {
      totalEvents: row.totalEvents ?? 0,
      lastEventAtMs: row.lastEventAtMs ?? null,
    };
  } catch (error) {
    throw new Error(`Failed to inspect sqlite3 database: ${error instanceof Error ? error.message : String(error)}`);
  }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (hasFlag(args, 'help')) {
    usage();
    return;
  }

  const root = resolveRoot(getStringOption(args, 'root'));
  const minEvents = getNumberOption(args, 'min-events') ?? 1;
  const freshnessMinutes = getNumberOption(args, 'freshness-minutes') ?? 60;
  const requireRunning = getBooleanOption(args, 'require-running') ?? false;
  const skipSqlite = hasFlag(args, 'skip-sqlite');
  const statusPath = path.join(root, 'collector-status.json');
  const eventsDir = path.join(root, 'events');
  const sqlitePath = path.join(root, 'desktop-activity.sqlite3');

  const status = readJsonFile<DesktopCollectorStatus>(statusPath);
  const latestEvent = readLatestJsonlEvent(eventsDir);
  const sqliteStats = skipSqlite ? null : readSqliteStats(sqlitePath);
  const latestTimestamp = Math.max(
    status?.lastEventAtMs ?? 0,
    latestEvent?.capturedAtMs ?? 0,
    sqliteStats?.lastEventAtMs ?? 0
  );

  const totalEvents = Math.max(
    status?.totalEventsWritten ?? 0,
    sqliteStats?.totalEvents ?? 0,
    latestEvent ? 1 : 0
  );

  const failures: string[] = [];

  if (!fs.existsSync(root)) failures.push(`Native desktop root does not exist: ${root}`);
  if (!status) failures.push(`Missing collector status file: ${statusPath}`);
  if (!fs.existsSync(eventsDir)) failures.push(`Missing events directory: ${eventsDir}`);
  if (requireRunning && status?.running !== true) failures.push('Collector is not running.');
  if (totalEvents < minEvents) failures.push(`Expected at least ${minEvents} events, got ${totalEvents}.`);
  if (latestTimestamp === 0) {
    failures.push('No latest event timestamp found from status / JSONL / SQLite.');
  } else if (Date.now() - latestTimestamp > freshnessMinutes * 60 * 1000) {
    failures.push(`Latest event is older than ${freshnessMinutes} minutes.`);
  }
  if (!skipSqlite && !sqliteStats) failures.push(`SQLite stats unavailable: ${sqlitePath}`);

  const result = {
    ok: failures.length === 0,
    root,
    statusPath,
    eventsDir,
    sqlitePath,
    status,
    sqliteStats,
    latestEvent,
    latestTimestamp,
    totalEvents,
    failures,
  };

  if (hasFlag(args, 'json')) {
    printJson(result);
  } else {
    printKeyValue('Native Desktop Smoke Summary', [
      ['root', root],
      ['collectorRunning', status?.running ?? null],
      ['statusFile', fs.existsSync(statusPath)],
      ['eventsDir', fs.existsSync(eventsDir)],
      ['sqliteFile', fs.existsSync(sqlitePath)],
      ['totalEvents', totalEvents],
      ['latestEventAt', formatTimestamp(latestTimestamp || null)],
      ['latestApp', latestEvent?.appName ?? null],
      ['latestWindow', latestEvent?.windowTitle ?? null],
      ['latestUrl', latestEvent?.browserUrl ?? null],
    ]);

    if (sqliteStats) {
      printKeyValue('SQLite Stats', [
        ['totalEvents', sqliteStats.totalEvents],
        ['lastEventAt', formatTimestamp(sqliteStats.lastEventAtMs)],
      ]);
    }

    if (failures.length > 0) {
      console.log('\nFailures');
      for (const failure of failures) {
        console.log(`- ${failure}`);
      }
    } else {
      console.log('\nSmoke passed.');
    }
  }

  if (failures.length > 0) {
    process.exit(1);
  }
}

main().catch(finishWithError);
