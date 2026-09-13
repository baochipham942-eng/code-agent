import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { QWEN_OMNI_REALTIME_MODEL, VOICE_BUDGET, VOICE_TEARDOWN_DRAIN_MS } from '../../src/shared/constants/voice';
import type { VoiceEvent, VoiceTransportHandle } from '../../src/shared/contract/voice';

const runtime = vi.hoisted(() => ({
  settings: { voice: { live: {} as Record<string, unknown> } },
  connect: vi.fn(),
  updateInstructions: vi.fn(),
  queueAssistantItemDeletion: vi.fn((_itemId: string, _onDeleted: () => void) => true),
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
  VOICE_TOOL_DEFINITIONS: [],
  executeVoiceTool: vi.fn(),
}));
vi.mock('../../src/host/model/quickModel', () => ({
  quickTask: vi.fn(),
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

const { attachVoiceClient, endActiveVoiceSession, getActiveVoiceSessionId } = await import(
  '../../src/host/services/voice/voiceSessionService'
);

class FakeClient extends EventEmitter {
  static readonly OPEN = 1;
  readonly OPEN = FakeClient.OPEN;
  readyState = FakeClient.OPEN;
  sent: unknown[] = [];
  closeCode: number | undefined;

  send(data: unknown): void {
    this.sent.push(data);
  }

  close(code?: number): void {
    this.closeCode = code;
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
    queueAssistantItemDeletion: runtime.queueAssistantItemDeletion,
    injectItem: vi.fn(),
    isResponding: vi.fn(() => false),
  };
}

function parsedEvents(client: FakeClient): VoiceEvent[] {
  return client.sent
    .filter((entry): entry is string => typeof entry === 'string')
    .map((entry) => JSON.parse(entry) as VoiceEvent);
}

async function dial(): Promise<{ client: FakeClient; onEvent: (event: VoiceEvent) => void }> {
  const client = new FakeClient();
  await attachVoiceClient(client as never, 'session-budget');
  const onEvent = runtime.connect.mock.calls.at(-1)?.[0]?.onEvent as (event: VoiceEvent) => void;
  return { client, onEvent };
}

const AUDIO_USAGE = {
  totalTokens: 2_000,
  inputTokens: 1_000,
  outputTokens: 1_000,
  inputAudioTokens: 1_000,
  inputTextTokens: 0,
  outputAudioTokens: 1_000,
  outputTextTokens: 0,
};

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-09-13T12:00:00+08:00'));
  runtime.settings.voice.live = {};
  runtime.connect.mockReset().mockResolvedValue(makeHandle());
  runtime.updateInstructions.mockClear();
  runtime.queueAssistantItemDeletion.mockClear().mockReturnValue(true);
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

describe('host 通话预算闸', () => {
  it('未设预算时不发 budget 事件，也不因时间流逝挂断', async () => {
    const { client } = await dial();
    await vi.advanceTimersByTimeAsync(VOICE_BUDGET.EVAL_INTERVAL_MS * 5);
    expect(parsedEvents(client).some((event) => event.type === 'budget')).toBe(false);
    expect(getActiveVoiceSessionId()).not.toBeNull();
  });

  it('分钟上限到告警档发可见 notice，仅提醒时不挂断', async () => {
    runtime.settings.voice.live = { callMinuteLimit: 1, callCostLimitAction: 'warn' };
    const { client } = await dial();

    await vi.advanceTimersByTimeAsync(Math.ceil(VOICE_BUDGET.WARNING_RATIO * 60_000));
    const events = parsedEvents(client);
    expect(events.some((event) => event.type === 'budget' && event.level === 'warning')).toBe(true);
    expect(events).toContainEqual({
      type: 'notice',
      code: 'VOICE_BUDGET_WARNING',
      message: 'VOICE_BUDGET_WARNING',
    });
    expect(getActiveVoiceSessionId()).not.toBeNull();
    expect(events.some((event) => event.type === 'session.ended')).toBe(false);
  });

  it('到上限且动作=挂断时 host 强挂，原因码稳定', async () => {
    runtime.settings.voice.live = { callMinuteLimit: 1, callCostLimitAction: 'hangup' };
    const { client } = await dial();

    await vi.advanceTimersByTimeAsync(60_000);
    await vi.advanceTimersByTimeAsync(VOICE_TEARDOWN_DRAIN_MS);

    const events = parsedEvents(client);
    expect(events).toContainEqual({
      type: 'notice',
      code: 'VOICE_BUDGET_EXCEEDED',
      message: 'VOICE_BUDGET_EXCEEDED',
    });
    expect(events).toContainEqual({ type: 'session.ended', reason: 'budget' });
    expect(getActiveVoiceSessionId()).toBeNull();
  });

  it('成本轨在 response.done 后立即评估并按 hangup 强挂', async () => {
    runtime.settings.voice.live = { callCostLimit: 0.1, callCostLimitAction: 'hangup' };
    const { client, onEvent } = await dial();

    onEvent({
      type: 'response.done',
      responseId: 'r1',
      usage: AUDIO_USAGE,
    });
    await vi.advanceTimersByTimeAsync(VOICE_TEARDOWN_DRAIN_MS);

    const events = parsedEvents(client);
    const budget = events.filter((event) => event.type === 'budget').at(-1);
    expect(budget).toMatchObject({
      type: 'budget',
      level: 'blocked',
      costLimit: 0.1,
      costCurrency: 'CNY',
    });
    expect(events).toContainEqual({ type: 'session.ended', reason: 'budget' });
    expect(getActiveVoiceSessionId()).toBeNull();
    expect(QWEN_OMNI_REALTIME_MODEL).toBeTruthy();
  });
});
