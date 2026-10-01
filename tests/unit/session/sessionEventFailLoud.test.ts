// Session event writes must fail loud, and the liveness probe must notice a stall.
// SQLite stays in-memory. Never open a user database.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.unmock('better-sqlite3');
import Database from 'better-sqlite3';
import type BetterSqlite3 from 'better-sqlite3';
import type { AgentEvent } from '../../../src/shared/contract';
import { applyTestSessionSchema } from '../../utils/applyTestSessionSchema';

const { warn, getDatabase, logger } = vi.hoisted(() => {
  const warn = vi.fn();
  const logger = {
    debug: vi.fn(),
    info: vi.fn(),
    warn,
    error: vi.fn(),
    dispose: vi.fn(async () => undefined),
  };
  return { warn, getDatabase: vi.fn(), logger };
});

vi.mock('../../../src/host/services/infra/logger', () => ({
  createLogger: () => logger,
  logger,
}));

vi.mock('../../../src/host/services/core/databaseService', () => ({
  getDatabase,
}));

const MINUTE_MS = 60 * 1000;
const NOW = 1_700_000_000_000;
const SAMPLE_EVENT: AgentEvent = { type: 'error', data: { message: 'boom' } };

const openDbs: BetterSqlite3.Database[] = [];
let nextMessageId = 0;

function createMemoryDb(): BetterSqlite3.Database {
  const db = new Database(':memory:');
  applyTestSessionSchema(db);
  db.pragma('foreign_keys = ON');
  openDbs.push(db);
  return db;
}

function ensureSession(db: BetterSqlite3.Database, id = 's1'): void {
  db.prepare(
    `INSERT OR IGNORE INTO sessions (id, title, model_provider, model_name, created_at, updated_at)
     VALUES (?, 'probe', 'test', 'test', ?, ?)`,
  ).run(id, NOW, NOW);
}

function insertMessage(db: BetterSqlite3.Database, timestamp: number): void {
  ensureSession(db);
  nextMessageId += 1;
  db.prepare(
    'INSERT INTO messages (id, session_id, role, content, timestamp) VALUES (?, ?, ?, ?, ?)',
  ).run(`m${nextMessageId}`, 's1', 'user', 'hello', timestamp);
}

function insertEvent(db: BetterSqlite3.Database, timestamp: number): void {
  ensureSession(db);
  db.prepare(
    "INSERT INTO session_events (session_id, event_type, event_data, timestamp) VALUES ('s1', 'error', NULL, ?)",
  ).run(timestamp);
}

async function loadService() {
  vi.resetModules();
  return import('../../../src/host/session/sessionEventService');
}

function useDatabase(db: BetterSqlite3.Database | null, ready = true): void {
  getDatabase.mockReturnValue({
    isReady: ready,
    getDb: () => db,
  });
}

beforeEach(() => {
  warn.mockReset();
  getDatabase.mockReset();
});

afterEach(() => {
  vi.restoreAllMocks();
  for (const db of openDbs) {
    try { db.close(); } catch { /* already closed */ }
  }
  openDbs.length = 0;
});

