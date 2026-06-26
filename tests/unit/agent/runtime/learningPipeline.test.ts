// ============================================================================
// LearningPipeline Tests (GAP-005)
// 测试：失败模式提取、成功模式提取（n-gram）、session 结束学习链路
// ============================================================================

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { TelemetryToolCall } from '../../../../src/shared/contract/telemetry';

// ── Mocks ──

vi.mock('../../../../src/host/services/infra/logger', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

const telemetryMocks = vi.hoisted(() => ({
  getToolCallsBySession: vi.fn<(sessionId: string) => unknown[]>(() => []),
}));

vi.mock('../../../../src/host/telemetry/telemetryStorage', () => ({
  getTelemetryStorage: () => ({
    getToolCallsBySession: telemetryMocks.getToolCallsBySession,
  }),
}));

const journalMocks = vi.hoisted(() => ({
  recordFailurePatterns: vi.fn(async () => 1),
}));

// 保留纯函数（buildFailurePatternKey / normalizeErrorMessage），只 mock 落盘
vi.mock('../../../../src/host/lightMemory/failureJournal', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../../../src/host/lightMemory/failureJournal')>();
  return {
    ...original,
    recordFailurePatterns: journalMocks.recordFailurePatterns,
  };
});

// failureJournal 原模块依赖 configPaths（路径函数仅在落盘时调用，这里兜底 mock）
vi.mock('../../../../src/host/config/configPaths', () => ({
  getUserConfigDir: () => '/tmp/lp-test-config',
  getSkillsDir: () => ({
    user: { new: '/tmp/lp-test-config/skills', legacy: '/tmp/lp-test-config/skills-legacy' },
  }),
}));

const draftMocks = vi.hoisted(() => ({
  enqueueSkillDraft: vi.fn(async (input: {
    name: string;
    description: string;
    toolSequence?: string[];
    occurrences?: number;
    origin?: string;
  }) => ({
    id: `${input.name}-1`,
    name: input.name,
    description: input.description,
    toolSequence: input.toolSequence ?? [],
    occurrences: input.occurrences ?? 0,
    origin: input.origin ?? 'telemetry-distilled',
    status: 'pending',
  })),
}));

vi.mock('../../../../src/host/services/skills/skillDraftQueue', () => ({
  enqueueSkillDraft: draftMocks.enqueueSkillDraft,
}));

// LLM 复盘链：mock 掉语义复盘器，单测只验"复盘命中 → 入队 + 发事件"的接线
const reviewMocks = vi.hoisted(() => ({
  reviewConversationForSkill: vi.fn<() => Promise<unknown>>(async () => null),
}));

vi.mock('../../../../src/host/lightMemory/conversationReview', () => ({
  reviewConversationForSkill: reviewMocks.reviewConversationForSkill,
}));

import {
  LearningPipeline,
  extractFailurePatterns,
} from '../../../../src/host/agent/runtime/learningPipeline';
import { onRendererPush } from '../../../../src/host/platform/windowBridge';
import type { AgentEvent } from '../../../../src/shared/contract';

// ── Fixtures ──

let callCounter = 0;

function makeToolCall(overrides: Partial<TelemetryToolCall> = {}): TelemetryToolCall {
  callCounter++;
  return {
    id: `tc-${callCounter}`,
    toolCallId: `call-${callCounter}`,
    name: 'Bash',
    arguments: '{"command":"ls"}',
    resultSummary: 'ok',
    success: true,
    durationMs: 100,
    timestamp: callCounter * 1000,
    index: callCounter,
    parallel: false,
    ...overrides,
  };
}

function makeFailedCall(name: string, error: string, category = 'command_failure'): TelemetryToolCall {
  return makeToolCall({
    name,
    success: false,
    error,
    errorCategory: category as TelemetryToolCall['errorCategory'],
  });
}

function makeCtx(sessionId = 'session-1', messages: Array<{ role: string; content: string }> = []) {
  return {
    sessionId,
    onEvent: vi.fn(),
    messages,
  } as unknown as ConstructorParameters<typeof LearningPipeline>[0];
}

function captureRendererPushes() {
  const pushes: Array<{ channel: string; data: unknown }> = [];
  const dispose = onRendererPush((channel, data) => {
    pushes.push({ channel, data });
  });
  return { pushes, dispose };
}

