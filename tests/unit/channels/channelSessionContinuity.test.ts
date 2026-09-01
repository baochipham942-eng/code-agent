import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChannelMessage } from '../../../src/shared/contract/channel';
import { ChannelAgentBridge } from '../../../src/host/channels/channelAgentBridge';

const sessionManager = vi.hoisted(() => ({
  createSession: vi.fn(),
  getSession: vi.fn(),
}));

vi.mock('../../../src/host/services', () => ({
  getSessionManager: () => sessionManager,
}));

vi.mock('../../../src/host/channels/channelManager', () => ({
  getChannelManager: () => ({
    getAccount: () => ({ id: 'account-1', name: 'Feishu', type: 'feishu' }),
  }),
}));

interface BindingKey {
  accountId: string;
  chatId: string;
  threadId: string;
  ingressAuth: string;
}

interface BindingStore {
  get(key: BindingKey): string | undefined;
  set(key: BindingKey, sessionId: string): void;
  delete(key: BindingKey): void;
}

function bindingKey(key: BindingKey): string {
  return JSON.stringify([key.accountId, key.chatId, key.threadId, key.ingressAuth]);
}

function createBindingStore(): BindingStore {
  const bindings = new Map<string, string>();
  return {
    get: (key) => bindings.get(bindingKey(key)),
    set: (key, sessionId) => bindings.set(bindingKey(key), sessionId),
    delete: (key) => { bindings.delete(bindingKey(key)); },
  };
}

function createMessage(threadId: string): ChannelMessage {
  return {
    id: `message-${threadId}`,
    channelId: 'feishu-1',
    sender: { id: 'sender', name: 'Sender' },
    context: { chatId: 'chat-1', chatType: 'group', threadId },
    content: 'hello',
    timestamp: 1,
    ingressAuth: 'paired',
  };
}

const configService = {
  getSettings: () => ({ model: {} }),
};

describe('ChannelAgentBridge session continuity', () => {
  beforeEach(() => {
    sessionManager.createSession.mockReset();
    sessionManager.getSession.mockReset();
    sessionManager.createSession.mockImplementation(async () => {
      const id = `session-${sessionManager.createSession.mock.calls.length}`;
      return { id };
    });
    sessionManager.getSession.mockImplementation(async (sessionId: string) => ({ id: sessionId }));
  });

  it('creates independent sessions for two threads in the same chat', async () => {
    const bindingStore = createBindingStore();
    const bridge = new ChannelAgentBridge({ configService, bindingStore } as never);
    const harness = bridge as unknown as {
      getSessionKey(accountId: string, message: ChannelMessage): string;
      getOrCreateChannelSessionId(
        sessionKey: string,
        accountId: string,
        message: ChannelMessage,
      ): Promise<string>;
    };
    const first = createMessage('thread-1');
    const second = createMessage('thread-2');

    const firstId = await harness.getOrCreateChannelSessionId(
      harness.getSessionKey('account-1', first), 'account-1', first,
    );
    const secondId = await harness.getOrCreateChannelSessionId(
      harness.getSessionKey('account-1', second), 'account-1', second,
    );

    expect(firstId).not.toBe(secondId);
    expect(sessionManager.createSession).toHaveBeenCalledTimes(2);
  });

  it('restores the persisted session in a fresh bridge instance', async () => {
    const bindingStore = createBindingStore();
    const message = createMessage('thread-1');
    const createBridge = () => new ChannelAgentBridge({
      configService,
      bindingStore,
    } as never) as unknown as {
      getSessionKey(accountId: string, message: ChannelMessage): string;
      getOrCreateChannelSessionId(
        sessionKey: string,
        accountId: string,
        message: ChannelMessage,
      ): Promise<string>;
    };

    const firstBridge = createBridge();
    const sessionKey = firstBridge.getSessionKey('account-1', message);
    const originalId = await firstBridge.getOrCreateChannelSessionId(sessionKey, 'account-1', message);

    const restartedBridge = createBridge();
    const restoredId = await restartedBridge.getOrCreateChannelSessionId(sessionKey, 'account-1', message);

    expect(restoredId).toBe(originalId);
    expect(sessionManager.createSession).toHaveBeenCalledTimes(1);
  });
});