describe('saveEvent failures', () => {
  it('saveEvent warns with the cause and rate-limits 250 failures to 3 logs', async () => {
    useDatabase(null, false);
    const { getSessionEventService } = await loadService();
    const service = getSessionEventService();
    const save = () => {
      expect(() => service.saveEvent('sid-1', SAMPLE_EVENT)).not.toThrow();
    };

    save();
    expect(warn).toHaveBeenCalledTimes(1);
    for (let i = 0; i < 98; i += 1) save();
    expect(warn).toHaveBeenCalledTimes(1);
    save();
    expect(warn).toHaveBeenCalledTimes(2);
    for (let i = 0; i < 99; i += 1) save();
    expect(warn).toHaveBeenCalledTimes(2);
    save();
    expect(warn).toHaveBeenCalledTimes(3);
    for (let i = 0; i < 50; i += 1) save();
    expect(warn).toHaveBeenCalledTimes(3);

    expect(service.getSaveFailureStatus()).toEqual({
      failureCount: 250,
      lastErrorMessage: 'Database not initialized',
    });
    for (const call of warn.mock.calls) {
      expect(call[0]).toBe('Failed to save event');
      expect(call[1]).toMatchObject({
        sessionId: 'sid-1',
        eventType: 'error',
        error: 'Database not initialized',
        cause: 'Database not initialized',
      });
      expect(typeof call[1].stack).toBe('string');
    }
  });

  it('warns and counts a foreign-key violation without throwing', async () => {
    const db = createMemoryDb();
    useDatabase(db);
    const { getSessionEventService } = await loadService();
    const service = getSessionEventService();

    expect(() => service.saveEvent('missing-session', SAMPLE_EVENT)).not.toThrow();

    expect(service.getSaveFailureStatus().failureCount).toBe(1);
    expect(service.getSaveFailureStatus().lastErrorMessage).toContain('FOREIGN KEY constraint failed');
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][1]).toMatchObject({
      sessionId: 'missing-session',
      eventType: 'error',
      cause: expect.stringContaining('FOREIGN KEY constraint failed'),
    });
  });

  it('warns and counts a prepared statement throw, including its cause', async () => {
    const cause = new Error('sqlite step failed');
    const failure = new Error('prepared statement failed');
    failure.cause = cause;
    getDatabase.mockReturnValue({
      isReady: true,
      getDb: () => ({
        prepare: () => ({
          run: () => { throw failure; },
        }),
      }),
    });
    const { getSessionEventService } = await loadService();
    const service = getSessionEventService();

    expect(() => service.saveEvent('sid-1', SAMPLE_EVENT)).not.toThrow();

    expect(service.getSaveFailureStatus()).toEqual({
      failureCount: 1,
      lastErrorMessage: 'prepared statement failed',
    });
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][1]).toMatchObject({
      sessionId: 'sid-1',
      eventType: 'error',
      error: 'prepared statement failed',
      cause: 'sqlite step failed',
    });
    expect(typeof warn.mock.calls[0][1].stack).toBe('string');
  });

  it('stores an event when the session row exists', async () => {
    const db = createMemoryDb();
    ensureSession(db);
    useDatabase(db);
    const { getSessionEventService } = await loadService();
    const service = getSessionEventService();

    expect(() => service.saveEvent('s1', SAMPLE_EVENT)).not.toThrow();

    const row = db.prepare('SELECT session_id, event_type FROM session_events').get() as {
      session_id: string;
      event_type: string;
    };
    expect(row).toEqual({ session_id: 's1', event_type: 'error' });
    expect(warn).not.toHaveBeenCalled();
    expect(service.getSaveFailureStatus()).toEqual({
      failureCount: 0,
      lastErrorMessage: null,
    });
  });
});