function findSkillDraftPush(pushes: Array<{ channel: string; data: unknown }>) {
  return pushes.find((push) => (
    push.channel === 'agent:event'
    && (push.data as AgentEvent | undefined)?.type === 'skill_draft_pending'
  ));
}

// ── Tests ──

describe('extractFailurePatterns', () => {
  beforeEach(() => {
    callCounter = 0;
  });

  it('should return empty for all-success calls', () => {
    const calls = [makeToolCall(), makeToolCall(), makeToolCall()];
    expect(extractFailurePatterns(calls, 's1')).toEqual([]);
  });

  it('should ignore failures below threshold', () => {
    const calls = [
      makeFailedCall('Bash', 'npm test failed with 3 errors'),
      makeFailedCall('Bash', 'npm test failed with 5 errors'),
    ];
    expect(extractFailurePatterns(calls, 's1')).toEqual([]);
  });

  it('should extract pattern when same failure occurs >= 3 times (numbers normalized)', () => {
    const calls = [
      makeFailedCall('Bash', 'npm test failed with 3 errors'),
      makeFailedCall('Bash', 'npm test failed with 5 errors'),
      makeFailedCall('Bash', 'npm test failed with 7 errors'),
    ];
    const patterns = extractFailurePatterns(calls, 's1');
    expect(patterns).toHaveLength(1);
    expect(patterns[0].count).toBe(3);
    expect(patterns[0].toolName).toBe('Bash');
    expect(patterns[0].pattern).toBe('npm test failed with N errors');
    expect(patterns[0].sessions).toEqual(['s1']);
  });

  it('should keep different tools as separate patterns', () => {
    const calls = [
      ...Array.from({ length: 3 }, () => makeFailedCall('Bash', 'timeout after 30s', 'timeout')),
      ...Array.from({ length: 3 }, () => makeFailedCall('Read', 'no such file', 'file_not_found')),
    ];
    const patterns = extractFailurePatterns(calls, 's1');
    expect(patterns).toHaveLength(2);
  });
});

describe('LearningPipeline', () => {
  beforeEach(() => {
    callCounter = 0;
    vi.clearAllMocks();
    telemetryMocks.getToolCallsBySession.mockReturnValue([]);
  });

  it('runSessionEndLearning should no-op when telemetry has no tool calls', async () => {
    const ctx = makeCtx();
    const pipeline = new LearningPipeline(ctx);
    await pipeline.runSessionEndLearning();

    expect(journalMocks.recordFailurePatterns).not.toHaveBeenCalled();
    expect(draftMocks.enqueueSkillDraft).not.toHaveBeenCalled();
  });

  it('runErrorPatternLearning should record patterns and emit memory_learned', async () => {
    const calls = [
      makeFailedCall('Bash', 'npm test failed with 3 errors'),
      makeFailedCall('Bash', 'npm test failed with 5 errors'),
      makeFailedCall('Bash', 'npm test failed with 7 errors'),
    ];
    telemetryMocks.getToolCallsBySession.mockReturnValue(calls);

    const ctx = makeCtx('session-err');
    const pipeline = new LearningPipeline(ctx);
    await pipeline.runErrorPatternLearning();

    expect(journalMocks.recordFailurePatterns).toHaveBeenCalledTimes(1);
    const recorded = journalMocks.recordFailurePatterns.mock.calls[0][0] as Array<{ count: number }>;
    expect(recorded[0].count).toBe(3);

    expect(ctx.onEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'memory_learned',
        data: expect.objectContaining({ sessionId: 'session-err', knowledgeExtracted: 1 }),
      }),
    );
  });

  it('runSessionEndLearning should run failure pass from telemetry (telemetry n-gram 蒸馏已移除)', async () => {
    const calls: TelemetryToolCall[] = [
      // 3 次相同失败 → failure journal
      makeFailedCall('Bash', 'timeout after 30s', 'timeout'),
      makeFailedCall('Bash', 'timeout after 60s', 'timeout'),
      makeFailedCall('Bash', 'timeout after 90s', 'timeout'),
    ];
    // 3 次相同成功序列：曾会被 n-gram 蒸馏成草稿，移除后不再产出任何草稿
    for (let i = 0; i < 3; i++) {
      calls.push(makeToolCall({ name: 'Grep' }));
      calls.push(makeToolCall({ name: 'Read' }));
    }
    telemetryMocks.getToolCallsBySession.mockReturnValue(calls);

    const ctx = makeCtx('session-both'); // 无对话消息 → conversationReview 也跳过
    const pipeline = new LearningPipeline(ctx);
    await pipeline.runSessionEndLearning();

    expect(journalMocks.recordFailurePatterns).toHaveBeenCalledTimes(1);
    // telemetry 成功序列不再生成 skill 草稿
    expect(draftMocks.enqueueSkillDraft).not.toHaveBeenCalled();
  });

  it('should survive telemetry storage errors gracefully', async () => {
    telemetryMocks.getToolCallsBySession.mockImplementation(() => {
      throw new Error('db unavailable');
    });

    const ctx = makeCtx();
    const pipeline = new LearningPipeline(ctx);
    await expect(pipeline.runSessionEndLearning()).resolves.toBeUndefined();
  });
});

