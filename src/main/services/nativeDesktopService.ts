// ============================================================================
// NativeDesktopService - 原生桌面活动查询服务
// ============================================================================

import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFileSync } from 'child_process';
import { app } from '../platform';
import { getUserConfigDir } from '../config/configPaths';
import { createLogger } from './infra/logger';
import type {
  AudioSegment,
  DesktopActivityEvent,
  DesktopActivityStats,
  DesktopCollectorStatus,
  DesktopSearchQuery,
  DesktopSearchResult,
  DesktopTimelineQuery,
} from '@shared/types';

const logger = createLogger('NativeDesktopService');

const DEFAULT_STATUS: DesktopCollectorStatus = {
  running: false,
  phase: 'p1_background_collector',
  intervalSecs: 30,
  captureScreenshots: true,
  redactSensitiveContexts: true,
  retentionDays: 7,
  dedupeWindowSecs: 60,
  maxRecentEvents: 20,
  totalEventsWritten: 0,
};

export class NativeDesktopService {
  private resolveCandidateRoots(): string[] {
    const roots = new Set<string>();
    const envRoot = process.env.CODE_AGENT_DATA_DIR;
    const userData = app?.getPath?.('userData');
    const home = os.homedir();

    if (envRoot) roots.add(envRoot);
    if (userData) roots.add(userData);
    if (home) {
      roots.add(getUserConfigDir());
      roots.add(path.join(home, 'Library', 'Application Support', 'code-agent'));
    }

    return Array.from(roots);
  }

  private resolveDesktopRoot(): string {
    for (const root of this.resolveCandidateRoots()) {
      const candidate = path.join(root, 'native-desktop');
      if (fs.existsSync(candidate)) {
        return candidate;
      }
    }

    const fallbackBase = process.env.CODE_AGENT_DATA_DIR
      || app?.getPath?.('userData')
      || getUserConfigDir();
    return path.join(fallbackBase, 'native-desktop');
  }

  private getEventsDir(): string {
    return path.join(this.resolveDesktopRoot(), 'events');
  }

  private getStatusFile(): string {
    return path.join(this.resolveDesktopRoot(), 'collector-status.json');
  }

  private getSqliteDbPath(): string {
    return path.join(this.resolveDesktopRoot(), 'desktop-activity.sqlite3');
  }

  private listEventFiles(): string[] {
    const eventsDir = this.getEventsDir();
    if (!fs.existsSync(eventsDir)) return [];

    return fs.readdirSync(eventsDir)
      .filter((file) => file.endsWith('.jsonl'))
      .sort()
      .reverse()
      .map((file) => path.join(eventsDir, file));
  }

  private parseEventLine(line: string): DesktopActivityEvent | null {
    try {
      return JSON.parse(line) as DesktopActivityEvent;
    } catch (error) {
      logger.warn('Failed to parse desktop activity line', { error: String(error) });
      return null;
    }
  }

  private loadEventsFromSqlite(limit?: number): DesktopActivityEvent[] {
    const sqlitePath = this.getSqliteDbPath();
    if (!fs.existsSync(sqlitePath)) return [];

    const max = limit && limit > 0 ? limit : 200;

    try {
      const output = execFileSync(
        'sqlite3',
        [
          '-json',
          sqlitePath,
          `SELECT raw_json FROM desktop_activity_events ORDER BY captured_at_ms DESC LIMIT ${Math.max(1, Math.floor(max))};`,
        ],
        { encoding: 'utf-8' }
      ).trim();

      if (!output) return [];

      const rows = JSON.parse(output) as Array<{ raw_json?: string }>;
      return rows
        .map((row) => (row.raw_json ? this.parseEventLine(row.raw_json) : null))
        .filter((event): event is DesktopActivityEvent => event !== null);
    } catch (error) {
      logger.warn('Failed to load desktop activity from sqlite', { error: String(error) });
      return [];
    }
  }

  private loadEvents(limit?: number): DesktopActivityEvent[] {
    const max = limit && limit > 0 ? limit : Number.POSITIVE_INFINITY;
    const sqliteEvents = this.loadEventsFromSqlite(limit);
    if (sqliteEvents.length > 0) {
      return sqliteEvents.slice(0, Number.isFinite(max) ? max : sqliteEvents.length);
    }

    const events: DesktopActivityEvent[] = [];

    for (const file of this.listEventFiles()) {
      if (events.length >= max) break;
      const content = fs.readFileSync(file, 'utf-8');
      const lines = content.split('\n').filter(Boolean).reverse();
      for (const line of lines) {
        if (events.length >= max) break;
        const event = this.parseEventLine(line);
        if (event) {
          events.push(event);
        }
      }
    }

    return events;
  }

