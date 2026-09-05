import { beforeEach, describe, expect, it } from 'vitest';
import { useSessionStore } from '../../../src/renderer/stores/sessionStore';
import { QUEUED_INPUT_RETRY } from '../../../src/shared/constants/queuedInput';
import { OrchestratorMessageHistory } from '../../../src/host/agent/orchestratorMessageHistory';

describe('排队重投用户气泡', () => {
  beforeEach(() => {
    useSessionStore.setState({ messages: [], sessions: [], currentSessionId: null });
  });

  it('首次投递及三次重投只留同一条；相同文本的新消息仍独立显示', () => {
    const history = new OrchestratorMessageHistory(() => null);
    for (let attempt = 0; attempt <= QUEUED_INPUT_RETRY.MAX_RESEND_ATTEMPTS; attempt += 1) {
      history.addMessage({ id: 'queued-1', role: 'user', content: '继续', timestamp: attempt });
      useSessionStore.getState().addMessage({
        id: 'queued-1', role: 'user', content: '继续', timestamp: attempt,
      });
    }
    expect(useSessionStore.getState().messages).toHaveLength(1);
    expect(history.getMessages()).toHaveLength(1);
    useSessionStore.getState().addMessage({
      id: 'queued-2', role: 'user', content: '继续', timestamp: 5,
    });
    expect(useSessionStore.getState().messages.map((message) => message.id)).toEqual(['queued-1', 'queued-2']);
  });
});