// ── LLM 语义复盘链（runConversationReviewDistillation）──

describe('runConversationReviewDistillation', () => {
  const convo = [
    { role: 'user', content: '帮我部署 Tauri 应用' },
    { role: 'assistant', content: '好的，已用安装脚本部署' },
    { role: 'user', content: '记住：以后部署都用 scripts/tauri-install.sh，别手动 cp' },
  ];

  beforeEach(() => {
    reviewMocks.reviewConversationForSkill.mockReset();
    reviewMocks.reviewConversationForSkill.mockResolvedValue(null);
    draftMocks.enqueueSkillDraft.mockClear();
  });

  it('复盘命中 → 以 origin=llm-review 入队 + 发 skill_draft_pending 事件', async () => {
    reviewMocks.reviewConversationForSkill.mockResolvedValue({
      shouldCreate: true,
      signal: 'remember_request',
      name: 'deploy-tauri-macos',
      description: '部署 Tauri 桌面应用的标准流程',
      body: '## 要点\n用 scripts/tauri-install.sh，手动 cp 会残留旧文件',
    });

    const ctx = makeCtx('session-review', convo);
    const { pushes, dispose } = captureRendererPushes();
    try {
      await new LearningPipeline(ctx).runConversationReviewDistillation();
    } finally {
      dispose();
    }

    expect(draftMocks.enqueueSkillDraft).toHaveBeenCalledTimes(1);
    const arg = draftMocks.enqueueSkillDraft.mock.calls[0][0] as Record<string, unknown>;
    expect(arg.origin).toBe('llm-review');
    expect(arg.patternKey).toBe('llm-review:deploy-tauri-macos');
    expect(arg.body).toContain('tauri-install.sh');
    expect(arg.name).toBe('deploy-tauri-macos');

    expect(ctx.onEvent).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'skill_draft_pending' }),
    );
    expect(findSkillDraftPush(pushes)?.data).toEqual(
      expect.objectContaining({
        type: 'skill_draft_pending',
        data: expect.objectContaining({
          sessionId: 'session-review',
          drafts: [
            expect.objectContaining({
              name: 'deploy-tauri-macos',
              description: '部署 Tauri 桌面应用的标准流程',
              origin: 'llm-review',
            }),
          ],
        }),
      }),
    );
  });

  it('复盘无可沉淀（返回 null）→ 不入队、不发事件', async () => {
    reviewMocks.reviewConversationForSkill.mockResolvedValue(null);

    const ctx = makeCtx('session-review-empty', convo);
    await new LearningPipeline(ctx).runConversationReviewDistillation();

    expect(draftMocks.enqueueSkillDraft).not.toHaveBeenCalled();
    expect(ctx.onEvent).not.toHaveBeenCalled();
  });

  it('用户轮数不足 → 不调用复盘器', async () => {
    const ctx = makeCtx('session-review-short', [{ role: 'user', content: '只有一轮' }]);
    await new LearningPipeline(ctx).runConversationReviewDistillation();

    expect(reviewMocks.reviewConversationForSkill).not.toHaveBeenCalled();
    expect(draftMocks.enqueueSkillDraft).not.toHaveBeenCalled();
  });
});
