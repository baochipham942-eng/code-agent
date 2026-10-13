import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.unmock('better-sqlite3');
import Database from 'better-sqlite3';
import type BetterSqlite3 from 'better-sqlite3';

import type { QueuedInput } from '../../../src/shared/contract/queuedInput';
import type { ConversationModelSpec } from '../../../src/shared/contract/conversationEnvelope';
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
import { QueuedInputRepository } from '../../../src/host/services/core/repositories/QueuedInputRepository';
import { SessionDelegationRepository } from '../../../src/host/services/core/repositories/SessionDelegationRepository';
import { applySessionDelegationsSchema } from '../../../src/host/services/core/database/schemaSessionDelegations';
import { commitDelegation } from '../../../src/host/services/delegation/delegationDelivery';
import { createQueuedInputDelegationGuard } from '../../../src/host/services/delegation/delegationDrainHooks';
import { deriveActionFingerprint, deriveSubmissionKey } from '../../../src/host/services/delegation/delegationKeys';

const delegationSchemaLogger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
} as unknown as Parameters<typeof applySessionDelegationsSchema>[1];

function createSchema(db: BetterSqlite3.Database): void {
  db.exec(`
    CREATE TABLE queued_inputs (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      envelope_json TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'queued',
      retry_count INTEGER NOT NULL DEFAULT 0,
      position INTEGER NOT NULL DEFAULT 0,
      paused_reason TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE INDEX idx_queued_inputs_session
      ON queued_inputs (session_id, status, created_at);
  `);
  applySessionDelegationsSchema(db, delegationSchemaLogger);
}

