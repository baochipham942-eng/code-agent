import { describe, expect, it, vi } from 'vitest';
import type { DurableRecoveryDispatchResult } from '../../../src/host/runtime/durableRecoveryDispatcher';

const uiSettings = vi.hoisted(() => ({ language: 'zh' as 'zh' | 'en' }));

vi.mock('../../../src/host/services/core/configService', () => ({
  getConfigService: () => ({ getSettings: () => ({ ui: uiSettings }) }),
}));

const { notifyDurableRecoveryWaiting } =
  await import('../../../src/web/durableRecoveryWaitingNotifier');

const CJK = /[一-鿿]/;

function result(runId: string, reason: string): DurableRecoveryDispatchResult {
  return { runId, attempt: 1, phase: 'engine', handler: 'test', status: 'observing', reason };
}

function makeDeps(sessions: Record<string, { id: string; title: string } | undefined>) {
  const envelopes = new Map<string, { sessionId: string }>();
  for (const [runId, session] of Object.entries(sessions)) {
    if (session) envelopes.set(runId, { sessionId: session.id });
  }
  const notifyNeedsInput = vi.fn();
  const onError = vi.fn();
  return {
    deps: {
      getDurableEnvelope: (runId: string) => envelopes.get(runId),
      getSession: (sessionId: string) => Promise.resolve(
        Object.values(sessions).find((session) => session?.id === sessionId) ?? null,
      ),
      notifyNeedsInput,
      onError,
    },
    envelopes,
    notifyNeedsInput,
    onError,
  };
}

async function flushMicrotasks(): Promise<void> {
  await new Promise((resolve) => setImmediate(resolve));
}

describe('durable recovery 停靠通知按用户语言本地化', () => {
  it('en：停靠结果投递英文标题/正文（不含中文字符），空标题兜底 Untitled session', async () => {
    uiSettings.language = 'en';
    const { deps, notifyNeedsInput } = makeDeps({
      'run-titled': { id: 'session-a', title: 'Waiting run' },
      'run-untitled': { id: 'session-b', title: '' },
    });

    notifyDurableRecoveryWaiting([
      result('run-titled', 'waiting_for_approval'),
      result('run-untitled', 'restore_same_approval'),
    ], deps);
    await flushMicrotasks();

    expect(notifyNeedsInput).toHaveBeenCalledTimes(2);
    expect(notifyNeedsInput).toHaveBeenCalledWith({
      sessionId: 'session-a',
      title: 'Waiting run',
      body: 'Task paused, waiting for confirmation to continue.',
    });
    expect(notifyNeedsInput).toHaveBeenCalledWith({
      sessionId: 'session-b',
      title: 'Untitled session',
      body: 'Task paused, waiting for confirmation to continue.',
    });
    for (const call of notifyNeedsInput.mock.calls) {
      expect(call[0].title).not.toMatch(CJK);
      expect(call[0].body).not.toMatch(CJK);
    }
  });

  it('zh：标题/正文与原文一致（含「未命名会话」兜底）', async () => {
    uiSettings.language = 'zh';
    const { deps, notifyNeedsInput } = makeDeps({
      'run-titled': { id: 'session-a', title: '等待确认' },
      'run-untitled': { id: 'session-b', title: '' },
    });

    notifyDurableRecoveryWaiting([
      result('run-titled', 'auto_agent_waiting'),
    ], deps);
    await flushMicrotasks();

    expect(notifyNeedsInput).toHaveBeenCalledWith({
      sessionId: 'session-a',
      title: '等待确认',
      body: '任务暂停，等待确认后继续。',
    });

    notifyNeedsInput.mockClear();
    notifyDurableRecoveryWaiting([
      result('run-untitled', 'waiting_for_approval'),
    ], deps);
    await flushMicrotasks();
    expect(notifyNeedsInput).toHaveBeenCalledWith({
      sessionId: 'session-b',
      title: '未命名会话',
      body: '任务暂停，等待确认后继续。',
    });
  });

  it('非停靠类结果不通知；envelope 缺失或会话缺失的跳过', async () => {
    uiSettings.language = 'zh';
    const { deps, envelopes, notifyNeedsInput, onError } = makeDeps({
      'run-ok': { id: 'session-a', title: '停靠中' },
      'run-no-envelope': { id: 'session-x', title: '不该出现' },
      'run-session-gone': { id: 'session-gone', title: '也不该出现' },
    });
    // run-no-envelope 抹掉 envelope 走缺失分支；run-session-gone 有 envelope 但会话查无
    envelopes.delete('run-no-envelope');
    const originalGetSession = deps.getSession;
    deps.getSession = (sessionId) => sessionId === 'session-gone'
      ? Promise.resolve(null)
      : originalGetSession(sessionId);

    notifyDurableRecoveryWaiting([
      result('run-ok', 'waiting_for_approval'),
      result('run-resumed', 'auto_resumed'),
      result('run-no-envelope', 'waiting_for_approval'),
      result('run-session-gone', 'waiting_for_approval'),
    ], deps);
    await flushMicrotasks();

    expect(notifyNeedsInput).toHaveBeenCalledTimes(1);
    expect(notifyNeedsInput).toHaveBeenCalledWith({
      sessionId: 'session-a',
      title: '停靠中',
      body: '任务暂停，等待确认后继续。',
    });
    expect(onError).not.toHaveBeenCalled();
  });

  it('会话读取失败走 onError，不炸恢复路径', async () => {
    uiSettings.language = 'zh';
    const failure = new Error('db down');
    const notifyNeedsInput = vi.fn();
    const onError = vi.fn();
    notifyDurableRecoveryWaiting([result('run-x', 'waiting_for_approval')], {
      getDurableEnvelope: () => ({ sessionId: 'session-a' }),
      getSession: () => Promise.reject(failure),
      notifyNeedsInput,
      onError,
    });
    await flushMicrotasks();

    expect(notifyNeedsInput).not.toHaveBeenCalled();
    expect(onError).toHaveBeenCalledWith(failure);
  });
});