  private filterTimeline(events: DesktopActivityEvent[], query: DesktopTimelineQuery = {}): DesktopActivityEvent[] {
    const from = query.from ?? 0;
    const to = query.to ?? Number.MAX_SAFE_INTEGER;
    const appName = query.appName?.trim().toLowerCase();

    return events
      .filter((event) => event.capturedAtMs >= from && event.capturedAtMs <= to)
      .filter((event) => !appName || event.appName.toLowerCase() === appName)
      .filter((event) => (query.hasUrl ? !!event.browserUrl : true))
      .slice(0, query.limit || 100);
  }

  private scoreSearch(event: DesktopActivityEvent, query: string): number {
    const haystack = [
      event.appName,
      event.bundleId,
      event.windowTitle,
      event.browserUrl,
      event.browserTitle,
      event.documentPath,
      event.analyzeText,
      event.sessionState,
      event.powerSource,
      event.fingerprint,
    ]
      .filter(Boolean)
      .join('\n')
      .toLowerCase();

    if (!haystack.includes(query)) return 0;
    if (event.browserUrl?.toLowerCase().includes(query)) return 1.0;
    if (event.windowTitle?.toLowerCase().includes(query)) return 0.9;
    if (event.appName.toLowerCase().includes(query)) return 0.8;
    return 0.6;
  }

  getStatus(): DesktopCollectorStatus {
    const statusFile = this.getStatusFile();
    const eventDir = this.getEventsDir();
    const baseStatus: DesktopCollectorStatus = {
      ...DEFAULT_STATUS,
      eventDir,
      screenshotDir: path.join(this.resolveDesktopRoot(), 'screenshots'),
      eventsFile: undefined,
      sqliteDbPath: path.join(this.resolveDesktopRoot(), 'desktop-activity.sqlite3'),
    };

    if (!fs.existsSync(statusFile)) {
      return baseStatus;
    }

    try {
      const parsed = JSON.parse(fs.readFileSync(statusFile, 'utf-8')) as DesktopCollectorStatus;
      return {
        ...baseStatus,
        ...parsed,
      };
    } catch (error) {
      logger.warn('Failed to read desktop collector status', { error: String(error) });
      return {
        ...baseStatus,
        lastError: `Failed to parse collector status: ${String(error)}`,
      };
    }
  }

  listRecent(limit = 10): DesktopActivityEvent[] {
    return this.loadEvents(limit);
  }

  getCurrentContext(): DesktopActivityEvent | null {
    return this.loadEvents(1)[0] || null;
  }

  getTimeline(query: DesktopTimelineQuery = {}): DesktopActivityEvent[] {
    return this.filterTimeline(this.loadEvents(query.limit || 200), query);
  }

  search(query: DesktopSearchQuery): DesktopSearchResult[] {
    const normalized = query.query.trim().toLowerCase();
    if (!normalized) return [];

    const filtered = this.filterTimeline(this.loadEvents(query.limit || 200), query);

    return filtered
      .map((event) => ({
        event,
        score: this.scoreSearch(event, normalized),
      }))
      .filter((result) => result.score > 0)
      .sort((a, b) => b.score - a.score || b.event.capturedAtMs - a.event.capturedAtMs)
      .slice(0, query.limit || 20);
  }

  listAudioSegments(from: number, to: number): AudioSegment[] {
    const sqlitePath = this.getSqliteDbPath();
    if (!fs.existsSync(sqlitePath)) return [];

    try {
      const output = execFileSync(
        'sqlite3',
        [
          '-json',
          sqlitePath,
          `SELECT id, start_at_ms, end_at_ms, duration_ms, wav_path, transcript, speaker_id, asr_engine FROM audio_segments WHERE start_at_ms >= ${from} AND start_at_ms < ${to} AND transcript IS NOT NULL AND transcript != '' ORDER BY start_at_ms ASC LIMIT 200;`,
        ],
        { encoding: 'utf-8' }
      ).trim();
      if (!output) return [];
      return JSON.parse(output) as AudioSegment[];
    } catch {
      return [];
    }
  }

  getStats(query: DesktopTimelineQuery = {}): DesktopActivityStats {
    const events = this.getTimeline({ ...query, limit: query.limit || 1000 });
    const byAppMap = new Map<string, number>();

    for (const event of events) {
      byAppMap.set(event.appName, (byAppMap.get(event.appName) || 0) + 1);
    }

    return {
      totalEvents: events.length,
      uniqueApps: byAppMap.size,
      withUrls: events.filter((event) => !!event.browserUrl).length,
      firstEventAtMs: events.length > 0 ? events[events.length - 1]?.capturedAtMs : null,
      lastEventAtMs: events.length > 0 ? events[0]?.capturedAtMs : null,
      byApp: Array.from(byAppMap.entries())
        .map(([appName, count]) => ({ appName, count }))
        .sort((a, b) => b.count - a.count),
    };
  }
}

let instance: NativeDesktopService | null = null;

export function getNativeDesktopService(): NativeDesktopService {
  if (!instance) {
    instance = new NativeDesktopService();
  }
  return instance;
}
