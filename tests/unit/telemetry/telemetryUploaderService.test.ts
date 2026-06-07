import os from 'os';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { TelemetrySession, TelemetryTurn } from '../../../src/shared/contract/telemetry';

const mocks = vi.hoisted(() => {
  const storage = {
    getUnsyncedSessions: vi.fn(),
    getTurnsBySession: vi.fn(),
    getTurnCalls: vi.fn(),
    getUnsyncedFeedback: vi.fn(),
    markFeedbackSynced: vi.fn(),
    getUnsyncedRendererBundleAttempts: vi.fn(),
    markRendererBundleAttemptsSynced: vi.fn(),
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
    mocks.storage.getTurnCalls.mockReturnValue({ modelCalls: [], toolCalls: [] });
    mocks.storage.getUnsyncedFeedback.mockReturnValue([]);
    mocks.storage.getUnsyncedRendererBundleAttempts.mockReturnValue([]);
  });

  it('hydrates turn payload with model/tool call details so cloud traces can be drilled into', async () => {
    // 回归测试：rowToTurn 从 DB 读出的 turn 不带 modelCalls/toolCalls（独立表），
    // 上传器必须用 getTurnCalls 补齐，否则云端 payload 全是空数组，admin 无法定位报错根因。
    mocks.storage.getTurnCalls.mockReturnValue({
      modelCalls: [
        {
          id: 'mc-1',
          timestamp: 1,
          provider: 'codex',
          model: 'gpt-5.5-codex',
          inputTokens: 10,
          outputTokens: 0,
          latencyMs: 200,
          responseType: 'text',
          toolCallCount: 0,
          truncated: false,
          error: `Codex CLI engine P0 only supports text prompts. ${os.homedir()}/secret.png`,
        },
      ],
      toolCalls: [
        {
          id: 'tc-1',
          toolCallId: 'call-1',
          name: 'read_file',
          arguments: '{}',
          resultSummary: '',
          success: false,
          error: 'File not found: /tmp/missing.txt',
          errorCategory: 'unknown',
          durationMs: 5,
          timestamp: 1,
          index: 0,
          parallel: false,
        },
      ],
    });

    const upserts: Array<{ table: string; rows: Record<string, unknown>[] }> = [];
    mocks.from.mockImplementation((table: string) => ({
      upsert: vi.fn(async (rows: Record<string, unknown>[]) => {
        upserts.push({ table, rows });
        return { error: null };
      }),
    }));

    const { TelemetryUploaderService } = await import('../../../src/main/telemetry/telemetryUploaderService');
    const service = new TelemetryUploaderService();

    await expect(service.upload()).resolves.toBe(1);
    expect(mocks.storage.getTurnCalls).toHaveBeenCalledWith('turn-1');

    const turnUpsert = upserts.find((entry) => entry.table === 'telemetry_turns');
    const payload = turnUpsert?.rows[0]?.payload as {
      modelCalls: Array<Record<string, unknown>>;
      toolCalls: Array<Record<string, unknown>>;
    };
    expect(payload.modelCalls).toHaveLength(1);
    expect(payload.modelCalls[0]).toMatchObject({
      provider: 'codex',
      model: 'gpt-5.5-codex',
      responseType: 'text',
    });
    expect(payload.toolCalls).toHaveLength(1);
    expect(payload.toolCalls[0]).toMatchObject({
      name: 'read_file',
      success: false,
      errorCategory: 'unknown',
    });
    // 报错串必须经过脱敏（家目录替换为 ~，不泄露本机用户名），但要保留可定位的错误信息
    expect(String(payload.modelCalls[0].error)).toContain('Codex CLI engine P0 only supports text prompts');
    expect(String(payload.modelCalls[0].error)).not.toContain(os.homedir());
    expect(String(payload.modelCalls[0].error)).toContain('~/secret.png');
    expect(String(payload.toolCalls[0].error)).toContain('File not found');
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

  it('uploads unsynced feedback after session and turn metadata are accepted', async () => {
    const upserts: Array<{ table: string; rows: unknown[] }> = [];
    mocks.storage.getUnsyncedFeedback.mockReturnValue([
      {
        id: '00000000-0000-4000-8000-000000000001',
        sessionId: 'session-1',
        turnId: 'turn-1',
        messageId: 'turn-1',
        rating: -1,
        fullContent: { assistantResponse: 'bad answer' },
        createdAt: 123,
      },
    ]);
    mocks.from.mockImplementation((table: string) => ({
      upsert: vi.fn(async (rows: unknown[]) => {
        upserts.push({ table, rows });
        return { error: null };
      }),
    }));

    const { TelemetryUploaderService } = await import('../../../src/main/telemetry/telemetryUploaderService');
    const service = new TelemetryUploaderService();

    await expect(service.upload()).resolves.toBe(1);
    expect(mocks.storage.getUnsyncedFeedback).toHaveBeenCalledWith(200, 'user-1');
    expect(mocks.storage.markFeedbackSynced).toHaveBeenCalledWith(['00000000-0000-4000-8000-000000000001']);
    const feedbackUpsert = upserts.find((entry) => entry.table === 'telemetry_feedback');
    expect(feedbackUpsert?.rows).toEqual([
      expect.objectContaining({
        id: '00000000-0000-4000-8000-000000000001',
        session_id: 'session-1',
        turn_id: 'turn-1',
        user_id: 'user-1',
        rating: -1,
        full_content: { assistantResponse: 'bad answer' },
      }),
    ]);
  });

  it('uploads renderer bundle hot-update attempts as metadata-only system events', async () => {
    const upserts: Array<{ table: string; rows: Record<string, unknown>[] }> = [];
    mocks.storage.getUnsyncedSessions.mockReturnValue([]);
    mocks.storage.getUnsyncedRendererBundleAttempts.mockReturnValue([
      {
        id: 'attempt-1',
        checkedAt: 1_780_000_000_000,
        manifestUrl: 'https://oss.example/renderer-bundle/channels/beta/manifest.json',
        sourceChannel: 'beta',
        sourceManifestUrlOverride: false,
        currentShellVersion: '0.16.93',
        activeVersion: '0.16.92',
        activeContentHash: 'a'.repeat(64),
        outcome: 'skipped',
        reason: 'missing-shell-capability',
        manifestVersion: '0.17.0-beta.1',
        manifestContentHash: 'b'.repeat(64),
        manifestMinShellVersion: '0.16.93',
        manifestBundleUrl: 'https://oss.example/renderer-bundle/channels/beta/bundle.tar.gz',
        requiredShellCapabilitiesCount: 2,
        rollbackToBuiltin: false,
        missingShellCapabilities: ['domain:local/newAction'],
        missingRuntimeAssets: ['playwright-browser-runtime'],
        missingResources: ['resources/browser-relay-extension'],
        diagnostics: ['missing-shell-capability'],
        errorMessage: `missing local file ${os.homedir()}/secret.txt`,
      },
    ]);
    mocks.from.mockImplementation((table: string) => ({
      upsert: vi.fn(async (rows: Record<string, unknown>[]) => {
        upserts.push({ table, rows });
        return { error: null };
      }),
    }));

    const { TelemetryUploaderService } = await import('../../../src/main/telemetry/telemetryUploaderService');
    const service = new TelemetryUploaderService();

    await expect(service.upload()).resolves.toBe(0);
    const attemptUpsert = upserts.find((entry) => entry.table === 'telemetry_renderer_bundle_attempts');
    expect(attemptUpsert?.rows).toEqual([
      expect.objectContaining({
        id: 'attempt-1',
        user_id: 'user-1',
        device_id: 'device-test',
        app_version: '0.0.0-test',
        checked_at: 1_780_000_000_000,
        source_channel: 'beta',
        current_shell_version: '0.16.93',
        outcome: 'skipped',
        reason: 'missing-shell-capability',
        manifest_version: '0.17.0-beta.1',
        required_shell_capabilities_count: 2,
        missing_shell_capabilities: ['domain:local/newAction'],
        missing_runtime_assets: ['playwright-browser-runtime'],
        missing_resources: ['resources/browser-relay-extension'],
      }),
    ]);
    expect(String(attemptUpsert?.rows[0]?.error_message)).not.toContain(os.homedir());
    expect(mocks.storage.markRendererBundleAttemptsSynced).toHaveBeenCalledWith(['attempt-1']);
  });
});
