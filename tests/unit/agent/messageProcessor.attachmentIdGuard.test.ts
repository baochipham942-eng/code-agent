// ============================================================================
// N-CAP-NOTICE-LEAK：占位后台子代理 `Cannot read properties of undefined
// (reading 'startsWith')` 的回归钉子。
// ============================================================================
// 真机实录（realrun20 07/08）：delegate_task 派出的占位后台子代理纯文本收尾时
// 整轮失败，错误就是上面这句。落点 = handleTextResponse 的 appshot 判定：
// `attachment.id.startsWith('appshot-')`。后台槽继承主会话历史，历史里的附件
// 在持久化/回放链路里可能缺 id（messageAttachments.ts 顶注 2026-08-07 同型事故，
// 当时修了 converter.ts，漏了这处）。缺 id 的附件必须走 getAttachmentId 兜底，
// 绝不能让一条脏附件炸穿整轮回复。
// ============================================================================

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { RuntimeContext } from '../../../src/host/agent/runtime/runtimeContext';
import type { ContextAssembly } from '../../../src/host/agent/runtime/contextAssembly';
import type { RunFinalizer } from '../../../src/host/agent/runtime/runFinalizer';
import type { ToolExecutionEngine } from '../../../src/host/agent/runtime/toolExecutionEngine';
import { ArtifactState } from '../../../src/host/agent/runtime/artifactState';
import { TurnState } from '../../../src/host/agent/runtime/turnState';
import { ControlState } from '../../../src/host/agent/runtime/controlState';
import { ContextHealthState } from '../../../src/host/agent/runtime/contextHealthState';
import { RunStatsState } from '../../../src/host/agent/runtime/runStatsState';
import { MessageProcessor } from '../../../src/host/agent/runtime/messageProcessor';

vi.mock('../../../src/host/services/infra/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

vi.mock('../../../src/host/mcp/logCollector.js', () => ({
  logCollector: {
    agent: vi.fn(),
    tool: vi.fn(),
    browser: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  },
}));

vi.mock('../../../src/host/services', () => ({
  getSessionManager: () => ({
    addMessage: vi.fn(),
    addMessageToSession: vi.fn(),
  }),
}));

// 数组分支必须保留 readonly（如 ArtifactState.lastDeliverableCheck 里的
// readonly DeliverablePlaceholderHit[]）：映射成可变数组会让真值反而不兼容
// DeepPartial 目标型（tsc-tests 门 2 处 TS2345 的根因），也丢掉只读契约。
type DeepPartial<T> = T extends readonly (infer U)[]
  ? readonly DeepPartial<U>[]
  : T extends object
    ? { -readonly [P in keyof T]?: DeepPartial<T[P]> }
    : T;

function createProcessor(
  ctx: DeepPartial<RuntimeContext>,
  contextAssembly: Partial<ContextAssembly>,
  runFinalizer: Partial<RunFinalizer>,
  toolEngine: Partial<ToolExecutionEngine>,
): MessageProcessor {
  if (!ctx.turnQualityState) ctx.turnQualityState = {};
  return new MessageProcessor(
    ctx as RuntimeContext,
    contextAssembly as ContextAssembly,
    runFinalizer as RunFinalizer,
    toolEngine as ToolExecutionEngine,
  );
}

function buildCtx(overrides: Record<string, unknown> = {}) {
  return {
    sessionId: 'bg-slot-session-1',
    // 后台槽继承的主会话用户消息：附件在持久化/回放后缺 id（脏数据形状，见
    // shared/utils/messageAttachments.ts 顶注的真实事故记录）
    messages: [{
      id: 'user-1',
      role: 'user' as const,
      content: '请分析这个 sales.csv：按地区汇总金额，告诉我哪个地区最高。',
      timestamp: Date.now(),
      attachments: [{ type: 'file', category: 'document', name: 'sales.csv', size: 512 } as never],
    }],
    artifact: ArtifactState.forTest(),
    modelConfig: { provider: 'zhipu', model: 'glm-5.3', maxTokens: 16384 },
    contextHealth: ContextHealthState.forTest(),
    MAX_CONSECUTIVE_TRUNCATIONS: 3,
    planningService: undefined,
    turn: TurnState.forTest({ effortLevel: 'medium', currentTurnId: 'turn-1', currentIterationSpanId: 'iteration-1', researchModeActive: false, toolsUsedInTurn: [], isSimpleTaskMode: false } as never),
    turnQualityState: {},
    control: ControlState.forTest({} as never),
    stats: RunStatsState.forTest({ totalToolCallCount: 0 } as never),
    nudgeManager: {
      runNudgeChecks: vi.fn(() => false),
      runOutputValidation: vi.fn(() => false),
      getModifiedFiles: vi.fn(() => new Set<string>()),
    },
    onEvent: vi.fn(),
    telemetryAdapter: { onTurnEnd: vi.fn() },
    ...overrides,
  };
}

function buildContextAssembly(ctx: { messages: unknown[] }) {
  return {
    stripInternalFormatMimicry: vi.fn((content: string) => content),
    generateId: vi.fn().mockReturnValue('assistant-message-1'),
    addAndPersistMessage: vi.fn(async (message: unknown) => {
      ctx.messages.push(message);
    }),
    injectSystemMessage: vi.fn(),
    updateContextHealth: vi.fn(),
  };
}

function buildLangfuse() {
  return { endSpan: vi.fn(), startSpan: vi.fn().mockReturnValue('span-1') };
}

function buildRunFinalizer() {
  return {
    emitTaskProgress: vi.fn(),
    emitTaskComplete: vi.fn(),
    checkAndEmitBudgetStatus: vi.fn(() => false),
    tryParseTodosFromResponse: vi.fn(),
    finalizeRun: vi.fn(),
  };
}

describe('handleTextResponse 对缺 id 附件的兜底（占位子代理 startsWith 崩溃）', () => {
  let ctx: ReturnType<typeof buildCtx>;
  let assembly: ReturnType<typeof buildContextAssembly>;

  beforeEach(() => {
    vi.clearAllMocks();
    ctx = buildCtx();
    assembly = buildContextAssembly(ctx);
  });

  it('历史消息里带缺 id 附件时，纯文本收尾不抛 TypeError，回复照常落库', async () => {
    const processor = createProcessor(
      ctx,
      assembly,
      buildRunFinalizer(),
      { resetRepairGate: vi.fn() },
    );

    // 修复前：这里 reject `Cannot read properties of undefined (reading 'startsWith')`
    await expect(
      processor.handleTextResponse({ type: 'text', content: '无需执行任何操作。' }, false, 1, true, buildLangfuse()),
    ).resolves.toBe('break');

    const finalAssistant = [...ctx.messages].reverse().find((m) => (m as { role?: string }).role === 'assistant');
    expect((finalAssistant as { content?: string }).content).toBe('无需执行任何操作。');
  });

  it('附件 id 正常时行为不变：非 appshot 附件不触发桌面证据通道', async () => {
    ctx.messages = [{
      id: 'user-2',
      role: 'user' as const,
      content: '继续分析',
      timestamp: Date.now(),
      attachments: [{ id: 'file-1', type: 'file', category: 'document', name: 'sales.csv', size: 512 } as never],
    }];
    const processor = createProcessor(
      ctx,
      assembly,
      buildRunFinalizer(),
      { resetRepairGate: vi.fn() },
    );

    await expect(
      processor.handleTextResponse({ type: 'text', content: '已完成汇总。' }, false, 1, true, buildLangfuse()),
    ).resolves.toBe('break');
  });
});
