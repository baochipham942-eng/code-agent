import os from 'os';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { TelemetrySession, TelemetryTurn, TelemetryTurnScoreRecord } from '../../../src/shared/contract/telemetry';

const mocks = vi.hoisted(() => {
  const storage = {
    getUnsyncedSessions: vi.fn(),
    getTurnsBySession: vi.fn(),
    getTurnCalls: vi.fn(),
    getTurnDetail: vi.fn(),
    getUnsyncedFeedback: vi.fn(),
    getSession: vi.fn(),
    markFeedbackSynced: vi.fn(),
    getUnsyncedRendererBundleAttempts: vi.fn(),
    markRendererBundleAttemptsSynced: vi.fn(),
    getUnsyncedDiagnosticBundles: vi.fn(() => []),
    markDiagnosticBundlesSynced: vi.fn(),
    markSessionsSynced: vi.fn(),
  };
  const logger = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  };
  return {
    storage,
    logger,
    getCurrentUser: vi.fn(),
    isSupabaseInitialized: vi.fn(),
    from: vi.fn(),
    // telemetry_turn_scores 的查询住在 postLaunchScoreStore（那张表的家），不在 telemetryStorage 上
    // 返回类型要显式写：typescript7 会把 `vi.fn(() => [])` 的空数组推成 never[]，
    // 后面 mockReturnValue([score]) 就全成了 TS2322（普通 tsc 不报，11/43 那格报）。
    getUnsyncedTurnScores: vi.fn((): TelemetryTurnScoreRecord[] => []),
    markTurnScoresSynced: vi.fn(),
  };
});

vi.mock('../../../src/host/testing/postlaunch/postLaunchScoreStore', async (importOriginal) => ({
  // redactPostLaunchReason 走真实实现：脱敏双保险那条断言要的就是它真跑一遍
  ...(await importOriginal<typeof import('../../../src/host/testing/postlaunch/postLaunchScoreStore')>()),
  getUnsyncedTurnScores: mocks.getUnsyncedTurnScores,
  markTurnScoresSynced: mocks.markTurnScoresSynced,
}));

vi.mock('../../../src/host/services/core/databaseService', () => ({
  getDatabase: () => ({ getDb: () => ({ __fake: 'db' }) }),
}));

vi.mock('../../../src/host/services/infra', () => ({
  getSupabase: () => ({ from: mocks.from }),
  isSupabaseInitialized: mocks.isSupabaseInitialized,
}));

vi.mock('../../../src/host/services/auth', () => ({
  getAuthService: () => ({ getCurrentUser: mocks.getCurrentUser }),
}));

vi.mock('../../../src/host/services/core', () => ({
  getSecureStorage: () => ({ getDeviceId: () => 'device-test' }),
}));

vi.mock('../../../src/host/services/infra/logger', () => ({
  createLogger: () => mocks.logger,
}));

vi.mock('../../../src/host/services/serviceRegistry', () => ({
  getServiceRegistry: () => ({ register: vi.fn() }),
}));

vi.mock('../../../src/host/platform', () => ({
  app: { getVersion: () => '0.0.0-test' },
}));

