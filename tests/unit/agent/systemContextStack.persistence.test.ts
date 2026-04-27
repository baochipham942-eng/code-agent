import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Message } from '../../../src/shared/contract';

const sessionManagerState = vi.hoisted(() => ({
  addMessage: vi.fn(),
  addMessageToSession: vi.fn(),
}));

const ledgerState = vi.hoisted(() => ({
  upsertEvents: vi.fn(),
}));

vi.mock('../../../src/main/services', () => ({
  getSessionManager: () => sessionManagerState,
}));

vi.mock('../../../src/main/context/contextEventLedger', () => ({
  getContextEventLedger: () => ledgerState,
}));

vi.mock('../../../src/main/services/infra/logger', () => ({
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

vi.mock('../../../src/main/agent/runtime/contextAssembly', () => ({
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

import { addAndPersistMessage } from '../../../src/main/agent/runtime/contextAssembly/systemContextStack';

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
});
