import express from 'express';
import http from 'node:http';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.unmock('better-sqlite3');
import Database from 'better-sqlite3';
import type BetterSqlite3 from 'better-sqlite3';

import type { QueuedInput } from '../../../src/shared/contract/queuedInput';
import { IPC_DOMAINS } from '../../../src/shared/ipc';
import type { WebRouteHandler } from '../../../src/web/routes/routeTypes';

const databaseState = vi.hoisted(() => ({
  db: null as BetterSqlite3.Database | null,
}));

vi.mock('../../../src/host/services/core/databaseService', () => ({
  getDatabase: () => ({ getDb: () => databaseState.db }),
}));

vi.mock('../../../src/host/services/infra/logger', () => ({
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

import { registerQueuedInputHandlers } from '../../../src/host/ipc/queuedInput.ipc';
import { createDomainRouter } from '../../../src/web/routes/domain';

interface SuccessResponse<T> {
  success: true;
  data: T;
}

function createSchema(db: BetterSqlite3.Database): void {
  db.exec(`
    CREATE TABLE queued_inputs (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      envelope_json TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'queued',
      retry_count INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE INDEX idx_queued_inputs_session
      ON queued_inputs (session_id, status, created_at);
  `);
}

async function readJson<T>(response: Response): Promise<T> {
  return response.json() as Promise<T>;
}

describe('queued input domain router', () => {
  const handlers = new Map<string, WebRouteHandler>();
  const logger = { warn: vi.fn(), error: vi.fn() };
  let db: BetterSqlite3.Database;
  let server: http.Server | undefined;
  let baseUrl = '';

  beforeEach(async () => {
    db = new Database(':memory:');
    createSchema(db);
    databaseState.db = db;
    handlers.clear();
    registerQueuedInputHandlers({
      handle: (channel: string, handler: WebRouteHandler) => handlers.set(channel, handler),
    } as never);

    const app = express();
    app.use(express.json());
    app.use('/api', createDomainRouter({ handlers, logger }));
    server = await new Promise<http.Server>((resolve) => {
      const started = app.listen(0, '127.0.0.1', () => resolve(started));
    });
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Expected TCP test server address');
    baseUrl = `http://127.0.0.1:${address.port}`;
  });

  afterEach(async () => {
    if (server) {
      await new Promise<void>((resolve, reject) => {
        server?.close((error) => error ? reject(error) : resolve());
      });
    }
    server = undefined;
    baseUrl = '';
    databaseState.db = null;
    db.close();
  });

  it('通过共享 handlers 完成 enqueue、list、retract 的真实 HTTP round-trip', async () => {
    expect(handlers.has(IPC_DOMAINS.QUEUED_INPUT)).toBe(true);

    const enqueueResponse = await fetch(`${baseUrl}/api/domain/queuedInput/enqueue`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        payload: {
          id: 'http-input-1',
          sessionId: 'http-session-1',
          envelope: { content: 'queued over HTTP' },
        },
      }),
    });
    expect(enqueueResponse.status).toBe(200);
    const enqueued = await readJson<SuccessResponse<QueuedInput>>(enqueueResponse);
    expect(enqueued).toMatchObject({
      success: true,
      data: {
        id: 'http-input-1',
        sessionId: 'http-session-1',
        envelope: { content: 'queued over HTTP' },
        status: 'queued',
        retryCount: 0,
      },
    });

    const storedAfterEnqueue = db.prepare(`
      SELECT id, session_id, envelope_json, status, retry_count
      FROM queued_inputs WHERE id = ?
    `).get('http-input-1') as {
      id: string;
      session_id: string;
      envelope_json: string;
      status: string;
      retry_count: number;
    };
    expect(storedAfterEnqueue).toEqual({
      id: 'http-input-1',
      session_id: 'http-session-1',
      envelope_json: JSON.stringify({ content: 'queued over HTTP' }),
      status: 'queued',
      retry_count: 0,
    });

    const listResponse = await fetch(`${baseUrl}/api/domain/queuedInput/list`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ payload: { sessionId: 'http-session-1' } }),
    });
    expect(listResponse.status).toBe(200);
    const listed = await readJson<SuccessResponse<QueuedInput[]>>(listResponse);
    expect(listed.data).toHaveLength(1);
    expect(listed.data[0]).toMatchObject({
      id: 'http-input-1',
      envelope: { content: 'queued over HTTP' },
      status: 'queued',
    });

    const retractResponse = await fetch(`${baseUrl}/api/domain/queuedInput/retract`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ payload: { id: 'http-input-1' } }),
    });
    expect(retractResponse.status).toBe(200);
    await expect(readJson<SuccessResponse<{ retracted: boolean }>>(retractResponse))
      .resolves.toEqual({ success: true, data: { retracted: true } });

    const storedAfterRetract = db.prepare(
      'SELECT status FROM queued_inputs WHERE id = ?',
    ).get('http-input-1') as { status: string };
    expect(storedAfterRetract.status).toBe('retracted');
  });
});