vi.mock('../../../src/host/telemetry/telemetryStorage', () => ({
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
    mocks.storage.getTurnDetail.mockImplementation((turnId: string) => (
      turnId === 'turn-1' ? { turn, modelCalls: [], toolCalls: [], events: [] } : null
    ));
    mocks.storage.getUnsyncedFeedback.mockReturnValue([]);
    mocks.storage.getSession.mockImplementation((sessionId: string) => (
      sessionId === session.id ? session : null
    ));
    mocks.storage.getUnsyncedRendererBundleAttempts.mockReturnValue([]);
    mocks.getUnsyncedTurnScores.mockReturnValue([]);
  });

  it('marks eval sessions and feedback locally synced without sending sessions, turns, or feedback', async () => {
    const evalSession: TelemetrySession = { ...session, id: 'eval-session', sessionType: 'eval' };
    const evalFeedback = {
      id: '00000000-0000-4000-8000-000000000009',
      sessionId: evalSession.id,
      turnId: 'eval-turn',
      messageId: 'eval-turn',
      rating: -1 as const,
      createdAt: 123,
    };
    mocks.storage.getUnsyncedSessions.mockReturnValue([evalSession]);
    mocks.storage.getUnsyncedFeedback.mockReturnValue([evalFeedback]);
    mocks.storage.getSession.mockImplementation((sessionId: string) => (
      sessionId === evalSession.id ? evalSession : null
    ));
    mocks.from.mockImplementation((table: string) => ({
      upsert: vi.fn(async () => ({ error: null, table })),
    }));

    const { TelemetryUploaderService } = await import('../../../src/host/telemetry/telemetryUploaderService');
    const service = new TelemetryUploaderService();

    await expect(service.upload()).resolves.toBe(0);
    expect(mocks.storage.getTurnsBySession).not.toHaveBeenCalledWith(evalSession.id);
    expect(mocks.storage.markSessionsSynced).toHaveBeenCalledWith([evalSession.id]);
    expect(mocks.storage.markFeedbackSynced).toHaveBeenCalledWith([evalFeedback.id]);
    expect(mocks.from).not.toHaveBeenCalledWith('telemetry_sessions');
    expect(mocks.from).not.toHaveBeenCalledWith('telemetry_turns');
    expect(mocks.from).not.toHaveBeenCalledWith('telemetry_feedback');
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

    const { TelemetryUploaderService } = await import('../../../src/host/telemetry/telemetryUploaderService');
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

    const { TelemetryUploaderService } = await import('../../../src/host/telemetry/telemetryUploaderService');
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

    const { TelemetryUploaderService } = await import('../../../src/host/telemetry/telemetryUploaderService');
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

  it('omits an unproven message id from the cloud turn foreign key and exposes upload failures', async () => {
    mocks.storage.getUnsyncedFeedback.mockReturnValue([
      {
        id: '00000000-0000-4000-8000-000000000002',
        sessionId: 'session-1',
        turnId: 'assistant-message-id',
        messageId: 'assistant-message-id',
        rating: 1,
        createdAt: 456,
      },
    ]);
    let feedbackRow: Record<string, unknown> | undefined;
    mocks.from.mockImplementation((table: string) => ({
      upsert: vi.fn(async (rows: Record<string, unknown>[]) => {
        if (table === 'telemetry_feedback') {
          feedbackRow = rows[0];
          return { error: { code: '42501', message: 'row-level security policy rejected row' } };
        }
        return { error: null };
      }),
    }));

    const { TelemetryUploaderService } = await import('../../../src/host/telemetry/telemetryUploaderService');
    const service = new TelemetryUploaderService();

    await expect(service.upload()).resolves.toBe(1);
    expect(feedbackRow?.turn_id).toBeNull();
    expect(service.getUploadHealth()).toMatchObject({
      lastUploadAt: null,
      lastUploadError: expect.stringContaining('telemetry_feedback'),
      lastUploadErrorAt: expect.any(Number),
      uploadFailureCount: 1,
    });
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

    const { TelemetryUploaderService } = await import('../../../src/host/telemetry/telemetryUploaderService');
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

    describe('上线后分数上云（ADR-063 §6.3 · 元数据档）', () => {
    const score: TelemetryTurnScoreRecord = {
      turnId: 'turn-1',
      sessionId: 'session-1',
      scoredAt: 1_780_000_000_000,
      scoredDay: '2026-09-06',
      turnStartedAt: 1_779_999_000_000,
      appVersion: '0.33.0',
      promptVersion: 'p7',
      judgeVersion: 'postlaunch-judge-v1',
      rubricVersion: 'postlaunch-rubric-v1',
      judgeModel: 'deepseek/deepseek-chat',
      dimGoal: 1,
      dimOrchestration: 0,
      dimTools: null,
      dimPermission: 1,
      dimSafety: 1,
      dimArtifact: 1,
      failureClass: 'TOOL_MISUSE',
      reasonRedacted: '工具连调三次同一个参数没换法子',
      redacted: false,
      signals: '["repeat_loop"]',
      costUsd: 0.0021,
      sampledBy: 'signal',
    };

    function captureUpserts() {
      const upserts: Array<{ table: string; rows: Record<string, unknown>[] }> = [];
      mocks.from.mockImplementation((table: string) => ({
        upsert: vi.fn(async (rows: Record<string, unknown>[]) => {
          upserts.push({ table, rows });
          return { error: null };
        }),
      }));
      return upserts;
    }

    it('把分数行按 ADR-063 §1 的列清单传上去，并标记本地 synced_at', async () => {
      mocks.getUnsyncedTurnScores.mockReturnValue([score]);
      const upserts = captureUpserts();

      const { TelemetryUploaderService } = await import('../../../src/host/telemetry/telemetryUploaderService');
      await new TelemetryUploaderService().upload();

      const scoreUpsert = upserts.find((entry) => entry.table === 'telemetry_turn_scores');
      expect(scoreUpsert?.rows).toEqual([
        expect.objectContaining({
          turn_id: 'turn-1',
          session_id: 'session-1',
          user_id: 'user-1',
          device_id: 'device-test',
          app_version: '0.33.0',
          prompt_version: 'p7',
          judge_version: 'postlaunch-judge-v1',
          rubric_version: 'postlaunch-rubric-v1',
          judge_model: 'deepseek/deepseek-chat',
          dim_goal: 1,
          dim_orchestration: 0,
          dim_tools: null,
          failure_class: 'TOOL_MISUSE',
          reason_redacted: '工具连调三次同一个参数没换法子',
          redacted: false,
          // TEXT JSON 解析成数组写 JSONB，不是把引号串塞进去
          signals: ['repeat_loop'],
          cost_usd: 0.0021,
          sampled_by: 'signal',
        }),
      ]);
      // 上传成功才标记；这是「分数行上传后 synced_at 非空」那条断言的落点
            // 传的是整条快照（带 scored_at），不是只有 turn_id：上传在飞时被重评的行要匹配不上
      expect(mocks.markTurnScoresSynced).toHaveBeenCalledWith(
        expect.anything(),
        [expect.objectContaining({ turnId: 'turn-1', scoredAt: 1_780_000_000_000 })],
      );
    });

    it('只传元数据：本机去重键与本地预算账不出机器，正文一列都没有', async () => {
      mocks.getUnsyncedTurnScores.mockReturnValue([score]);
      const upserts = captureUpserts();

      const { TelemetryUploaderService } = await import('../../../src/host/telemetry/telemetryUploaderService');
      await new TelemetryUploaderService().upload();

      const row = upserts.find((entry) => entry.table === 'telemetry_turn_scores')?.rows[0] ?? {};
      // 白名单：出机器的列必须逐个能在 ADR-063 §1 里指到，多一列都算越界
      expect(Object.keys(row).sort()).toEqual([
        'app_version', 'cost_usd', 'device_id',
        'dim_artifact', 'dim_goal', 'dim_orchestration', 'dim_permission', 'dim_safety', 'dim_tools',
        'failure_class', 'judge_model', 'judge_version', 'prompt_version', 'reason_redacted',
        'redacted', 'rubric_version', 'sampled_by', 'scored_at', 'scored_day', 'session_id',
        'signals', 'turn_id', 'turn_started_at', 'user_id',
      ]);
    });

    it('一行理由出机器前再过一次脱敏闸：命中即置空并标 redacted（双保险）', async () => {
      // 本机写库时 redacted=false（当时这一行是干净的），但表里躺着一个 token 形状的串——
      // 只信本地那一次判断就会把它原样发出去。
      mocks.getUnsyncedTurnScores.mockReturnValue([
        { ...score, reasonRedacted: 'judge 报错 authorization: sk-abc123def456ghi789', redacted: false },
      ]);
      const upserts = captureUpserts();

      const { TelemetryUploaderService } = await import('../../../src/host/telemetry/telemetryUploaderService');
      await new TelemetryUploaderService().upload();

      const row = upserts.find((entry) => entry.table === 'telemetry_turn_scores')?.rows[0];
      expect(row?.reason_redacted).toBe('');
      expect(row?.redacted).toBe(true);
      expect(String(row?.reason_redacted)).not.toContain('sk-abc123def456ghi789');
    });

    it('取数按当前登录账号过滤：换过账号的机器不会把上一个人的待传行混进这批', async () => {
      mocks.getUnsyncedTurnScores.mockReturnValue([score]);
      captureUpserts();

      const { TelemetryUploaderService } = await import('../../../src/host/telemetry/telemetryUploaderService');
      await new TelemetryUploaderService().upload();

      // 归属过滤必须发生在取数那一层（SQL 里、LIMIT 之前），不是取回来再筛：
      // 否则一批 200 行可能全被别人的行占满，本人的行永远排不上队。
      expect(mocks.getUnsyncedTurnScores).toHaveBeenCalledWith(expect.anything(), 'user-1', 200);
    });

    it('会话先于分数：分数段排在 markSessionsSynced 之后，本轮上传的会话其分数同轮跟着走', async () => {
      const order: string[] = [];
      mocks.storage.markSessionsSynced.mockImplementation(() => { order.push('markSessionsSynced'); });
      mocks.getUnsyncedTurnScores.mockImplementation(() => {
        order.push('getUnsyncedTurnScores');
        return [score];
      });
      captureUpserts();

      const { TelemetryUploaderService } = await import('../../../src/host/telemetry/telemetryUploaderService');
      await new TelemetryUploaderService().upload();

      expect(order).toEqual(['markSessionsSynced', 'getUnsyncedTurnScores']);
    });

    it('分数上传失败不回退前面几段已打的标记，健康状态如实记账', async () => {
      mocks.getUnsyncedTurnScores.mockReturnValue([score]);
      mocks.from.mockImplementation((table: string) => ({
        upsert: vi.fn(async () => ({
          error: table === 'telemetry_turn_scores'
            ? { code: '23503', message: 'insert or update on table violates foreign key constraint' }
            : null,
        })),
      }));

      const { TelemetryUploaderService } = await import('../../../src/host/telemetry/telemetryUploaderService');
      const service = new TelemetryUploaderService();
      await service.upload();

      expect(mocks.markTurnScoresSynced).not.toHaveBeenCalled();
      expect(mocks.storage.markSessionsSynced).toHaveBeenCalledWith(['session-1']);
      expect(service.getUploadHealth()).toMatchObject({
        lastUploadAt: null,
        lastUploadError: expect.stringContaining('telemetry_turn_scores'),
      });
    });
  });

  it('会话行带上 origin_kind，云端才剔得掉脚本会话', async () => {
    mocks.storage.getUnsyncedSessions.mockReturnValue([{ ...session, originKind: 'headless' }]);
    const upserts: Array<{ table: string; rows: Record<string, unknown>[] }> = [];
    mocks.from.mockImplementation((table: string) => ({
      upsert: vi.fn(async (rows: Record<string, unknown>[]) => {
        upserts.push({ table, rows });
        return { error: null };
      }),
    }));

    const { TelemetryUploaderService } = await import('../../../src/host/telemetry/telemetryUploaderService');
    await new TelemetryUploaderService().upload();

    const sessionRow = upserts.find((entry) => entry.table === 'telemetry_sessions')?.rows[0];
    expect(sessionRow).toMatchObject({ id: 'session-1', origin_kind: 'headless' });
  });

  it('没有来源标记的存量会话传 null，不编造一个来源', async () => {
    const upserts: Array<{ table: string; rows: Record<string, unknown>[] }> = [];
    mocks.from.mockImplementation((table: string) => ({
      upsert: vi.fn(async (rows: Record<string, unknown>[]) => {
        upserts.push({ table, rows });
        return { error: null };
      }),
    }));

    const { TelemetryUploaderService } = await import('../../../src/host/telemetry/telemetryUploaderService');
    await new TelemetryUploaderService().upload();

    const sessionRow = upserts.find((entry) => entry.table === 'telemetry_sessions')?.rows[0];
    expect(sessionRow).toHaveProperty('origin_kind', null);
  });

  describe('T5 resilience: backoff + circuit breaker on persistent 4xx/policy failures', () => {
    it('classifies 42501 (RLS) as non-retryable and trips the circuit breaker on the very first hit', async () => {
      // 42501 = insufficient_privilege（含 RLS WITH CHECK 拒绝）：需要服务端策略修好，
      // 不是客户端多试几次就能过，所以熔断阈值是 1，不必像普通抖动那样等 N 次。
      mocks.from.mockImplementation((table: string) => ({
        upsert: vi.fn(async () => ({
          error: table === 'telemetry_sessions'
            ? { code: '42501', message: 'new row violates row-level security policy for table "telemetry_sessions"' }
            : null,
        })),
      }));

      const { TelemetryUploaderService } = await import('../../../src/host/telemetry/telemetryUploaderService');
      const service = new TelemetryUploaderService();

      await service.upload();
      expect(mocks.logger.error).toHaveBeenCalledTimes(1);
      expect(mocks.logger.error).toHaveBeenCalledWith('Failed to push telemetry_sessions', expect.anything());
      expect(mocks.logger.warn).toHaveBeenCalledTimes(1);
      expect(String(mocks.logger.warn.mock.calls[0][0])).toContain('circuit breaker tripped');

      // 第二轮同因失败：不再逐条打 ERROR 刷屏，改走 debug；也不再重复打摘要 WARN。
      await service.upload();
      expect(mocks.logger.error).toHaveBeenCalledTimes(1);
      expect(mocks.logger.warn).toHaveBeenCalledTimes(1);
      expect(mocks.logger.debug).toHaveBeenCalled();

      // 健康状态仍然照常累积失败计数，观测性不受熔断影响。
      expect(service.getUploadHealth().uploadFailureCount).toBe(2);
    });

    it('tolerates transient (non-42501) errors for a few rounds before tripping, and resets on recovery', async () => {
      let shouldFail = true;
      mocks.from.mockImplementation((table: string) => ({
        upsert: vi.fn(async () => ({
          error: table === 'telemetry_sessions' && shouldFail
            ? { code: '08006', message: 'connection failure' }
            : null,
        })),
      }));

      const { TelemetryUploaderService } = await import('../../../src/host/telemetry/telemetryUploaderService');
      const service = new TelemetryUploaderService();

      // CIRCUIT_BREAKER_THRESHOLD = 3：前两次同因失败只应记 ERROR，不应触发熔断摘要。
      await service.upload();
      await service.upload();
      expect(mocks.logger.error).toHaveBeenCalledTimes(2);
      expect(mocks.logger.warn).not.toHaveBeenCalled();

      // 第三次达到阈值，触发熔断摘要。
      await service.upload();
      expect(mocks.logger.warn).toHaveBeenCalledTimes(1);

      // 服务端恢复后下一轮成功：健康状态记录成功时间，且不再是失败态。
      shouldFail = false;
      const uploaded = await service.upload();
      expect(uploaded).toBeGreaterThanOrEqual(0);
      expect(service.getUploadHealth().lastUploadAt).not.toBeNull();
    });
  });
});
