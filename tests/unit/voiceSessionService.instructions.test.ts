import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { VOICE_TEARDOWN_DRAIN_MS } from '../../src/shared/constants/voice';
import type { VoiceTransportHandle } from '../../src/shared/contract/voice';

const runtime = vi.hoisted(() => ({
  settings: { voice: { live: {} as Record<string, unknown> } },
  connect: vi.fn(),
  updateInstructions: vi.fn(),
  quickClassify: vi.fn(),
  executeVoiceTool: vi.fn(async () => '已派发'),
}));
const recordVoiceCall = vi.hoisted(() => vi.fn());

vi.mock('../../src/host/services/core/configService', () => ({
  getConfigService: () => ({ getSettings: () => runtime.settings }),
}));
vi.mock('../../src/host/services/media/imageGenerationService', () => ({
  getDashscopeApiKey: () => 'test-key',
}));
vi.mock('../../src/host/services/voice/qwenOmniTransport', () => ({
  qwenOmniTransport: {
    id: 'dashscope-qwen-omni',
    connect: (...args: unknown[]) => runtime.connect(...args),
  },
}));
vi.mock('../../src/host/services/voice/realtimeTransport', () => ({
  createRealtimeTransport: () => ({ connect: vi.fn() }),
}));
vi.mock('../../src/host/services/voice/voiceAgentCoordinator', () => ({
  beginVoiceDispatch: vi.fn(),
  endVoiceDispatch: vi.fn(),
  pushVoiceTranscript: vi.fn(),
  setVoiceDispatchFocus: vi.fn(),
}));
vi.mock('../../src/host/services/voice/voiceTools', () => ({
  VOICE_TOOL_DEFINITIONS: [{
    type: 'function',
    name: 'delegate_task',
    description: '派发任务',
    parameters: { type: 'object', properties: {}, required: [] },
  }],
  executeVoiceTool: (...args: unknown[]) => runtime.executeVoiceTool(...args),
}));
vi.mock('../../src/host/model/quickModel', () => ({
  quickClassify: (...args: unknown[]) => runtime.quickClassify(...args),
}));
vi.mock('../../src/host/services/voice/voiceUsageLedger', () => ({
  recordVoiceCall,
  addTokenUsage: (current: Record<string, number> | undefined, added: Record<string, number>) =>
    Object.fromEntries(Object.entries(added).map(([key, value]) => [key, (current?.[key] ?? 0) + value])),
}));
vi.mock('../../src/host/services/infra/sessionManager', () => ({
  getSessionManager: () => ({
    addMessageToSession: vi.fn(async () => undefined),
    patchSessionMetadata: vi.fn(async () => undefined),
    // 建连时读 teamLead 用（语音批 B）。本文件钉的是 instructions 组装，不是团会话路由。
    getSessionMetadata: vi.fn(() => undefined),
  }),
}));
vi.mock('../../src/host/permissions/modes', () => ({
  getPermissionModeManager: () => ({
    markLiveVoiceSession: vi.fn(),
    clearLiveVoiceSession: vi.fn(),
  }),
}));
vi.mock('../../src/host/services/infra/logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));
vi.mock('../../src/host/agent/agentRegistry', () => ({ resolveAgent: () => undefined }));
vi.mock('../../src/shared/contract/agentRegistry', () => ({ isPanelVisibleAgent: () => false }));
vi.mock('../../src/host/services/roleAssets/builtinRoles', () => ({ getBuiltinRoleVisual: () => undefined }));
vi.mock('../../src/host/services/voice/voiceTurnTaking', () => ({
  decideVoiceInterrupt: () => ({ terminal: false }),
  shouldDisarmHangup: () => false,
}));

const {
  attachVoiceClient,
  endActiveVoiceSession,
  getActiveVoiceSessionId,
  refreshVoiceInstructions,
} = await import('../../src/host/services/voice/voiceSessionService');

class FakeClient extends EventEmitter {
  static readonly OPEN = 1;
  readonly OPEN = FakeClient.OPEN;
  readyState = FakeClient.OPEN;
  sent: unknown[] = [];

  send(data: unknown): void {
    this.sent.push(data);
  }

  close(): void {
    this.readyState = 3;
  }
}

function makeHandle(): VoiceTransportHandle {
  return {
    kind: 'relay',
    provider: 'qwen-omni',
    interrupt: vi.fn(() => null),
    updateInstructions: runtime.updateInstructions,
    close: vi.fn(async () => undefined),
    sendAudio: vi.fn(),
    commit: vi.fn(),
    respond: vi.fn(),
    injectItem: vi.fn(),
    isResponding: vi.fn(() => false),
  };
}

beforeEach(() => {
  vi.useFakeTimers();
  runtime.settings.voice.live = {};
  runtime.connect.mockReset().mockResolvedValue(makeHandle());
  runtime.updateInstructions.mockClear();
  runtime.quickClassify.mockReset().mockResolvedValue({ category: 'normal_reply', confidence: 0.9 });
  runtime.executeVoiceTool.mockClear();
  recordVoiceCall.mockClear();
});

afterEach(async () => {
  if (getActiveVoiceSessionId()) {
    const ending = endActiveVoiceSession();
    await vi.advanceTimersByTimeAsync(VOICE_TEARDOWN_DRAIN_MS);
    await ending;
  }
  vi.useRealTimers();
});

describe('refreshVoiceInstructions', () => {
  it('response.done 发现说了没做时经 host_routed 补派，并携带最近用户轮', async () => {
    await attachVoiceClient(new FakeClient() as never, 'session-saydo');
    const connectInput = runtime.connect.mock.calls.at(-1)?.[0] as {
      onEvent: (event: import('../../src/shared/contract/voice').VoiceEvent) => void;
    };

    connectInput.onEvent({ type: 'user.transcript', text: '帮我创建一个一点', done: true, itemId: 'u1' });
    connectInput.onEvent({
      type: 'assistant.transcript', text: '建个什么文件？', done: true, responseId: 'r1', itemId: 'a1',
    });
    connectInput.onEvent({ type: 'response.done', responseId: 'r1' });
    await vi.waitFor(() => expect(runtime.quickClassify).toHaveBeenCalledTimes(1));
    expect(runtime.executeVoiceTool).not.toHaveBeenCalled();

    runtime.quickClassify.mockResolvedValueOnce({ category: 'say_without_do', confidence: 0.9 });
    connectInput.onEvent({ type: 'user.transcript', text: 'MD 文件', done: true, itemId: 'u2' });
    connectInput.onEvent({
      type: 'assistant.transcript', text: '好的，马上帮你处理。', done: true, responseId: 'r2', itemId: 'a2',
    });
    connectInput.onEvent({ type: 'response.done', responseId: 'r2' });

    await vi.waitFor(() => expect(runtime.executeVoiceTool).toHaveBeenCalledTimes(1));
    const [name, rawArguments, origin] = runtime.executeVoiceTool.mock.calls[0] as [string, string, string];
    expect(name).toBe('delegate_task');
    expect(origin).toBe('host_routed');
    expect(JSON.parse(rawArguments)).toMatchObject({
      title: 'MD 文件',
      short_name: '语音任务',
      prompt: expect.stringContaining('[USER] 帮我创建一个一点'),
    });
    expect(JSON.parse(rawArguments).prompt).toContain('[USER] MD 文件');
  });

  it('一通电话的多轮 response usage 逐维累加后只入账一次', async () => {
    const client = new FakeClient();
    await attachVoiceClient(client as never, 'session-token-usage');
    const connectInput = runtime.connect.mock.calls.at(-1)?.[0] as {
      onEvent: (event: import('../../src/shared/contract/voice').VoiceEvent) => void;
    };
    connectInput.onEvent({
      type: 'response.done',
      responseId: 'r1',
      usage: {
        totalTokens: 100, inputTokens: 70, outputTokens: 30,
        inputAudioTokens: 20, inputTextTokens: 50, outputAudioTokens: 25, outputTextTokens: 5,
      },
    });
    connectInput.onEvent({
      type: 'response.done',
      responseId: 'r2',
      usage: {
        totalTokens: 40, inputTokens: 30, outputTokens: 10,
        inputAudioTokens: 10, inputTextTokens: 20, outputAudioTokens: 8, outputTextTokens: 2,
      },
    });

    const ending = endActiveVoiceSession();
    await vi.advanceTimersByTimeAsync(VOICE_TEARDOWN_DRAIN_MS);
    await ending;

    expect(recordVoiceCall).toHaveBeenCalledTimes(1);
    expect(recordVoiceCall).toHaveBeenCalledWith(expect.any(Number), expect.any(Number), {
      totalTokens: 140,
      inputTokens: 100,
      outputTokens: 40,
      inputAudioTokens: 30,
      inputTextTokens: 70,
      outputAudioTokens: 33,
      outputTextTokens: 7,
    });
  });

  it('挂断排水窗内才到的 response.done usage 仍随本通入账', async () => {
    await attachVoiceClient(new FakeClient() as never, 'session-late-token-usage');
    const connectInput = runtime.connect.mock.calls.at(-1)?.[0] as {
      onEvent: (event: import('../../src/shared/contract/voice').VoiceEvent) => void;
    };

    const ending = endActiveVoiceSession();
    expect(getActiveVoiceSessionId()).toBeNull();
    connectInput.onEvent({
      type: 'response.done',
      responseId: 'late-r1',
      usage: {
        totalTokens: 377,
        inputTokens: 336,
        outputTokens: 41,
        inputAudioTokens: 108,
        inputTextTokens: 228,
        outputAudioTokens: 32,
        outputTextTokens: 9,
      },
    });
    await vi.advanceTimersByTimeAsync(VOICE_TEARDOWN_DRAIN_MS);
    await ending;

    expect(recordVoiceCall).toHaveBeenCalledTimes(1);
    expect(recordVoiceCall).toHaveBeenCalledWith(expect.any(Number), expect.any(Number), {
      totalTokens: 377,
      inputTokens: 336,
      outputTokens: 41,
      inputAudioTokens: 108,
      inputTextTokens: 228,
      outputAudioTokens: 32,
      outputTextTokens: 9,
    });
  });

  it('无活跃通话时不抛错也不调用 upstream', () => {
    expect(() => refreshVoiceInstructions()).not.toThrow();
    expect(runtime.updateInstructions).not.toHaveBeenCalled();
  });

  it('活跃通话的语速设置变化后更新 instructions 一次', async () => {
    runtime.settings.voice.live = { speechRate: 'normal' };
    await attachVoiceClient(new FakeClient() as never, 'neo-1');

    runtime.updateInstructions.mockClear();
    runtime.settings.voice.live = { speechRate: 'fast' };
    refreshVoiceInstructions();

    expect(runtime.updateInstructions).toHaveBeenCalledTimes(1);
    expect(runtime.updateInstructions.mock.calls[0]?.[0]).toContain('加快语速');
  });

  it('完整 instructions 没变时不重复调用 upstream', async () => {
    runtime.settings.voice.live = { speechRate: 'normal' };
    await attachVoiceClient(new FakeClient() as never, 'neo-1');

    refreshVoiceInstructions();

    expect(runtime.updateInstructions).not.toHaveBeenCalled();
  });
});
