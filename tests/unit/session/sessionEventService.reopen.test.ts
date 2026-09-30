import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

vi.unmock('better-sqlite3');

vi.hoisted(() => {
  delete process.env.CODE_AGENT_CLI_MODE;
  process.env.CODE_AGENT_WEB_MODE = '1';
});

const databaseState = vi.hoisted(() => ({
  service: null as import('../../../src/host/services/core/databaseService').DatabaseService | null,
}));

vi.mock('../../../src/host/services/core/databaseService', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/host/services/core/databaseService')>();
  return {
    ...actual,
    getDatabase: () => {
      if (!databaseState.service) throw new Error('test database is not ready');
      return databaseState.service;
    },
  };
});

import { DatabaseService } from '../../../src/host/services/core/databaseService';
import { getSessionEventService } from '../../../src/host/session/sessionEventService';

describe('SessionEventService database handle lifecycle', () => {
  let dataDir: string;
  let database: DatabaseService | null = null;

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'session-events-reopen-'));
  });

  afterEach(async () => {
    await getSessionEventService().dispose();
    database?.close();
    database = null;
    databaseState.service = null;
    rmSync(dataDir, { recursive: true, force: true });
  });

  it('writes events after the database service closes and reopens its handle', async () => {
    database = new DatabaseService(dataDir);
    await database.initialize();
    databaseState.service = database;
    database.createSessionWithId('session-reopen', {
      title: 'session reopen',
      modelConfig: { provider: 'openai', model: 'test-model' },
    });

    const eventService = getSessionEventService();
    eventService.saveEvent('session-reopen', { type: 'agent_complete', data: null });
    expect(database.getDb()?.prepare('SELECT COUNT(*) AS count FROM session_events').get()).toEqual({ count: 1 });

    database.close();
    database = new DatabaseService(dataDir);
    await database.initialize();
    databaseState.service = database;

    eventService.saveEvent('session-reopen', { type: 'agent_complete', data: null });

    expect(database.getDb()?.prepare('SELECT COUNT(*) AS count FROM session_events').get()).toEqual({ count: 2 });
  });
});
