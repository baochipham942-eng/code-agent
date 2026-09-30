import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { VOICE_TEARDOWN_DRAIN_MS } from '../../src/shared/constants/voice';
import type { VoiceTransportHandle } from '../../src/shared/contract/voice';

const runtime = vi.hoisted(() => ({
  settings: { voice: { live: {} as Record<string, unknown> } },
  connect: vi.fn(),
  updateInstructions: vi.fn(),
}));
const starts = vi.hoisted(() => [] as string[]);
const deferreds = vi.hoisted(() => ({
  continuity: null as null | ((value: null) => void),
  profile: null as null | ((value: string) => void),
}));

vi.mock('../../src/host/services/voice/voiceContextAssembler', () => ({
  composeVoiceInstructions: (persona: string) => persona,
  focusChanged: () => false,
  loadVoiceContinuity: () => new Promise<null>((resolve) => {
    starts.push('continuity');
    deferreds.continuity = resolve;
  }),
  readVoiceLiveSettings: () => runtime.settings.voice.live,
  withLanguageDirective: (instructions: string) => instructions,
}));
vi.mock('../../src/host/services/voice/voiceUserProfile', () => ({
  loadVoiceUserProfile: () => new Promise<string>((resolve) => {
    starts.push('profile');
    deferreds.profile = resolve;
  }),
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
    withholdContinuity: false,
    initialState: () => ({ tracker: null, identity: null }),
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
    updateInstructions: runtime.updateInstructions,
    close: vi.fn(async () => undefined),
    sendAudio: vi.fn(),
    commit: vi.fn(),
    respond: vi.fn(),
    queueAssistantItemDeletion: vi.fn(() => true),
    injectItem: vi.fn(),
    isResponding: vi.fn(() => false),
  };
}

beforeEach(() => {
  vi.useFakeTimers();
  starts.length = 0;
  deferreds.continuity = null;
  deferreds.profile = null;
  runtime.connect.mockReset().mockResolvedValue(makeHandle());
});

afterEach(async () => {
  if (deferreds.continuity) deferreds.continuity(null);
  if (deferreds.profile) deferreds.profile('');
  const ending = endActiveVoiceSession();
  await vi.advanceTimersByTimeAsync(VOICE_TEARDOWN_DRAIN_MS);
  await ending.catch(() => undefined);
  vi.useRealTimers();
});

describe('voice profile connect preload', () => {
  it('starts continuity and profile together before either slow loader resolves', async () => {
    const connecting = attachVoiceClient(new FakeClient() as never, 'session-profile-concurrency');
    await vi.waitFor(() => expect(starts).toEqual(['continuity', 'profile']));
    expect(runtime.connect).not.toHaveBeenCalled();

    deferreds.continuity?.(null);
    deferreds.profile?.('');
    await connecting;
    expect(runtime.connect).toHaveBeenCalledTimes(1);
  });
});
