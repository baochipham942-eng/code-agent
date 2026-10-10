// ============================================================================
// headless neo run：信号打断且尚无 assistant 回复时，落一条 interrupted 记录
// ============================================================================

import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Message } from '../../../src/shared/contract';

const loggerError = vi.hoisted(() => vi.fn());

vi.mock('../../../src/host/services/infra/logger', () => ({
  createLogger: () => ({
    error: loggerError,
    warn: vi.fn(),
    info: vi.fn(),
    debug: vi.fn(),
  }),
}));

const NOW = 1_725_000_000_000;
const SESSION_ID = 'sess-interrupted';

type MarkerModule = typeof import('../../../src/cli/interruptedRunMarker');

async function loadMarker(): Promise<MarkerModule> {
  vi.resetModules();
  return import('../../../src/cli/interruptedRunMarker');
}

function fakeSessionManager(options: {
  messages?: Array<{ role: string }>;
  throwOn?: 'get' | 'add';
}) {
  const writes: Message[] = [];
  const getSession = vi.fn(async (sessionId: string, messageLimit?: number) => {
    if (options.throwOn === 'get') throw new Error('session read failed');
    return { id: sessionId, messages: options.messages ?? [], messageLimit };
  });
  const addMessageToSession = vi.fn(async (_sessionId: string, message: Message) => {
    if (options.throwOn === 'add') throw new Error('session write failed');
    writes.push(message);
  });
  return { sessionManager: { getSession, addMessageToSession }, writes, getSession };
}

function fakeSignals() {
  const listeners = new Map<'SIGTERM' | 'SIGINT', () => void>();
  return {
    listeners,
    signals: {
      once(signal: 'SIGTERM' | 'SIGINT', listener: () => void) {
        listeners.set(signal, listener);
      },
      off(signal: 'SIGTERM' | 'SIGINT', listener: () => void) {
        if (listeners.get(signal) === listener) listeners.delete(signal);
      },
    },
  };
}

async function flushSignal(): Promise<void> {
  await new Promise((resolve) => setImmediate(resolve));
}

describe('markInterruptedIfNoAssistant', () => {
  afterEach(() => {
    loggerError.mockReset();
  });

  it('writes one empty assistant message when the session has no assistant', async () => {
    const { markInterruptedIfNoAssistant } = await loadMarker();
    const { sessionManager, writes, getSession } = fakeSessionManager({
      messages: [
        { role: 'system' },
        { role: 'user' },
      ],
    });

    await markInterruptedIfNoAssistant(sessionManager, SESSION_ID, NOW);

    expect(getSession).toHaveBeenCalledWith(SESSION_ID, Number.MAX_SAFE_INTEGER);
    expect(writes).toEqual([
      {
        id: expect.stringMatching(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i),
        role: 'assistant',
        content: '',
        timestamp: NOW,
        metadata: {
          agentError: {
            category: 'interrupted',
            code: 'RUN_INTERRUPTED',
            rawMessage: 'run interrupted by signal',
            timestamp: NOW,
          },
        },
      },
    ]);
  });

  it('does not write when an assistant message already exists', async () => {
    const { markInterruptedIfNoAssistant } = await loadMarker();
    const { sessionManager, writes } = fakeSessionManager({
      messages: [
        { role: 'user' },
        { role: 'assistant' },
      ],
    });

    await markInterruptedIfNoAssistant(sessionManager, SESSION_ID, NOW);

    expect(writes).toEqual([]);
  });

  it('writes only once when called again in the same process', async () => {
    const { markInterruptedIfNoAssistant } = await loadMarker();
    const { sessionManager, writes } = fakeSessionManager({
      messages: [{ role: 'user' }],
    });

    await markInterruptedIfNoAssistant(sessionManager, SESSION_ID, NOW);
    await markInterruptedIfNoAssistant(sessionManager, SESSION_ID, NOW + 1);

    expect(writes).toHaveLength(1);
    expect(writes[0]?.metadata?.agentError?.timestamp).toBe(NOW);
  });

  it('resolves when the session manager throws', async () => {
    const { markInterruptedIfNoAssistant } = await loadMarker();
    const { sessionManager, writes } = fakeSessionManager({ throwOn: 'get' });

    await expect(
      markInterruptedIfNoAssistant(sessionManager, SESSION_ID, NOW),
    ).resolves.toBeUndefined();
    expect(writes).toEqual([]);
    expect(loggerError).toHaveBeenCalled();
  });
});

describe('installInterruptHandlers', () => {
  afterEach(() => {
    loggerError.mockReset();
  });

  it('marks the session and exits 143 on SIGTERM, 130 on SIGINT', async () => {
    const { installInterruptHandlers } = await loadMarker();
    const { sessionManager, writes } = fakeSessionManager({
      messages: [{ role: 'user' }],
    });
    const { listeners, signals } = fakeSignals();
    const exit = vi.fn();

    installInterruptHandlers({
      sessionManager,
      getSessionId: () => SESSION_ID,
      now: () => NOW,
      exit,
      signals,
    });

    listeners.get('SIGTERM')?.();
    await flushSignal();
    expect(exit).toHaveBeenCalledWith(143);
    expect(writes).toHaveLength(1);
    expect(writes[0]?.metadata?.agentError).toMatchObject({
      category: 'interrupted',
      code: 'RUN_INTERRUPTED',
    });

    listeners.get('SIGINT')?.();
    await flushSignal();
    expect(exit).toHaveBeenCalledWith(130);
    expect(writes).toHaveLength(1);
  });

  it('exits with the signal code even when the session already has an assistant', async () => {
    const { installInterruptHandlers } = await loadMarker();
    const { sessionManager, writes } = fakeSessionManager({
      messages: [{ role: 'assistant' }],
    });
    const { listeners, signals } = fakeSignals();
    const exit = vi.fn();

    installInterruptHandlers({
      sessionManager,
      getSessionId: () => SESSION_ID,
      now: () => NOW,
      exit,
      signals,
    });

    listeners.get('SIGINT')?.();
    await flushSignal();

    expect(writes).toEqual([]);
    expect(exit).toHaveBeenCalledWith(130);
  });

  it('removes both listeners when the run finishes', async () => {
    const { installInterruptHandlers } = await loadMarker();
    const { sessionManager } = fakeSessionManager({ messages: [] });
    const { listeners, signals } = fakeSignals();

    const remove = installInterruptHandlers({
      sessionManager,
      getSessionId: () => SESSION_ID,
      now: () => NOW,
      exit: vi.fn(),
      signals,
    });

    expect(listeners.size).toBe(2);
    remove();
    expect(listeners.size).toBe(0);
  });
});
