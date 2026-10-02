import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChannelMessage } from '../../../src/shared/contract/channel';
import { parseChannelCommand } from '../../../src/host/channels/channelCommand';
import { clearStoppedChannelRuns } from '../../../src/host/channels/channelCommandRuntime';
import { ChannelAgentBridge } from '../../../src/host/channels/channelAgentBridge';

const sessionManager = vi.hoisted(() => {
  const sessions = new Map<string, { id: string; messages: Array<{ role: string; content: string }> }>();
  return {
    sessions,
    createSession: vi.fn(async () => {
      const id = `session-${sessions.size + 1}`;
      const session = { id, messages: [] as Array<{ role: string; content: string }> };
      sessions.set(id, session);
      return session;
    }),
    getSession: vi.fn(async (sessionId: string) => sessions.get(sessionId) ?? null),
  };
});

const sent = vi.hoisted(() => [] as Array<{ accountId: string; text: string; messageId: string }>);
const accounts = vi.hoisted(() => new Map<string, { id: string; name: string; type: string }>());
const settings = vi.hoisted(() => ({ language: 'zh' as 'zh' | 'en' }));

const orchestrator = vi.hoisted(() => {
  const state: {
    processing: boolean;
    hold: boolean;
    release: () => void;
    transcript: Array<{ role: string; content: string }>;
  } = {
    processing: false,
    hold: false,
    release: () => {},
    transcript: [],
  };
  const api = {
    state,
    isProcessing: vi.fn(() => state.processing),
    cancel: vi.fn(async () => {
      state.processing = false;
      state.release();
    }),
    sendMessage: vi.fn(async (content: string) => {
      const session = [...sessionManager.sessions.values()].at(-1);
      const entry = { role: 'user', content };
      state.transcript.push(entry);
      session?.messages.push(entry);
      state.processing = true;
      if (state.hold) {
        await new Promise<void>((resolve) => {
          state.release = resolve;
        });
      }
      state.processing = false;
      if (!state.hold) {
        const reply = { role: 'assistant', content: 'ok' };
        state.transcript.push(reply);
        session?.messages.push(reply);
      }
    }),
    getMessages: vi.fn(() => state.transcript),
    setWorkingDirectory: vi.fn(),
  };
  return api;
});

const taskManager = vi.hoisted(() => {
  const orchestrators = new Map<string, typeof orchestrator>();
  return {
    orchestrators,
    getOrchestrator: vi.fn((sessionId: string) => orchestrators.get(sessionId)),
    setSessionContext: vi.fn(),
    getOrCreateCurrentOrchestrator: vi.fn((sessionId: string) => {
      orchestrators.set(sessionId, orchestrator);
      return orchestrator;
    }),
  };
});

const runRegistry = vi.hoisted(() => ({
  findRecoveredWaitingRun: vi.fn((_selector: { sessionId?: string }) => undefined as { runId: string; sessionId: string } | undefined),
  hasSession: vi.fn((_sessionId: string) => false),
  getBySessionId: vi.fn((_sessionId: string) => undefined as { context: { runId: string } } | undefined),
  getDurableEnvelope: vi.fn((_runId: string) => undefined as { engine: { kind: string } } | undefined),
}));

const healthBySession = vi.hoisted(() => new Map<string, {
  currentTokens: number;
  maxTokens: number;
  usagePercent: number;
  tokenSource?: 'provider' | 'estimated';
}>());

vi.mock('../../../src/host/services', () => ({
  getSessionManager: () => sessionManager,
}));

vi.mock('../../../src/host/channels/channelManager', () => ({
  getChannelManager: () => ({
    getAccount: (accountId: string) => accounts.get(accountId),
    getResponseCallback: (accountId: string, message: ChannelMessage) => ({
      sendText: async (text: string) => {
        sent.push({ accountId, text, messageId: message.id });
        return { success: true };
      },
      startTyping: async () => {},
      stopTyping: async () => {},
    }),
  }),
}));

vi.mock('../../../src/host/task', () => ({
  getTaskManager: () => taskManager,
}));

