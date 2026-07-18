import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.unmock('better-sqlite3');
import Database from 'better-sqlite3';
import type BetterSqlite3 from 'better-sqlite3';

import type { QueuedInput } from '../../../src/shared/contract/queuedInput';
import { QUEUED_INPUT_RETRY } from '../../../src/shared/constants/queuedInput';
import { IPC_DOMAINS, type IPCRequest, type IPCResponse } from '../../../src/shared/ipc';
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

describe('queued input IPC', () => {
  const handlers = new Map<string, WebRouteHandler>();
  let db: BetterSqlite3.Database;

  beforeEach(() => {
    db = new Database(':memory:');
    createSchema(db);
    databaseState.db = db;
    handlers.clear();
    registerQueuedInputHandlers({
      handle: (channel: string, handler: WebRouteHandler) => handlers.set(channel, handler),
    } as never);
  });

  afterEach(() => {
    databaseState.db = null;
    db.close();
  });

  async function invoke(request: IPCRequest): Promise<IPCResponse> {
    const handler = handlers.get(IPC_DOMAINS.QUEUED_INPUT);
    if (!handler) throw new Error('queued input handler not registered');
    return await handler(null, request) as IPCResponse;
  }

  async function enqueue(
    id: string,
    envelope: QueuedInput['envelope'] = { content: `message-${id}` },
    sessionId = 'session-1',
  ): Promise<IPCResponse> {
    return invoke({ action: 'enqueue', payload: { id, sessionId, envelope } });
  }

  it('enqueue 返回还原后的 envelope 对象和 queued 状态', async () => {
    const response = await enqueue('input-1', {
      content: 'hello',
      context: { runtimeInput: { mode: 'supplement', delivery: 'queued_next_turn' } },
    });

    expect(response.success).toBe(true);
    expect(response.data).toMatchObject({
      id: 'input-1',
      sessionId: 'session-1',
      envelope: {
        content: 'hello',
        context: { runtimeInput: { mode: 'supplement', delivery: 'queued_next_turn' } },
      },
      status: 'queued',
      retryCount: 0,
    });
    expect(typeof (response.data as QueuedInput).envelope).toBe('object');
  });

  it('重复 enqueue 同一 id 时不覆盖已有记录', async () => {
    await enqueue('input-1', { content: 'first' }, 'session-first');
    const duplicate = await enqueue('input-1', { content: 'replacement' }, 'session-second');

    expect(duplicate.success).toBe(true);
    expect(duplicate.data).toMatchObject({
      id: 'input-1',
      sessionId: 'session-first',
      envelope: { content: 'first' },
      status: 'queued',
    });
  });

  it('list 返回 session 内记录并支持 status 过滤', async () => {
    await enqueue('queued-input');
    await enqueue('sending-input');
    await invoke({ action: 'markSending', payload: { id: 'sending-input' } });

    const all = await invoke({ action: 'list', payload: { sessionId: 'session-1' } });
    const queued = await invoke({
      action: 'list',
      payload: { sessionId: 'session-1', status: 'queued' },
    });
    const sending = await invoke({
      action: 'list',
      payload: { sessionId: 'session-1', status: 'sending' },
    });

    expect((all.data as QueuedInput[]).map((item) => item.id)).toEqual([
      'queued-input',
      'sending-input',
    ]);
    expect((queued.data as QueuedInput[]).map((item) => item.id)).toEqual(['queued-input']);
    expect((sending.data as QueuedInput[]).map((item) => item.id)).toEqual(['sending-input']);
  });

  it('retract 对 queued 返回 true，对 sending 返回 false', async () => {
    await enqueue('queued-input');
    await enqueue('sending-input');
    await invoke({ action: 'markSending', payload: { id: 'sending-input' } });

    await expect(invoke({ action: 'retract', payload: { id: 'queued-input' } }))
      .resolves.toEqual({ success: true, data: { retracted: true } });
    await expect(invoke({ action: 'retract', payload: { id: 'sending-input' } }))
      .resolves.toEqual({ success: true, data: { retracted: false } });
  });

  it('markSending 首次返回 true，重复调用返回 false', async () => {
    await enqueue('input-1');

    await expect(invoke({ action: 'markSending', payload: { id: 'input-1' } }))
      .resolves.toEqual({ success: true, data: { marked: true } });
    await expect(invoke({ action: 'markSending', payload: { id: 'input-1' } }))
      .resolves.toEqual({ success: true, data: { marked: false } });
  });

  it('reportSendOutcome success 将 sending 转为 consumed', async () => {
    await enqueue('input-1');
    await invoke({ action: 'markSending', payload: { id: 'input-1' } });

    const response = await invoke({
      action: 'reportSendOutcome',
      payload: { id: 'input-1', outcome: 'success' },
    });

    expect(response).toEqual({
      success: true,
      data: { status: 'consumed', retryCount: 0 },
    });
    const listed = await invoke({
      action: 'list',
      payload: { sessionId: 'session-1', status: 'consumed' },
    });
    expect((listed.data as QueuedInput[]).map((item) => item.id)).toEqual(['input-1']);
  });

  it('reportSendOutcome failure 未超限时重新 queued 并递增 retryCount', async () => {
    await enqueue('input-1');
    await invoke({ action: 'markSending', payload: { id: 'input-1' } });

    await expect(invoke({
      action: 'reportSendOutcome',
      payload: { id: 'input-1', outcome: 'failure' },
    })).resolves.toEqual({
      success: true,
      data: { status: 'queued', retryCount: 1 },
    });
  });

  it('连续失败超过重试上限后进入 failed，后续上报返回 INVALID_STATE', async () => {
    await enqueue('input-1');

    let lastResponse: IPCResponse | null = null;
    for (let attempt = 1; attempt <= QUEUED_INPUT_RETRY.MAX_RESEND_ATTEMPTS + 1; attempt += 1) {
      const marked = await invoke({ action: 'markSending', payload: { id: 'input-1' } });
      expect(marked).toEqual({ success: true, data: { marked: true } });
      lastResponse = await invoke({
        action: 'reportSendOutcome',
        payload: { id: 'input-1', outcome: 'failure' },
      });
    }

    expect(lastResponse).toEqual({
      success: true,
      data: {
        status: 'failed',
        retryCount: QUEUED_INPUT_RETRY.MAX_RESEND_ATTEMPTS + 1,
      },
    });
    await expect(invoke({
      action: 'reportSendOutcome',
      payload: { id: 'input-1', outcome: 'failure' },
    })).resolves.toMatchObject({
      success: false,
      error: { code: 'INVALID_STATE' },
    });
  });

  it('reportSendOutcome 拒绝尚未 markSending 的 queued 行', async () => {
    await enqueue('input-1');

    await expect(invoke({
      action: 'reportSendOutcome',
      payload: { id: 'input-1', outcome: 'failure' },
    })).resolves.toMatchObject({
      success: false,
      error: { code: 'INVALID_STATE' },
    });
  });

  it('unknown action 在 schema 层返回 INVALID_PAYLOAD', async () => {
    await expect(invoke({ action: 'unknownAction', payload: {} })).resolves.toMatchObject({
      success: false,
      error: { code: 'INVALID_PAYLOAD' },
    });
  });
});
