import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Message } from '../../../src/shared/contract';
import {
  createChildRunTraceContext,
  createRunTraceContext,
  withRunTraceContext,
} from '../../../src/host/telemetry/runTraceContext';

const sessionManagerState = vi.hoisted(() => ({
  addMessage: vi.fn(),
  addMessageToSession: vi.fn(),
}));

const ledgerState = vi.hoisted(() => ({
  upsertEvents: vi.fn(),
}));

vi.mock('../../../src/host/services', () => ({
  getSessionManager: () => sessionManagerState,
}));

vi.mock('../../../src/host/context/contextEventLedger', () => ({
  getContextEventLedger: () => ledgerState,
}));

vi.mock('../../../src/host/services/infra/logger', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

vi.mock('../../../src/host/agent/runtime/contextAssembly', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
  MAX_PERSISTENT_SYSTEM_CONTEXT_TOKENS: 8000,
  MAX_PERSISTENT_SYSTEM_CONTEXT_ITEMS: 20,
  MAX_PERSISTENT_SYSTEM_CONTEXT_ITEM_TOKENS: 1000,
  normalizePersistentSystemContextKey: (content: string) => content.trim().replace(/\s+/g, ' '),
}));

import { addAndPersistMessage } from '../../../src/host/agent/runtime/contextAssembly/systemContextStack';

function makeCtx(sessionId: string): any {
  return {
    runtime: {
      sessionId,
      agentId: 'agent-1',
      messages: [],
    },
    recordContextEventsForMessage: vi.fn(),
  };
}

describe('systemContextStack.addAndPersistMessage', () => {
  beforeEach(() => {
    delete process.env.CODE_AGENT_CLI_MODE;
    sessionManagerState.addMessage.mockReset();
    sessionManagerState.addMessageToSession.mockReset();
    ledgerState.upsertEvents.mockReset();
  });

  it('persists to ctx.runtime.sessionId instead of the global current session', async () => {
    const ctx = makeCtx('runtime-session-1');
    const message: Message = {
      id: 'message-1',
      role: 'assistant',
      content: 'hello',
      timestamp: 123,
    };

    await addAndPersistMessage(ctx, message);

    expect(ctx.runtime.messages).toEqual([message]);
    expect(ctx.recordContextEventsForMessage).toHaveBeenCalledWith(message);
    expect(sessionManagerState.addMessageToSession).toHaveBeenCalledWith('runtime-session-1', message);
    expect(sessionManagerState.addMessage).not.toHaveBeenCalled();
  });

  it('marks messages as meta when the run is hidden from user history', async () => {
    const ctx = makeCtx('runtime-session-1');
    ctx.runtime.historyVisibility = 'meta';
    const message: Message = {
      id: 'message-1',
      role: 'assistant',
      content: 'loop reply',
      timestamp: 123,
    };

    await addAndPersistMessage(ctx, message);

    expect(message.isMeta).toBe(true);
    expect(ctx.runtime.messages).toEqual([message]);
    expect(sessionManagerState.addMessageToSession).toHaveBeenCalledWith('runtime-session-1', message);
  });

  it('persists actual turn and trace correlation with tool messages', async () => {
    const ctx = makeCtx('runtime-session-1');
    const message: Message = {
      id: 'message-tool-1',
      role: 'tool',
      content: '[{"toolCallId":"tool-1","success":true}]',
      timestamp: 123,
      toolResults: [{ toolCallId: 'tool-1', success: true }],
    };
    const run = createRunTraceContext({
      runId: 'run-1',
      sessionId: 'runtime-session-1',
      attempt: 1,
      ownerEpoch: 1,
      engine: 'native',
      workspace: '/tmp/context-stack',
      processInstanceId: 'process-1',
    });
    const turn = createChildRunTraceContext(run, { turnId: 'turn-1' });

    await withRunTraceContext(turn, () => addAndPersistMessage(ctx, message));

    expect(message.metadata).toMatchObject({
      correlation: { turnId: 'turn-1', traceId: run.traceId },
    });
    expect(sessionManagerState.addMessageToSession).toHaveBeenCalledWith(
      'runtime-session-1',
      expect.objectContaining({ metadata: message.metadata }),
    );
  });

  // T-016 fail-closed：磁盘满 / DB 锁竞争时不能带着「记录里不存在的消息」继续跑，
  // 否则紧接着 dispatch 的那批工具会留下无从追溯的副作用。
  describe('落库失败时 fail-closed', () => {
    const message = (): Message => ({
      id: 'message-1',
      role: 'assistant',
      content: 'about to call tools',
      timestamp: 123,
    });

    it('两条写入路径都失败时抛，且给的是人话不是堆栈', async () => {
      const ctx = makeCtx('runtime-session-1');
      ctx.runtime.persistMessage = vi.fn().mockRejectedValue(new Error('SQLITE_BUSY'));
      sessionManagerState.addMessageToSession.mockRejectedValue(new Error('ENOSPC: no space left on device'));

      const error = await addAndPersistMessage(ctx, message()).catch((e: unknown) => e);

      expect(error).toBeInstanceOf(Error);
      expect((error as Error).name).toBe('MessagePersistenceError');
      expect((error as Error).message).toContain('对话记录写入失败');
      expect((error as Error).message).not.toContain('SQLITE_BUSY');
      expect((error as Error).message).not.toContain('ENOSPC');
      // 两条路径都真的试过了才算「都失败」
      expect(ctx.runtime.persistMessage).toHaveBeenCalledTimes(1);
      expect(sessionManagerState.addMessageToSession).toHaveBeenCalledTimes(1);
    });

    it('只有 callback 失败、降级路径成功时照常返回（现有降级行为不变）', async () => {
      const ctx = makeCtx('runtime-session-1');
      ctx.runtime.persistMessage = vi.fn().mockRejectedValue(new Error('callback down'));
      sessionManagerState.addMessageToSession.mockResolvedValue(undefined);

      await expect(addAndPersistMessage(ctx, message())).resolves.toBeUndefined();
      expect(sessionManagerState.addMessageToSession).toHaveBeenCalledTimes(1);
    });

    it('正常落库时不抛（正例）', async () => {
      const ctx = makeCtx('runtime-session-1');
      ctx.runtime.persistMessage = vi.fn().mockResolvedValue(undefined);

      await expect(addAndPersistMessage(ctx, message())).resolves.toBeUndefined();
      // callback 成功就不该再走降级
      expect(sessionManagerState.addMessageToSession).not.toHaveBeenCalled();
    });

    it('无 callback 且无 sessionId 的运行时不抛——它压根没打算写库，不是故障', async () => {
      const ctx = makeCtx('');

      await expect(addAndPersistMessage(ctx, message())).resolves.toBeUndefined();
      expect(sessionManagerState.addMessageToSession).not.toHaveBeenCalled();
    });
  });
});