vi.mock('../../../src/host/context/contextHealthService', () => ({
  getContextHealthService: () => ({
    get: (sessionId: string) => healthBySession.get(sessionId) ?? {
      currentTokens: 0,
      maxTokens: 128000,
      usagePercent: 0,
    },
  }),
}));

vi.mock('../../../src/host/app/applicationRunRegistry', () => ({
  getApplicationRunRegistry: () => runRegistry,
}));

interface BindingKey {
  accountId: string;
  chatId: string;
  threadId: string;
  ingressAuth: string;
}

function bindingId(key: BindingKey): string {
  return JSON.stringify([key.accountId, key.chatId, key.threadId, key.ingressAuth]);
}

function createBindingStore() {
  const bindings = new Map<string, string>();
  return {
    bindings,
    get: (key: BindingKey) => bindings.get(bindingId(key)),
    set: (key: BindingKey, sessionId: string) => { bindings.set(bindingId(key), sessionId); },
    delete: (key: BindingKey) => { bindings.delete(bindingId(key)); },
  };
}

function message(overrides: Partial<ChannelMessage> & Pick<ChannelMessage, 'id' | 'content'>): ChannelMessage {
  return {
    channelId: 'channel-1',
    timestamp: 1,
    ingressAuth: 'paired',
    ...overrides,
    context: { chatId: 'chat-1', chatType: 'p2p', ...overrides.context },
    sender: { id: 'sender-1', name: 'Sender', ...overrides.sender },
  };
}

const configService = {
  getSettings: () => ({ ui: { language: settings.language }, model: {} }),
};

type Harness = {
  handleChannelMessage(accountId: string, inbound: ChannelMessage): Promise<void>;
  getPipelineStats(): { queueDepth: number; activeSession: number; debouncing: number };
};

describe('parseChannelCommand', () => {
  const accepted: Array<[string, 'stop' | 'new' | 'status', ChannelMessage['context']['chatType']]> = [
    ['/stop', 'stop', 'p2p'],
    ['/STOP', 'stop', 'p2p'],
    ['@_user_1 /stop', 'stop', 'group'],
    ['/stop@mybot', 'stop', 'p2p'],
    ['／stop', 'stop', 'p2p'],
    ['/stop now', 'stop', 'p2p'],
    ['/new', 'new', 'p2p'],
    ['/STATUS', 'status', 'channel'],
    ['<at user_id="ou_1">Neo</at> /status', 'status', 'group'],
  ];

  it.each(accepted)('accepts %j', (text, command, chatType) => {
    expect(parseChannelCommand(text, { chatType })).toEqual({ command });
  });

  const rejected = ['/stopwatch', 'hello /stop', '/statuses', '', '   ', 'plain text', '/stopping', '@name hello'];

  it.each(rejected)('rejects %j', (text) => {
    expect(parseChannelCommand(text, { chatType: 'group' })).toBeNull();
  });
});

