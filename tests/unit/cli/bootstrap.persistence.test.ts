import { describe, expect, it, vi } from 'vitest';
import type { Message, ModelConfig } from '../../../src/shared/contract';
import { persistAgentLoopMessageToSession } from '../../../src/cli/bootstrap';

const modelConfig: ModelConfig = {
  provider: 'openai',
  model: 'test-model',
  apiKey: 'test-key',
  temperature: 0,
  maxTokens: 1024,
};

const message: Message = {
  id: 'message-1',
  role: 'assistant',
  content: 'hello',
  timestamp: 123,
};

describe('persistAgentLoopMessageToSession', () => {
  it('persists loop messages to an explicit session without relying on currentSessionId', async () => {
    const manager = {
      addMessage: vi.fn(),
      addMessageToSession: vi.fn().mockResolvedValue(undefined),
    };

    await persistAgentLoopMessageToSession(manager, message, {
      sessionId: 'web-session-1',
      modelConfig,
      workingDirectory: '/tmp/project',
    });

    expect(manager.addMessageToSession).toHaveBeenCalledWith('web-session-1', message, {
      title: 'CLI Session',
      modelConfig,
      workingDirectory: '/tmp/project',
    });
    expect(manager.addMessage).not.toHaveBeenCalled();
  });

  it('keeps the legacy current-session path when no explicit session id is provided', async () => {
    const manager = {
      addMessage: vi.fn().mockResolvedValue(undefined),
      addMessageToSession: vi.fn(),
    };

    await persistAgentLoopMessageToSession(manager, message, {
      modelConfig,
      workingDirectory: '/tmp/project',
    });

    expect(manager.addMessage).toHaveBeenCalledWith(message);
    expect(manager.addMessageToSession).not.toHaveBeenCalled();
  });
});