describe('queued input IPC', () => {
  const handlers = new Map<string, WebRouteHandler>();
  let db: BetterSqlite3.Database;
  let currentModelSpec: ConversationModelSpec | undefined;
  let activeRun = false;
  const sendNow = vi.fn();

  beforeEach(() => {
    db = new Database(':memory:');
    createSchema(db);
    databaseState.db = db;
    handlers.clear();
    currentModelSpec = undefined;
    activeRun = false;
    sendNow.mockReset().mockResolvedValue('sent');
    registerQueuedInputHandlers({
      handle: (channel: string, handler: WebRouteHandler) => handlers.set(channel, handler),
    } as never, {
      resolveModelSpec: () => currentModelSpec,
      hasActiveRun: () => activeRun,
      sendNow,
    });
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
      context: { runtimeInput: { mode: 'supplement' } },
    });

    expect(response.success).toBe(true);
    expect(response.data).toMatchObject({
      id: 'input-1',
      sessionId: 'session-1',
      envelope: {
        content: 'hello',
        context: { runtimeInput: { mode: 'supplement' } },
      },
      status: 'queued',
      retryCount: 0,
    });
    expect(typeof (response.data as QueuedInput).envelope).toBe('object');
  });

  it('enqueue 在 host 侧把活跃 run 的显式模型写入 envelope', async () => {
    currentModelSpec = { provider: 'xiaomi', model: 'mimo-v2.5-pro' };

    const response = await enqueue('input-model-stamped', {
      content: 'keep the active model',
      options: {
        mode: 'normal',
        modelSpec: { provider: 'untrusted', model: 'renderer-value' },
      },
    });

    expect(response.success).toBe(true);
    expect((response.data as QueuedInput).envelope.options).toEqual({
      mode: 'normal',
      modelSpec: { provider: 'xiaomi', model: 'mimo-v2.5-pro' },
    });
  });

  it('enqueue 在纯默认模型会话不固化 modelSpec', async () => {
    const response = await enqueue('input-default-model', {
      content: 'follow future defaults',
      options: {
        mode: 'normal',
        modelSpec: { provider: 'untrusted', model: 'renderer-value' },
      },
    });

    expect(response.success).toBe(true);
    expect((response.data as QueuedInput).envelope.options).toEqual({ mode: 'normal' });
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

  it('update 只修改 queued 行的 envelope 文本并保留其余字段', async () => {
    await enqueue('editable', {
      content: 'before',
      context: { runtimeInput: { mode: 'supplement' } },
    });
    const updated = await invoke({
      action: 'update',
      payload: { id: 'editable', content: 'after' },
    });
    expect(updated).toMatchObject({
      success: true,
      data: {
        updated: true,
        input: {
          id: 'editable',
          envelope: {
            content: 'after',
            context: { runtimeInput: { mode: 'supplement' } },
          },
        },
      },
    });
    const listed = await invoke({ action: 'list', payload: { sessionId: 'session-1' } });
    expect((listed.data as QueuedInput[])[0]?.envelope).toEqual({
      content: 'after',
      context: { runtimeInput: { mode: 'supplement' } },
    });

    await invoke({ action: 'markSending', payload: { id: 'editable' } });
    await expect(invoke({
      action: 'update',
      payload: { id: 'editable', content: 'too late' },
    })).resolves.toMatchObject({ success: false, error: { code: 'INVALID_STATE' } });
  });

  it('update 同步附件，省略 attachments 时保留原附件', async () => {
    const oldAtt = {
      id: 'a',
      name: 'a.png',
      type: 'image' as const,
      category: 'image' as const,
      mimeType: 'image/png',
      size: 1,
    };
    const newAtt = {
      id: 'b',
      name: 'b.png',
      type: 'image' as const,
      category: 'image' as const,
      mimeType: 'image/png',
      size: 2,
    };
    await enqueue('with-file', { content: 'before', attachments: [oldAtt] });

    await expect(invoke({
      action: 'update',
      payload: { id: 'with-file', content: 'after', attachments: [newAtt] },
    })).resolves.toMatchObject({
      success: true,
      data: {
        updated: true,
        input: { envelope: { content: 'after', attachments: [newAtt] } },
      },
    });

    await enqueue('keep-file', { content: 'keep', attachments: [oldAtt] });
    await expect(invoke({
      action: 'update',
      payload: { id: 'keep-file', content: 'still-keep' },
    })).resolves.toMatchObject({
      success: true,
      data: {
        updated: true,
        input: { envelope: { content: 'still-keep', attachments: [oldAtt] } },
      },
    });
  });

  it('requeue 把 failed 恢复为 queued 并写入新 envelope', async () => {
    await enqueue('failed-input', { content: 'old' });
    db.prepare(`UPDATE queued_inputs SET status = 'failed', paused_reason = 'send_failed' WHERE id = ?`)
      .run('failed-input');

    const response = await invoke({
      action: 'requeue',
      payload: { id: 'failed-input', envelope: { content: 'old', attachments: [] } },
    });
    expect(response).toMatchObject({
      success: true,
      data: {
        id: 'failed-input',
        status: 'queued',
        retryCount: 0,
        envelope: { content: 'old', attachments: [] },
      },
    });
    const queued = await invoke({
      action: 'list',
      payload: { sessionId: 'session-1', status: 'queued' },
    });
    expect((queued.data as QueuedInput[]).map((item) => item.id)).toEqual(['failed-input']);
  });

  it('requeue 把 retracted 恢复为 queued', async () => {
    await enqueue('retracted-input', { content: 'old' });
    await invoke({ action: 'retract', payload: { id: 'retracted-input' } });

    await expect(invoke({
      action: 'requeue',
      payload: { id: 'retracted-input', envelope: { content: 'retry' } },
    })).resolves.toMatchObject({
      success: true,
      data: { id: 'retracted-input', status: 'queued', envelope: { content: 'retry' } },
    });
  });

  it('requeue 对 sending 返回 INVALID_STATE', async () => {
    await enqueue('sending-input', { content: 'old' });
    await invoke({ action: 'markSending', payload: { id: 'sending-input' } });
    await expect(invoke({
      action: 'requeue',
      payload: { id: 'sending-input', envelope: { content: 'old' } },
    })).resolves.toMatchObject({ success: false, error: { code: 'INVALID_STATE' } });
  });

  it('sendNow 有活跃 run 时选择改道路由并结算 consumed', async () => {
    activeRun = true;
    sendNow.mockResolvedValueOnce('steered');
    await enqueue('active-input', { content: 'say this now' }, 'active-session');

    await expect(invoke({ action: 'sendNow', payload: { id: 'active-input' } }))
      .resolves.toEqual({ success: true, data: { status: 'consumed', retryCount: 0 } });
    expect(sendNow).toHaveBeenCalledWith(expect.objectContaining({
      id: 'active-input',
      sessionId: 'active-session',
      envelope: { content: 'say this now' },
    }), 'active');
  });

  it('sendNow 无活跃 run 时选择新一轮路由并结算 consumed', async () => {
    sendNow.mockResolvedValueOnce('sent');
    await enqueue('idle-input', { content: 'start the next turn' }, 'idle-session');

    await expect(invoke({ action: 'sendNow', payload: { id: 'idle-input' } }))
      .resolves.toEqual({ success: true, data: { status: 'consumed', retryCount: 0 } });
    expect(sendNow).toHaveBeenCalledWith(expect.objectContaining({
      id: 'idle-input',
      sessionId: 'idle-session',
    }), 'idle');
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

describe('queued input IPC · 委托守卫（ADR-072 K1C）', () => {
  const handlers = new Map<string, WebRouteHandler>();
  let db: BetterSqlite3.Database;
  let delegations: SessionDelegationRepository;
  let currentModelSpec: ConversationModelSpec | undefined;
  let activeRun = false;
  let permissionMode: string | null = 'default';
  let activeRunId: string | null = null;
  const sendNow = vi.fn();
  const claimOrder: string[] = [];
  let statusAtRecheck: string | undefined;

  const targetSessionId = 'target-session';
  const content = '把周报的数据表补完';
  const submissionKey = deriveSubmissionKey({
    originSessionId: 'origin-1',
    originTurnId: 'turn-1',
    action: 'delegate_existing',
    targetIdentity: `session:${targetSessionId}`,
  });
  const actionFingerprint = deriveActionFingerprint({
    action: 'delegate_existing',
    targetIdentity: `session:${targetSessionId}`,
    content,
    attachmentRefs: [],
  });
  const delegationQueuedInputId = `delegation:${submissionKey}`;

  /** 真守卫（createQueuedInputDelegationGuard）+ 可控事实依赖；recheck 顺序记录在 claimOrder。 */
  function buildGuard() {
    const base = createQueuedInputDelegationGuard({
      getDb: () => db,
      getSessionRow: () => ({
        sessionType: 'chat',
        engineKind: 'native',
        workingDirectory: '/ws/target',
        isArchived: false,
        isDeleted: false,
      }),
      getPermissionMode: () => permissionMode,
      evaluateFolderTrust: async () => ({ state: 'trusted', blockedItems: 0 }),
      getActiveRunId: () => activeRunId,
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    });
    return {
      ...base,
      async beforeSendNowClaim(record: { id: string; sessionId: string; envelopeJson: string }) {
        claimOrder.push('recheck');
        statusAtRecheck = (db.prepare('SELECT status FROM queued_inputs WHERE id = ?')
          .get(record.id) as { status: string }).status;
        return base.beforeSendNowClaim(record);
      },
    };
  }

  beforeEach(() => {
    db = new Database(':memory:');
    createSchema(db);
    delegations = new SessionDelegationRepository(db);
    databaseState.db = db;
    handlers.clear();
    currentModelSpec = undefined;
    activeRun = false;
    permissionMode = 'default';
    activeRunId = null;
    claimOrder.length = 0;
    statusAtRecheck = undefined;
    sendNow.mockReset().mockResolvedValue('sent');
    // claimOrder 记录抢占动作，供 INV-1 顺序断言（recheck 必须在前）。
    const originalMarkSending = QueuedInputRepository.prototype.markSending;
    vi.spyOn(QueuedInputRepository.prototype, 'markSending')
      .mockImplementation(function (this: QueuedInputRepository, id: string, now?: number) {
        claimOrder.push('markSending');
        return originalMarkSending.call(this, id, now);
      });
    registerQueuedInputHandlers({
      handle: (channel: string, handler: WebRouteHandler) => handlers.set(channel, handler),
    } as never, {
      resolveModelSpec: () => currentModelSpec,
      hasActiveRun: () => activeRun,
      sendNow,
      delegation: buildGuard(),
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    databaseState.db = null;
    db.close();
  });

  async function invoke(request: IPCRequest): Promise<IPCResponse> {
    const handler = handlers.get(IPC_DOMAINS.QUEUED_INPUT);
    if (!handler) throw new Error('queued input handler not registered');
    return await handler(null, request) as IPCResponse;
  }

  /** 经真 commitDelegation 落一条委托行 + 排队行（指纹自洽，recheck 可过）。 */
  function commitDelegationRow(): void {
    const result = commitDelegation(db, {
      delegationId: 'd-1',
      originSessionId: 'origin-1',
      originTurnId: 'turn-1',
      disposition: 'delegate_existing',
      targetSessionId,
      submissionKey,
      actionFingerprint,
      envelope: { content, sessionId: targetSessionId },
      now: 1_000,
    });
    expect(result.kind).toBe('created');
  }

  function rowStatus(id: string): { status: string; paused_reason: string | null } {
    return db.prepare('SELECT status, paused_reason FROM queued_inputs WHERE id = ?').get(id) as {
      status: string; paused_reason: string | null;
    };
  }

  it('update 拒改委托行（INV-5）：envelope 原样，INVALID_STATE', async () => {
    commitDelegationRow();
    await expect(invoke({
      action: 'update',
      payload: { id: delegationQueuedInputId, content: '被篡改的正文' },
    })).resolves.toMatchObject({ success: false, error: { code: 'INVALID_STATE' } });
    const stored = db.prepare('SELECT envelope_json FROM queued_inputs WHERE id = ?')
      .get(delegationQueuedInputId) as { envelope_json: string };
    expect(JSON.parse(stored.envelope_json).content).toBe(content);
  });

  it('requeue failed 委托行：沿用存量载荷，只重盖 modelSpec（INV-5）', async () => {
    currentModelSpec = { provider: 'moonshot', model: 'kimi-k2.5' };
    commitDelegationRow();
    db.prepare(`UPDATE queued_inputs SET status = 'failed', paused_reason = 'send_failed' WHERE id = ?`)
      .run(delegationQueuedInputId);

    await expect(invoke({
      action: 'requeue',
      payload: {
        id: delegationQueuedInputId,
        // renderer 传来的 envelope 是攻击面：内容/附件必须被忽略
        envelope: { content: '改过的正文', attachments: [{ id: 'evil', path: '/tmp/e' }] },
      },
    })).resolves.toMatchObject({
      success: true,
      data: {
        id: delegationQueuedInputId,
        status: 'queued',
        origin: 'delegation',
        envelope: {
          content,
          options: { modelSpec: { provider: 'moonshot', model: 'kimi-k2.5' } },
        },
      },
    });
  });

  it('requeue retracted 委托行被拒（INV-6：撤回不可复活）', async () => {
    commitDelegationRow();
    await invoke({ action: 'retract', payload: { id: delegationQueuedInputId } });

    await expect(invoke({
      action: 'requeue',
      payload: { id: delegationQueuedInputId, envelope: { content } },
    })).resolves.toMatchObject({ success: false, error: { code: 'INVALID_STATE' } });
    expect(rowStatus(delegationQueuedInputId).status).toBe('retracted');
  });

  it('retract 委托行 → 投影 aborted(retracted_by_user)（INV-6）', async () => {
    commitDelegationRow();
    await expect(invoke({ action: 'retract', payload: { id: delegationQueuedInputId } }))
      .resolves.toMatchObject({ success: true, data: { retracted: true } });
    expect(delegations.get('d-1')).toMatchObject({ status: 'aborted' });
    expect(JSON.parse(delegations.get('d-1')!.resolutionJson!)).toEqual({ reason: 'retracted_by_user' });
  });

  it('sendNow：复核先于抢占（INV-1 顺序断言），复核时行仍 queued', async () => {
    commitDelegationRow();
    await expect(invoke({ action: 'sendNow', payload: { id: delegationQueuedInputId } }))
      .resolves.toEqual({ success: true, data: { status: 'consumed', retryCount: 0 } });
    expect(claimOrder).toEqual(['recheck', 'markSending']);
    expect(statusAtRecheck).toBe('queued');
  });

  it('sendNow 空闲投递带校验过的带外标记，路由 idle', async () => {
    commitDelegationRow();
    await invoke({ action: 'sendNow', payload: { id: delegationQueuedInputId } });
    expect(sendNow).toHaveBeenCalledWith(expect.objectContaining({
      id: delegationQueuedInputId,
      sessionId: targetSessionId,
      delegationOrigin: { delegationId: 'd-1', actionFingerprint },
    }), 'idle');
  });

  it('sendNow 活跃 run（steer 分支）拒投委托行且不抢占（INV-3）', async () => {
    activeRun = true;
    commitDelegationRow();
    await expect(invoke({ action: 'sendNow', payload: { id: delegationQueuedInputId } }))
      .resolves.toMatchObject({ success: false, error: { code: 'INVALID_STATE' } });
    expect(sendNow).not.toHaveBeenCalled();
    expect(rowStatus(delegationQueuedInputId)).toMatchObject({ status: 'queued' });
  });

  it('裸 markSending / reportSendOutcome 拒绝委托行（INV-3）', async () => {
    commitDelegationRow();
    await expect(invoke({ action: 'markSending', payload: { id: delegationQueuedInputId } }))
      .resolves.toMatchObject({ success: false, error: { code: 'INVALID_STATE' } });
    expect(rowStatus(delegationQueuedInputId).status).toBe('queued');

    db.prepare(`UPDATE queued_inputs SET status = 'sending' WHERE id = ?`).run(delegationQueuedInputId);
    await expect(invoke({
      action: 'reportSendOutcome',
      payload: { id: delegationQueuedInputId, outcome: 'success' },
    })).resolves.toMatchObject({ success: false, error: { code: 'INVALID_STATE' } });
  });

  it('复核红（权限档）→ 暂停本行并返回 INVALID_STATE，不投', async () => {
    permissionMode = 'bypassPermissions';
    commitDelegationRow();
    await expect(invoke({ action: 'sendNow', payload: { id: delegationQueuedInputId } }))
      .resolves.toMatchObject({ success: false, error: { code: 'INVALID_STATE' } });
    expect(sendNow).not.toHaveBeenCalled();
    expect(rowStatus(delegationQueuedInputId)).toMatchObject({
      status: 'queued',
      paused_reason: 'target_permission_mode',
    });
  });

  it('另一条委托的 run 在跑（wait）→ 保持 queued 可投，不抢占不投', async () => {
    delegations.insertOrGet({
      delegationId: 'd-2',
      originSessionId: 'origin-2',
      originTurnId: 'turn-2',
      disposition: 'delegate_existing',
      targetSessionId,
      targetQueuedInputId: 'delegation:sdk-2',
      submissionKey: 'sdk-2',
      actionFingerprint: 'a'.repeat(64),
      createdAt: 1_500,
    });
    delegations.backfillTargetRunId('d-2', 'run-d-2');
    activeRunId = 'run-d-2';
    commitDelegationRow();

    await expect(invoke({ action: 'sendNow', payload: { id: delegationQueuedInputId } }))
      .resolves.toEqual({ success: true, data: { status: 'queued', retryCount: 0 } });
    expect(sendNow).not.toHaveBeenCalled();
    expect(rowStatus(delegationQueuedInputId)).toMatchObject({ status: 'queued', paused_reason: null });
  });

  it('list：委托行带 origin=delegation，普通行不带', async () => {
    commitDelegationRow();
    await invoke({
      action: 'enqueue',
      payload: { id: 'user-row', sessionId: targetSessionId, envelope: { content: '普通行' } },
    });

    const listed = await invoke({
      action: 'list',
      payload: { sessionId: targetSessionId, status: 'queued' },
    });
    const rows = listed.data as QueuedInput[];
    const delegationRow = rows.find((row) => row.id === delegationQueuedInputId);
    const userRow = rows.find((row) => row.id === 'user-row');
    expect(delegationRow?.origin).toBe('delegation');
    expect(userRow && 'origin' in userRow).toBe(false);
  });
});
