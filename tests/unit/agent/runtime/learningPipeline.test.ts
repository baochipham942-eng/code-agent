// ============================================================================
// LearningPipeline Tests (GAP-005)
// 测试：失败模式提取、成功模式提取（n-gram）、session 结束学习链路
// ============================================================================

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { TelemetryToolCall } from '../../../../src/shared/contract/telemetry';

// ── Mocks ──

vi.mock('../../../../src/main/services/infra/logger', () => ({
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

vi.mock('../../../../src/main/telemetry/telemetryStorage', () => ({
  getTelemetryStorage: () => ({
    getToolCallsBySession: telemetryMocks.getToolCallsBySession,
  }),
}));

const journalMocks = vi.hoisted(() => ({
  recordFailurePatterns: vi.fn(async () => 1),
}));

// 保留纯函数（buildFailurePatternKey / normalizeErrorMessage），只 mock 落盘
vi.mock('../../../../src/main/lightMemory/failureJournal', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../../../src/main/lightMemory/failureJournal')>();
  return {
    ...original,
    recordFailurePatterns: journalMocks.recordFailurePatterns,
  };
});

// failureJournal 原模块依赖 configPaths（路径函数仅在落盘时调用，这里兜底 mock）
vi.mock('../../../../src/main/config/configPaths', () => ({
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

vi.mock('../../../../src/main/services/skills/skillDraftQueue', () => ({
  enqueueSkillDraft: draftMocks.enqueueSkillDraft,
}));

// LLM 复盘链：mock 掉语义复盘器，单测只验"复盘命中 → 入队 + 发事件"的接线
const reviewMocks = vi.hoisted(() => ({
  reviewConversationForSkill: vi.fn<() => Promise<unknown>>(async () => null),
}));

vi.mock('../../../../src/main/lightMemory/conversationReview', () => ({
  reviewConversationForSkill: reviewMocks.reviewConversationForSkill,
}));

import {
  LearningPipeline,
  extractFailurePatterns,
  extractSuccessPatterns,
  suggestSkillName,
} from '../../../../src/main/agent/runtime/learningPipeline';
import { LEARNING_PIPELINE } from '../../../../src/shared/constants';

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

describe('extractSuccessPatterns', () => {
  beforeEach(() => {
    callCounter = 0;
  });

  it('should return empty when no sequence repeats enough', () => {
    const calls = [
      makeToolCall({ name: 'Grep' }),
      makeToolCall({ name: 'Read' }),
      makeToolCall({ name: 'Edit' }),
    ];
    expect(extractSuccessPatterns(calls)).toEqual([]);
  });

  it('should extract repeated tool sequence (>= 3 occurrences)', () => {
    const calls: TelemetryToolCall[] = [];
    for (let i = 0; i < 3; i++) {
      calls.push(makeToolCall({ name: 'Grep', arguments: '{"pattern":"foo"}' }));
      calls.push(makeToolCall({ name: 'Read', arguments: '{"file_path":"/a.ts"}' }));
      calls.push(makeToolCall({ name: 'Edit', arguments: '{"file_path":"/a.ts"}' }));
    }
    const patterns = extractSuccessPatterns(calls);
    expect(patterns.length).toBeGreaterThan(0);

    // 最长的合格序列应该是 Grep → Read → Edit ... 子序列被去重
    const keys = patterns.map((pattern) => pattern.key);
    expect(keys.some((key) => key.includes('Grep') && key.includes('Edit'))).toBe(true);
    // 子序列 Grep → Read 不应该单独出现（被更长序列覆盖）
    expect(keys).not.toContain('Grep → Read');
  });

  it('should break sequences at failed calls', () => {
    const calls: TelemetryToolCall[] = [];
    for (let i = 0; i < 3; i++) {
      calls.push(makeToolCall({ name: 'Grep' }));
      calls.push(makeFailedCall('Read', 'no such file'));
      calls.push(makeToolCall({ name: 'Edit' }));
    }
    // Grep 和 Edit 之间被失败的 Read 隔断，不会形成 Grep → Edit 序列
    const patterns = extractSuccessPatterns(calls);
    expect(patterns.every((pattern) => !pattern.key.includes('Grep → Edit'))).toBe(true);
  });

  it('should record example args from first occurrence', () => {
    const calls: TelemetryToolCall[] = [];
    for (let i = 0; i < 3; i++) {
      calls.push(makeToolCall({ name: 'Grep', arguments: '{"pattern":"first"}' }));
      calls.push(makeToolCall({ name: 'Read', arguments: '{"file_path":"/first.ts"}' }));
    }
    const patterns = extractSuccessPatterns(calls);
    const pattern = patterns.find((entry) => entry.key === 'Grep → Read');
    expect(pattern).toBeDefined();
    expect(pattern!.exampleSteps[0].args).toEqual({ pattern: 'first' });
  });
});

describe('suggestSkillName', () => {
  it('should build kebab-case name from tool sequence', () => {
    expect(suggestSkillName(['Grep', 'Read', 'Edit'])).toBe('grep-read-edit');
  });

  it('should fall back for empty sequence', () => {
    expect(suggestSkillName([])).toBe('distilled-workflow');
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

  it('runSkillDistillation should enqueue drafts and emit confirmation event (never auto-install)', async () => {
    const calls: TelemetryToolCall[] = [];
    for (let i = 0; i < LEARNING_PIPELINE.SUCCESS_PATTERN_THRESHOLD; i++) {
      calls.push(makeToolCall({ name: 'Grep' }));
      calls.push(makeToolCall({ name: 'Read' }));
    }
    telemetryMocks.getToolCallsBySession.mockReturnValue(calls);

    const ctx = makeCtx('session-skill');
    const pipeline = new LearningPipeline(ctx);
    await pipeline.runSkillDistillation();

    expect(draftMocks.enqueueSkillDraft).toHaveBeenCalled();
    // 通知用户确认（ctx.onEvent → run SSE 流 → renderer，与 memory_learned 同通路）
    expect(ctx.onEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'skill_draft_pending',
        data: expect.objectContaining({
          sessionId: 'session-skill',
          drafts: expect.arrayContaining([
            expect.objectContaining({ name: expect.any(String), occurrences: expect.any(Number) }),
          ]),
        }),
      }),
    );
  });

  it('runSkillDistillation should not emit event when all drafts are deduped', async () => {
    const calls: TelemetryToolCall[] = [];
    for (let i = 0; i < LEARNING_PIPELINE.SUCCESS_PATTERN_THRESHOLD; i++) {
      calls.push(makeToolCall({ name: 'Grep' }));
      calls.push(makeToolCall({ name: 'Read' }));
    }
    telemetryMocks.getToolCallsBySession.mockReturnValue(calls);
    draftMocks.enqueueSkillDraft.mockResolvedValueOnce(null as never);

    const ctx = makeCtx();
    const pipeline = new LearningPipeline(ctx);
    await pipeline.runSkillDistillation();

    expect(ctx.onEvent).not.toHaveBeenCalled();
  });

  it('runSessionEndLearning should run both passes from telemetry', async () => {
    const calls: TelemetryToolCall[] = [
      // 3 次相同失败
      makeFailedCall('Bash', 'timeout after 30s', 'timeout'),
      makeFailedCall('Bash', 'timeout after 60s', 'timeout'),
      makeFailedCall('Bash', 'timeout after 90s', 'timeout'),
    ];
    // 3 次相同成功序列
    for (let i = 0; i < 3; i++) {
      calls.push(makeToolCall({ name: 'Grep' }));
      calls.push(makeToolCall({ name: 'Read' }));
    }
    telemetryMocks.getToolCallsBySession.mockReturnValue(calls);

    const ctx = makeCtx('session-both');
    const pipeline = new LearningPipeline(ctx);
    await pipeline.runSessionEndLearning();

    expect(journalMocks.recordFailurePatterns).toHaveBeenCalledTimes(1);
    expect(draftMocks.enqueueSkillDraft).toHaveBeenCalled();
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
    await new LearningPipeline(ctx).runConversationReviewDistillation();

    expect(draftMocks.enqueueSkillDraft).toHaveBeenCalledTimes(1);
    const arg = draftMocks.enqueueSkillDraft.mock.calls[0][0] as Record<string, unknown>;
    expect(arg.origin).toBe('llm-review');
    expect(arg.patternKey).toBe('llm-review:deploy-tauri-macos');
    expect(arg.body).toContain('tauri-install.sh');
    expect(arg.name).toBe('deploy-tauri-macos');

    expect(ctx.onEvent).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'skill_draft_pending' }),
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
