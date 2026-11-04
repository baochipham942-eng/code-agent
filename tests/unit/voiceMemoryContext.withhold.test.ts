import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { VOICE_TEARDOWN_DRAIN_MS } from '../../src/shared/constants/voice';
import type { VoiceTransportHandle } from '../../src/shared/contract/voice';

const runtime = vi.hoisted(() => ({
  settings: { voice: { live: {} as Record<string, unknown>, userProfile: { enabled: true } } },
  connect: vi.fn(),
  withhold: false,
}));

vi.mock('../../src/host/services/voice/voiceMemoryContext', () => ({
  loadVoiceMemoryContext: async () => ({
    now: 1,
    earlierCalls: [{ voiceCallId: 'voice-thursday', lines: [{ at: 1, text: '周五要交方案' }] }],
    recentChat: [],
    recentTopics: null,
  }),
  buildVoiceMemoryBlock: (facts: { earlierCalls?: Array<{ lines: Array<{ text: string }> }> } | null) => {
    const text = facts?.earlierCalls?.[0]?.lines?.[0]?.text;
    return text ? `[Context — Earlier calls]\n- ${text}` : '';
  },
}));
vi.mock('../../src/host/services/core/configService', () => ({
  getConfigService: () => ({ onSettingsUpdated: vi.fn(), getSettings: () => runtime.settings }),
}));
vi.mock('../../src/host/services/media/imageGenerationService', () => ({ getDashscopeApiKey: () => 'test-key' }));
vi.mock('../../src/host/services/voice/qwenOmniTransport', () => ({
  qwenOmniTransport: { id: 'dashscope-qwen-omni', connect: (...args: unknown[]) => runtime.connect(...args) },
}));
vi.mock('../../src/host/services/voice/realtimeTransport', () => ({ createRealtimeTransport: () => ({ connect: vi.fn() }) }));
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
vi.mock('../../src/host/services/voice/voiceUsageLedger', () => ({
  recordVoiceCall: vi.fn(),
  addTokenUsage: (current: Record<string, number> | undefined, added: Record<string, number>) =>
    Object.fromEntries(Object.entries(added).map(([key, value]) => [key, (current?.[key] ?? 0) + value])),
}));
vi.mock('../../src/host/services/infra/sessionManager', () => ({
  getSessionManager: () => ({
    addMessageToSession: vi.fn(async () => undefined),
    patchSessionMetadata: vi.fn(async () => undefined),
    getSessionMetadata: vi.fn(() => undefined),
    getMessages: vi.fn(async () => []),
  }),
}));
vi.mock('../../src/host/permissions/modes', () => ({
  getPermissionModeManager: () => ({ markLiveVoiceSession: vi.fn(), clearLiveVoiceSession: vi.fn() }),
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
vi.mock('../../src/host/services/voice/voiceprintService', () => ({
  prepareVoiceprintForCall: () => ({
    withholdContinuity: runtime.withhold,
    initialState: () => ({ tracker: null, embedder: null, heldContinuity: null }),
    activate: vi.fn(),
  }),
  releaseVoiceprintForCall: vi.fn(),
}));

const { attachVoiceClient, endActiveVoiceSession } = await import('../../src/host/services/voice/voiceSessionService');

class FakeClient extends EventEmitter {
  static readonly OPEN = 1;
  readonly OPEN = FakeClient.OPEN;
  readyState = FakeClient.OPEN;
  send(): void {}
  close(): void { this.readyState = 3; }
}

function makeHandle(): VoiceTransportHandle {
  return {
    kind: 'relay',
    provider: 'qwen-omni',
    interrupt: vi.fn(() => null),
    updateInstructions: vi.fn(),
    close: vi.fn(async () => undefined),
    sendAudio: vi.fn(),
    commit: vi.fn(),
    respond: vi.fn(),
    queueAssistantItemDeletion: vi.fn(() => true),
    injectItem: vi.fn(),
    isResponding: vi.fn(() => false),
  };
}

function instructionsOf(): string {
  const call = runtime.connect.mock.calls[0]?.[0] as { config?: { instructions?: string } } | undefined;
  return call?.config?.instructions ?? '';
}

afterEach(async () => {
  const ending = endActiveVoiceSession();
  await vi.advanceTimersByTimeAsync(VOICE_TEARDOWN_DRAIN_MS).catch(() => undefined);
  await ending.catch(() => undefined);
  vi.useRealTimers();
  runtime.connect.mockReset();
});

describe('voice memory withhold', () => {
  it('blanks earlier calls when voiceprint withholds continuity', async () => {
    vi.useFakeTimers();
    runtime.withhold = true;
    runtime.connect.mockResolvedValue(makeHandle());
    await attachVoiceClient(new FakeClient() as never, 'session-withhold');
    expect(instructionsOf()).not.toContain('周五要交方案');
    expect(instructionsOf()).not.toContain('[Context — Earlier calls]');
  });

  it('passes earlier calls into instructions when continuity is not withheld', async () => {
    vi.useFakeTimers();
    runtime.withhold = false;
    runtime.connect.mockResolvedValue(makeHandle());
    await attachVoiceClient(new FakeClient() as never, 'session-open');
    expect(instructionsOf()).toContain('[Context — Earlier calls]');
    expect(instructionsOf()).toContain('周五要交方案');
  });
});