describe('channel slash commands', () => {
  let bindingStore: ReturnType<typeof createBindingStore>;
  let bridge: ChannelAgentBridge;
  let harness: Harness;

  beforeEach(() => {
    vi.useFakeTimers();
    sessionManager.sessions.clear();
    sessionManager.createSession.mockClear();
    sessionManager.getSession.mockClear();
    sent.length = 0;
    accounts.clear();
    accounts.set('feishu-1', { id: 'feishu-1', name: 'Feishu', type: 'feishu' });
    accounts.set('telegram-1', { id: 'telegram-1', name: 'Telegram', type: 'telegram' });
    settings.language = 'zh';
    orchestrator.state.processing = false;
    orchestrator.state.hold = false;
    orchestrator.state.release = () => {};
    orchestrator.state.transcript = [];
    orchestrator.isProcessing.mockClear();
    orchestrator.cancel.mockReset();
    orchestrator.cancel.mockImplementation(async () => {
      orchestrator.state.processing = false;
      orchestrator.state.release();
    });
    orchestrator.sendMessage.mockClear();
    orchestrator.getMessages.mockClear();
    taskManager.orchestrators.clear();
    taskManager.getOrchestrator.mockClear();
    taskManager.getOrCreateCurrentOrchestrator.mockClear();
    runRegistry.findRecoveredWaitingRun.mockReset();
    runRegistry.findRecoveredWaitingRun.mockReturnValue(undefined);
    runRegistry.hasSession.mockReset();
    runRegistry.hasSession.mockReturnValue(false);
    runRegistry.getBySessionId.mockReset();
    runRegistry.getBySessionId.mockReturnValue(undefined);
    runRegistry.getDurableEnvelope.mockReset();
    runRegistry.getDurableEnvelope.mockReturnValue(undefined);
    healthBySession.clear();
    clearStoppedChannelRuns();
    bindingStore = createBindingStore();
    bridge = new ChannelAgentBridge({ configService, bindingStore } as never);
    harness = bridge as unknown as Harness;
  });

  afterEach(async () => {
    orchestrator.state.hold = false;
    orchestrator.state.release();
    await vi.runOnlyPendingTimersAsync();
    vi.useRealTimers();
  });

  async function deliver(accountId: string, inbound: ChannelMessage): Promise<void> {
    await harness.handleChannelMessage(accountId, inbound);
  }

  async function flushIngress(): Promise<void> {
    await vi.advanceTimersByTimeAsync(1_500);
  }

  function texts(): string[] {
    return sent.map((entry) => entry.text);
  }

  async function startHeldRun(accountId: string, chatId: string): Promise<void> {
    orchestrator.state.hold = true;
    await deliver(accountId, message({ id: `hold-${accountId}`, content: 'do the work', context: { chatId, chatType: 'p2p' } }));
    await flushIngress();
    expect(orchestrator.sendMessage).toHaveBeenCalledTimes(1);
    expect(orchestrator.isProcessing()).toBe(true);
    expect(harness.getPipelineStats().activeSession).toBe(1);
  }

  it.each([
    ['feishu-1', '/stop now'],
    ['telegram-1', '/stop@mybot'],
  ])('%s /stop aborts a locked native run within 3s without reaching the model', async (accountId, content) => {
    await startHeldRun(accountId, `chat-${accountId}`);
    const callsBeforeStop = orchestrator.sendMessage.mock.calls.length;
    const started = Date.now();
    await deliver(accountId, message({
      id: `stop-${accountId}`,
      content,
      context: { chatId: `chat-${accountId}`, chatType: 'p2p' },
    }));
    expect(Date.now() - started).toBeLessThanOrEqual(3_000);
    expect(orchestrator.cancel).toHaveBeenCalledTimes(1);
    expect(orchestrator.cancel).toHaveBeenCalledWith('user');
    expect(orchestrator.sendMessage.mock.calls.length).toBe(callsBeforeStop);
    expect(texts().some((text) => text.includes('/stop'))).toBe(false);
    expect(texts().at(-1)).toContain('已停止');
    expect(texts().some((text) => text.includes('处理完成，但没有生成响应'))).toBe(false);
    expect(harness.getPipelineStats().debouncing).toBe(0);
    expect(orchestrator.state.transcript.some((entry) => entry.content.includes('/stop'))).toBe(false);
    for (const session of sessionManager.sessions.values()) {
      expect(session.messages.some((entry) => entry.content.includes('/stop'))).toBe(false);
    }
  });

  it('replies that stop is still winding down when cancel exceeds 3s', async () => {
    await startHeldRun('feishu-1', 'chat-wind');
    orchestrator.cancel.mockImplementation(() => new Promise(() => {}));
    const pending = deliver('feishu-1', message({
      id: 'stop-wind',
      content: '/stop',
      context: { chatId: 'chat-wind', chatType: 'p2p' },
    }));
    await vi.advanceTimersByTimeAsync(2_999);
    expect(texts().some((text) => text.includes('仍在收尾'))).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await pending;
    expect(orchestrator.cancel).toHaveBeenCalledWith('user');
    expect(texts().at(-1)).toContain('已请求停止，仍在收尾');
  });

  it('replies that nothing is running', async () => {
    await deliver('feishu-1', message({ id: 'stop-idle', content: '/stop' }));
    expect(texts()).toEqual(['没有运行中的任务']);
    expect(orchestrator.cancel).not.toHaveBeenCalled();
    expect(orchestrator.sendMessage).not.toHaveBeenCalled();
  });

  it('cannot stop a recovered waiting run and points at the desktop app', async () => {
    await deliver('feishu-1', message({ id: 'seed-parked', content: 'earlier' }));
    await flushIngress();
    orchestrator.state.processing = false;
    taskManager.orchestrators.clear();
    runRegistry.findRecoveredWaitingRun.mockReturnValue({ runId: 'parked-run', sessionId: 'session-1' });
    await deliver('feishu-1', message({ id: 'stop-parked', content: '/stop' }));
    const receipt = texts().at(-1) ?? '';
    expect(receipt).toContain('此运行无法从 IM 中止');
    expect(receipt).toContain('桌面');
    expect(orchestrator.cancel).not.toHaveBeenCalled();
    expect(orchestrator.sendMessage.mock.calls.map((call) => call[0])).not.toContain('/stop');
  });

  it('cannot stop an external-engine run that has no local orchestrator', async () => {
    await deliver('telegram-1', message({ id: 'seed-ext', content: 'earlier', context: { chatId: 'tg-chat', chatType: 'p2p' } }));
    await flushIngress();
    taskManager.orchestrators.clear();
    runRegistry.hasSession.mockReturnValue(true);
    runRegistry.getBySessionId.mockReturnValue({ context: { runId: 'ext-run' } });
    runRegistry.getDurableEnvelope.mockReturnValue({ engine: { kind: 'external_cli' } });
    await deliver('telegram-1', message({
      id: 'stop-ext',
      content: '/STOP',
      context: { chatId: 'tg-chat', chatType: 'p2p' },
    }));
    const receipt = texts().at(-1) ?? '';
    expect(receipt).toContain('此运行无法从 IM 中止');
    expect(receipt).toContain('Neo');
    expect(orchestrator.cancel).not.toHaveBeenCalled();
  });

  it('replies 无权 to guest /stop /new /status and leaves the paired session untouched', async () => {
    await deliver('feishu-1', message({ id: 'seed-guest', content: 'hello' }));
    await flushIngress();
    const sessionId = bindingStore.bindings.values().next().value;
    expect(sessionId).toBe('session-1');
    const orchestratorCalls = taskManager.getOrchestrator.mock.calls.length;
    const sendCalls = orchestrator.sendMessage.mock.calls.length;
    for (const [id, content] of [['g-stop', '/stop'], ['g-new', '/new'], ['g-status', '/status']] as const) {
      await deliver('feishu-1', message({ id, content, ingressAuth: 'guest' }));
    }
    expect(texts().slice(-3)).toEqual(['无权', '无权', '无权']);
    expect(taskManager.getOrchestrator.mock.calls.length).toBe(orchestratorCalls);
    expect(orchestrator.cancel).not.toHaveBeenCalled();
    expect(orchestrator.sendMessage.mock.calls.length).toBe(sendCalls);
    expect(bindingStore.bindings.values().next().value).toBe(sessionId);
    await deliver('feishu-1', message({ id: 'after-guest', content: 'still here' }));
    await flushIngress();
    expect(sessionManager.createSession).toHaveBeenCalledTimes(1);
  });

  it('runs an already-mentioned group command on the same path', async () => {
    orchestrator.state.hold = true;
    await deliver('feishu-1', message({
      id: 'group-work',
      content: 'work',
      context: { chatId: 'group-1', chatType: 'group' },
    }));
    await flushIngress();
    await deliver('feishu-1', message({
      id: 'group-stop',
      content: '@_user_1 /stop',
      context: { chatId: 'group-1', chatType: 'group' },
    }));
    expect(orchestrator.cancel).toHaveBeenCalledWith('user');
    expect(texts().at(-1)).toBe('[Sender] 已停止');
    expect(orchestrator.sendMessage.mock.calls.map((call) => call[0])).toEqual(['work']);
  });

  it('opens a new session with /new and keeps the old session', async () => {
    await deliver('feishu-1', message({ id: 'old-1', content: 'remember this' }));
    await flushIngress();
    const oldId = [...sessionManager.sessions.keys()][0];
    await deliver('feishu-1', message({ id: 'new-1', content: '/new' }));
    expect(texts().at(-1)).toContain('已开始新的对话');
    expect(texts().at(-1)).toContain('之前的记录还在');
    expect(bindingStore.bindings.size).toBe(0);
    await deliver('feishu-1', message({ id: 'new-2', content: 'fresh' }));
    await flushIngress();
    const ids = [...sessionManager.sessions.keys()];
    expect(ids).toEqual([oldId, 'session-2']);
    expect(sessionManager.sessions.get(oldId)?.messages.some((entry) => entry.content === 'remember this')).toBe(true);
    expect(orchestrator.state.transcript.some((entry) => entry.content.includes('/new'))).toBe(false);
    expect(sessionManager.createSession).toHaveBeenCalledTimes(2);
  });

  it('refuses /new while a run is active', async () => {
    await startHeldRun('feishu-1', 'chat-busy');
    await deliver('feishu-1', message({
      id: 'new-busy',
      content: '/new extra',
      context: { chatId: 'chat-busy', chatType: 'p2p' },
    }));
    expect(texts().at(-1)).toBe('有任务在运行，请先 /stop');
    expect(bindingStore.bindings.size).toBe(1);
    expect(sessionManager.createSession).toHaveBeenCalledTimes(1);
    expect(orchestrator.sendMessage.mock.calls.map((call) => call[0])).toEqual(['do the work']);
  });

  it('reports context usage and empty health without calling the model', async () => {
    await deliver('feishu-1', message({ id: 'status-seed', content: 'hi' }));
    await flushIngress();
    healthBySession.set('session-1', {
      currentTokens: 1200,
      maxTokens: 8000,
      usagePercent: 15,
      tokenSource: 'estimated',
    });
    const sends = orchestrator.sendMessage.mock.calls.length;
    await deliver('feishu-1', message({ id: 'status-1', content: '/status' }));
    expect(texts().at(-1)).toBe('idle 1200/8000 (15%)');
    expect(orchestrator.sendMessage.mock.calls.length).toBe(sends);

    healthBySession.delete('session-1');
    await deliver('feishu-1', message({ id: 'status-empty', content: '/status' }));
    expect(texts().at(-1)).toBe('idle 还没有上下文数据');

    orchestrator.state.processing = true;
    await deliver('feishu-1', message({ id: 'status-run', content: '/status' }));
    expect(texts().at(-1)).toContain('running');

    orchestrator.state.processing = false;
    runRegistry.findRecoveredWaitingRun.mockReturnValue({ runId: 'parked', sessionId: 'session-1' });
    await deliver('feishu-1', message({ id: 'status-paused', content: '/status' }));
    expect(texts().at(-1)).toContain('paused-resumable');
    expect(orchestrator.sendMessage.mock.calls.map((call) => call[0])).not.toContain('/status');
  });

  it('uses the English receipt when the UI language is English', async () => {
    settings.language = 'en';
    await deliver('telegram-1', message({ id: 'en-idle', content: '/status', context: { chatId: 'en', chatType: 'p2p' } }));
    expect(texts().at(-1)).toBe('idle no data yet');
    await startHeldRun('telegram-1', 'en');
    await deliver('telegram-1', message({ id: 'en-stop', content: '/stop', context: { chatId: 'en', chatType: 'p2p' } }));
    expect(texts().at(-1)).toBe('stopped');
  });

  it('handles one command delivery once', async () => {
    await deliver('feishu-1', message({ id: 'dup-1', content: '/status' }));
    await deliver('feishu-1', message({ id: 'dup-1', content: '/status' }));
    expect(texts()).toEqual(['idle 还没有上下文数据']);
  });

  it('sends a non-command such as /stopwatch to the model', async () => {
    await deliver('feishu-1', message({ id: 'watch', content: '/stopwatch' }));
    await flushIngress();
    expect(orchestrator.sendMessage).toHaveBeenCalledTimes(1);
    expect(orchestrator.sendMessage.mock.calls[0]?.[0]).toBe('/stopwatch');
    expect(orchestrator.cancel).not.toHaveBeenCalled();
  });
});
