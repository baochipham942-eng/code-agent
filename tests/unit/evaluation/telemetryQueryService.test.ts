import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../src/main/services/infra/logger', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    dispose: vi.fn(),
  },
}));

vi.mock('../../../src/main/services/serviceRegistry', () => ({
  getServiceRegistry: () => ({
    register: vi.fn(),
  }),
}));

vi.unmock('better-sqlite3');
import Database from 'better-sqlite3';
import { buildSessionTraceIdentity } from '../../../src/shared/contract/reviewQueue';
import { getDatabase } from '../../../src/main/services/core/databaseService';
import { getTelemetryQueryService } from '../../../src/main/evaluation/telemetryQueryService';

const dbState = vi.hoisted(() => ({
  sqlite: null as import('better-sqlite3').Database | null,
  getSession: vi.fn(),
  getMessages: vi.fn(),
}));

describe('TelemetryQueryService transcript replay fallback', () => {
  let database: ReturnType<typeof getDatabase>;
  let originalGetDb: typeof database.getDb;
  let originalGetSession: typeof database.getSession;
  let originalGetMessages: typeof database.getMessages;
  let isReadySpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    dbState.sqlite = new Database(':memory:');
    dbState.getSession.mockReset();
    dbState.getMessages.mockReset();

    database = getDatabase();
    originalGetDb = database.getDb.bind(database);
    originalGetSession = database.getSession.bind(database);
    originalGetMessages = database.getMessages.bind(database);
    isReadySpy = vi.spyOn(database, 'isReady', 'get').mockReturnValue(true);

    database.getDb = () => dbState.sqlite;
    database.getSession = dbState.getSession as typeof database.getSession;
    database.getMessages = dbState.getMessages as typeof database.getMessages;
  });

  afterEach(() => {
    if (database) {
      database.getDb = originalGetDb;
      database.getSession = originalGetSession;
      database.getMessages = originalGetMessages;
    }
    isReadySpy?.mockRestore();
    dbState.sqlite?.close();
    dbState.sqlite = null;
  });

  it('falls back to persisted session transcript when telemetry tables are absent', async () => {
    dbState.getSession.mockReturnValue({
      id: 'session-direct-1',
      title: 'Direct Session',
      createdAt: 100,
      updatedAt: 160,
    });
    dbState.getMessages.mockReturnValue([
      {
        id: 'user-1',
        role: 'user',
        content: '只发给 reviewer',
        timestamp: 100,
        metadata: {
          workbench: {
            routingMode: 'direct',
            targetAgentIds: ['agent-reviewer'],
            targetAgentNames: ['reviewer'],
            directRoutingDelivery: {
              deliveredTargetIds: ['agent-reviewer'],
              deliveredTargetNames: ['reviewer'],
            },
          },
        },
      },
      {
        id: 'assistant-1',
        role: 'assistant',
        content: 'reviewer 已接收。',
        timestamp: 160,
      },
    ]);

    const replay = await getTelemetryQueryService().getStructuredReplay('session-direct-1');

    expect(replay).not.toBeNull();
    expect(replay?.traceIdentity).toEqual(buildSessionTraceIdentity('session-direct-1'));
    expect(replay?.summary.totalTurns).toBe(1);
    expect(replay?.turns).toHaveLength(1);
    expect(replay?.turns[0]?.blocks).toEqual([
      {
        type: 'user',
        content: '只发给 reviewer',
        timestamp: 100,
      },
      {
        type: 'text',
        content: 'reviewer 已接收。',
        timestamp: 160,
      },
    ]);
  });
});