describe('session event liveness probe', () => {
  async function probe(db: BetterSqlite3.Database, thresholdMinutes = 30) {
    const { getSessionEventService } = await loadService();
    return getSessionEventService().probeSessionEventLiveness(db, NOW, thresholdMinutes);
  }

  it('reports stalled and logs when messages are recent and no event exists', async () => {
    const db = createMemoryDb();
    insertMessage(db, NOW - 90 * MINUTE_MS);
    insertMessage(db, NOW - MINUTE_MS);

    const report = await probe(db);

    expect(report).toEqual({
      stalled: true,
      lastMessageAt: NOW - MINUTE_MS,
      lastEventAt: null,
      minutesSinceLastEvent: null,
    });
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(
      'messages are being written but no session event has been written for 30 minutes',
      expect.objectContaining({
        stalled: true,
        lastMessageAt: NOW - MINUTE_MS,
        lastEventAt: null,
        minutesSinceLastEvent: null,
        thresholdMinutes: 30,
      }),
    );
  });

  it('reports stalled when the newest event id is older than the threshold', async () => {
    const db = createMemoryDb();
    insertMessage(db, NOW - MINUTE_MS);
    // Higher id wins over a more recent timestamp on an earlier row.
    insertEvent(db, NOW - MINUTE_MS);
    insertEvent(db, NOW - 31 * MINUTE_MS);

    const report = await probe(db);

    expect(report).toEqual({
      stalled: true,
      lastMessageAt: NOW - MINUTE_MS,
      lastEventAt: NOW - 31 * MINUTE_MS,
      minutesSinceLastEvent: 31,
    });
    expect(warn.mock.calls[0][0]).toBe(
      'messages are being written but no session event has been written for 30 minutes',
    );
  });

  it('does not stall when the latest event is recent', async () => {
    const db = createMemoryDb();
    insertMessage(db, NOW - MINUTE_MS);
    insertEvent(db, NOW - 31 * MINUTE_MS);
    insertEvent(db, NOW - MINUTE_MS);

    const report = await probe(db);

    expect(report).toEqual({
      stalled: false,
      lastMessageAt: NOW - MINUTE_MS,
      lastEventAt: NOW - MINUTE_MS,
      minutesSinceLastEvent: 1,
    });
    expect(warn).not.toHaveBeenCalled();
  });

  it('does not stall an idle system with no recent messages', async () => {
    const idle = createMemoryDb();
    insertMessage(idle, NOW - 31 * MINUTE_MS);
    insertEvent(idle, NOW - 90 * MINUTE_MS);

    const old = await probe(idle);
    expect(old.stalled).toBe(false);
    expect(old.lastMessageAt).toBe(NOW - 31 * MINUTE_MS);
    expect(warn).not.toHaveBeenCalled();

    warn.mockClear();
    const empty = createMemoryDb();
    const none = await probe(empty);
    expect(none).toEqual({
      stalled: false,
      lastMessageAt: null,
      lastEventAt: null,
      minutesSinceLastEvent: null,
    });
    expect(warn).not.toHaveBeenCalled();
  });

  it('treats a message exactly N minutes old as recent and an event exactly N minutes old as not older', async () => {
    const onThreshold = createMemoryDb();
    insertMessage(onThreshold, NOW - 30 * MINUTE_MS);
    insertEvent(onThreshold, NOW - 30 * MINUTE_MS);
    expect((await probe(onThreshold)).stalled).toBe(false);
    expect(warn).not.toHaveBeenCalled();

    const justOver = createMemoryDb();
    insertMessage(justOver, NOW - 30 * MINUTE_MS);
    insertEvent(justOver, NOW - 30 * MINUTE_MS - 1);
    expect((await probe(justOver)).stalled).toBe(true);
  });
});

describe('startSessionEventLivenessProbe', () => {
  it('is idempotent, unrefs the timer, and swallows probe errors', async () => {
    const { startSessionEventLivenessProbe } = await loadService();
    const unref = vi.fn();
    let tick: (() => void) | undefined;
    const setIntervalSpy = vi.spyOn(globalThis, 'setInterval').mockImplementation(((handler: TimerHandler) => {
      tick = typeof handler === 'function' ? () => { handler(); } : undefined;
      return { unref } as unknown as ReturnType<typeof setInterval>;
    }) as unknown as typeof setInterval);

    startSessionEventLivenessProbe();
    startSessionEventLivenessProbe();

    expect(setIntervalSpy).toHaveBeenCalledTimes(1);
    expect(setIntervalSpy).toHaveBeenCalledWith(expect.any(Function), 10 * 60 * 1000);
    expect(unref).toHaveBeenCalledTimes(1);
    if (!tick) throw new Error('timer callback was not captured');
    const runTick = tick;

    useDatabase(null, false);
    expect(() => runTick()).not.toThrow();
    expect(warn).not.toHaveBeenCalled();

    getDatabase.mockReturnValue({
      isReady: true,
      getDb: () => ({
        prepare: () => { throw new Error('sql broke'); },
      }),
    });
    expect(() => runTick()).not.toThrow();
    expect(warn).toHaveBeenCalledWith(
      'session event liveness probe failed',
      expect.objectContaining({
        error: 'sql broke',
        cause: 'sql broke',
      }),
    );

    warn.mockImplementation(() => { throw new Error('log failed'); });
    expect(() => runTick()).not.toThrow();
  });
});
