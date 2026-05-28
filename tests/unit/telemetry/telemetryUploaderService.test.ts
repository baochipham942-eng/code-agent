import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { TelemetrySession, TelemetryTurn } from '../../../src/shared/contract/telemetry';

const mocks = vi.hoisted(() => {
  const storage = {
    getUnsyncedSessions: vi.fn(),
    getTurnsBySession: vi.fn(),
    markSessionsSynced: vi.fn(),
  };
  return {
    storage,
    getCurrentUser: vi.fn(),
    isSupabaseInitialized: vi.fn(),
    from: vi.fn(),
  };
});

vi.mock('../../../src/main/services/infra', () => ({
  getSupabase: () => ({ from: mocks.from }),
  isSupabaseInitialized: mocks.isSupabaseInitialized,
}));

vi.mock('../../../src/main/services/auth', () => ({
  getAuthService: () => ({ getCurrentUser: mocks.getCurrentUser }),
}));

vi.mock('../../../src/main/services/core', () => ({
  getSecureStorage: () => ({ getDeviceId: () => 'device-test' }),
}));

vi.mock('../../../src/main/services/infra/logger', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

vi.mock('../../../src/main/services/serviceRegistry', () => ({
  getServiceRegistry: () => ({ register: vi.fn() }),
}));

vi.mock('../../../src/main/platform', () => ({
  app: { getVersion: () => '0.0.0-test' },
}));

vi.mock('../../../src/main/telemetry/telemetryStorage', () => ({
  getTelemetryStorage: () => mocks.storage,
}));

const session: TelemetrySession = {
  id: 'session-1',
  userId: 'user-1',
  title: 'Session',
  generationId: 'gen',
  modelProvider: 'openai',
  modelName: 'gpt-test',
  workingDirectory: '/tmp/project',
  startTime: 1,
  endTime: 2,
  durationMs: 1,
  turnCount: 1,
  totalInputTokens: 1,
  totalOutputTokens: 1,
  totalTokens: 2,
  estimatedCost: 0,
  totalToolCalls: 1,
  toolSuccessRate: 1,
  totalErrors: 0,
  status: 'completed',
};

const turn: TelemetryTurn = {
  id: 'turn-1',
  sessionId: 'session-1',
  turnNumber: 1,
  startTime: 1,
  endTime: 2,
  durationMs: 1,
  userPrompt: 'private prompt',
  userPromptTokens: 1,
  hasAttachments: false,
  attachmentCount: 0,
  agentMode: 'default',
  effortLevel: 'medium',
  modelCalls: [],
  toolCalls: [],
  assistantResponse: 'private response',
  assistantResponseTokens: 1,
  totalInputTokens: 1,
  totalOutputTokens: 1,
  events: [],
  intent: { primary: 'unknown', confidence: 0, method: 'rule', keywords: [] },
  outcome: {
    status: 'success',
    confidence: 1,
    method: 'rule',
    signals: {
      toolSuccessRate: 1,
      toolCallCount: 0,
      retryCount: 0,
      errorCount: 0,
      errorRecovered: 0,
      compactionTriggered: false,
      circuitBreakerTripped: false,
      nudgesInjected: 0,
    },
  },
  compactionOccurred: false,
  iterationCount: 1,
  turnType: 'user',
};

describe('TelemetryUploaderService', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.isSupabaseInitialized.mockReturnValue(true);
    mocks.getCurrentUser.mockReturnValue({ id: 'user-1' });
    mocks.storage.getUnsyncedSessions.mockReturnValue([session]);
    mocks.storage.getTurnsBySession.mockReturnValue([turn]);
  });

  it('does not mark sessions synced when turn upload fails', async () => {
    mocks.from.mockImplementation((table: string) => ({
      upsert: vi.fn(async () => ({
        error: table === 'telemetry_turns' ? new Error('turn upload failed') : null,
      })),
    }));

    const { TelemetryUploaderService } = await import('../../../src/main/telemetry/telemetryUploaderService');
    const service = new TelemetryUploaderService();

    await expect(service.upload()).resolves.toBe(0);
    expect(mocks.storage.markSessionsSynced).not.toHaveBeenCalled();
  });
});
