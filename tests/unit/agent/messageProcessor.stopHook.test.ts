// ============================================================================
// MessageProcessor Stop Hook Tests — GAP-006: 完成闸 + 重试安全阀
// ============================================================================

import { ArtifactState } from '../../../src/host/agent/runtime/artifactState';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { RuntimeContext } from '../../../src/host/agent/runtime/runtimeContext';
import type { ContextAssembly } from '../../../src/host/agent/runtime/contextAssembly';
import type { RunFinalizer } from '../../../src/host/agent/runtime/runFinalizer';
import type { ToolExecutionEngine } from '../../../src/host/agent/runtime/toolExecutionEngine';
import { STOP_HOOK } from '../../../src/shared/constants';

const sessionManagerState = vi.hoisted(() => ({
  addMessage: vi.fn(),
  addMessageToSession: vi.fn(),
}));

vi.mock('../../../src/host/services', () => ({
  getSessionManager: () => sessionManagerState,
}));

vi.mock('../../../src/host/services/infra/logger', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

vi.mock('../../../src/host/mcp/logCollector.js', () => ({
  logCollector: {
    agent: vi.fn(),
    tool: vi.fn(),
    browser: {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    },
  },
}));

import { MessageProcessor } from '../../../src/host/agent/runtime/messageProcessor';
import { TurnState } from '../../../src/host/agent/runtime/turnState';
import { ControlState } from '../../../src/host/agent/runtime/controlState';
import { ContextHealthState } from '../../../src/host/agent/runtime/contextHealthState';
import { RunStatsState } from '../../../src/host/agent/runtime/runStatsState';

// 见 messageProcessor.persistence.test.ts 同名类型的注释：RuntimeContext 的多个
// 嵌套字段（NudgeManager、TelemetryAdapter...）这里只 mock 了用到的那几个方法，
// 标准 Partial<T> 不做深层可选，会导致这类局部 mock 类型报错。
type DeepPartial<T> = T extends (infer U)[]
  ? DeepPartial<U>[]
  : T extends object
    ? { -readonly [P in keyof T]?: DeepPartial<T[P]> }
    : T;

function createProcessor(
  ctx: DeepPartial<RuntimeContext>,
  contextAssembly: Partial<ContextAssembly> = {},
  runFinalizer: Partial<RunFinalizer> = {},
  toolEngine: Partial<ToolExecutionEngine> = {},
): MessageProcessor {
  if (!ctx.turnQualityState) {
    ctx.turnQualityState = {};
  }
  return new MessageProcessor(
    ctx as RuntimeContext,
    contextAssembly as ContextAssembly,
    runFinalizer as RunFinalizer,
    toolEngine as ToolExecutionEngine,
  );
}

function buildCtx(overrides: Record<string, unknown> = {}) {
  return {
    sessionId: 'runtime-session-1',
    messages: [{ id: 'user-1', role: 'user', content: '帮我修这个 bug', timestamp: Date.now() }],
    artifact: ArtifactState.forTest(),
    modelConfig: { provider: 'zhipu', model: 'glm-5', maxTokens: 16384 },
    contextHealth: ContextHealthState.forTest({ currentSystemPromptHash: 'hash-1' } as never),
    MAX_CONSECUTIVE_TRUNCATIONS: 3,
    planningService: undefined,
    turn: TurnState.forTest({ effortLevel: 'medium', currentTurnId: 'turn-1', currentIterationSpanId: 'iteration-1', researchModeActive: false, toolsUsedInTurn: [], isSimpleTaskMode: false } as never),
    turnQualityState: {},
    // 注：原来这里还有一个更早的 `control:` 键（{ isCancelled: false }，对象字面量
    // 重复键 TS1117），JS 运行时只有后面这个生效（ControlState 默认 isCancelled
    // 就是 false），故删掉死代码，不改变既有行为。
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

function buildRunFinalizer() {
  return {
    emitTaskProgress: vi.fn(),
    emitTaskComplete: vi.fn(),
    tryParseTodosFromResponse: vi.fn(),
  };
}

const completeTextResponse = {
  type: 'text' as const,
  content: '任务已完成，所有测试通过。',
  finishReason: 'stop' as const,
  usage: { inputTokens: 1000, outputTokens: 100 },
};

describe('MessageProcessor user stop hook (GAP-006)', () => {
  beforeEach(() => {
    sessionManagerState.addMessage.mockReset();
    sessionManagerState.addMessageToSession.mockReset();
    sessionManagerState.addMessageToSession.mockResolvedValue(undefined);
  });

  it('blocks stop and continues working when user stop hook returns block', async () => {
    const triggerStop = vi.fn(async () => ({
      shouldProceed: false,
      message: 'tests are still failing, keep fixing',
      results: [],
      totalDuration: 1,
    }));
    const ctx = buildCtx({ hookManager: { triggerStop } });
    const contextAssembly = buildContextAssembly(ctx);
    const processor = createProcessor(ctx as DeepPartial<RuntimeContext>, contextAssembly, buildRunFinalizer());

    const action = await processor.handleTextResponse(
      completeTextResponse,
      false,
      1,
      false,
      { endSpan: vi.fn() },
    );

    expect(action).toBe('continue');
    expect(triggerStop).toHaveBeenCalledWith('任务已完成，所有测试通过。', 'runtime-session-1', false);
    expect(processor.guardStateForTest.userStopHookBlockCount).toBe(1);
    expect(contextAssembly.injectSystemMessage).toHaveBeenCalledWith(
      '<stop-hook>\ntests are still failing, keep fixing\n</stop-hook>',
    );
  });

  it('passes stopHookActive=true on retried stop and allows stop after valve limit', async () => {
    const triggerStop = vi.fn(async () => ({
      shouldProceed: false,
      message: 'still not done',
      results: [],
      totalDuration: 1,
    }));
    // 已经 block 过 USER_MAX_RETRIES 次 → 本次 block 触发安全阀放行
    const ctx = buildCtx({ hookManager: { triggerStop } });
    const contextAssembly = buildContextAssembly(ctx);
    const runFinalizer = buildRunFinalizer();
    const processor = createProcessor(ctx as DeepPartial<RuntimeContext>, contextAssembly, runFinalizer);
    processor.guardStateForTest.userStopHookBlockCount = STOP_HOOK.USER_MAX_RETRIES;

    const action = await processor.handleTextResponse(
      completeTextResponse,
      false,
      2,
      false,
      { endSpan: vi.fn() },
    );

    // 安全阀生效：不再 continue，走完整完成路径
    expect(action).toBe('break');
    expect(triggerStop).toHaveBeenCalledWith('任务已完成，所有测试通过。', 'runtime-session-1', true);
    expect(processor.guardStateForTest.userStopHookBlockCount).toBe(STOP_HOOK.USER_MAX_RETRIES + 1);
    // 安全阀触发时通知用户
    expect(ctx.onEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'notification',
        data: expect.objectContaining({ message: expect.stringContaining('重试上限') }),
      }),
    );
    // 完成路径正常收尾
    expect(contextAssembly.addAndPersistMessage).toHaveBeenCalledWith(
      expect.objectContaining({ role: 'assistant' }),
    );
    expect(runFinalizer.emitTaskComplete).toHaveBeenCalled();
  });

  it('injects stop hook message and proceeds when hook allows stop', async () => {
    const triggerStop = vi.fn(async () => ({
      shouldProceed: true,
      message: 'all checks passed',
      results: [],
      totalDuration: 1,
    }));
    const ctx = buildCtx({ hookManager: { triggerStop } });
    const contextAssembly = buildContextAssembly(ctx);
    const runFinalizer = buildRunFinalizer();
    const processor = createProcessor(ctx as DeepPartial<RuntimeContext>, contextAssembly, runFinalizer);

    const action = await processor.handleTextResponse(
      completeTextResponse,
      false,
      1,
      false,
      { endSpan: vi.fn() },
    );

    expect(action).toBe('break');
    expect(processor.guardStateForTest.userStopHookBlockCount).toBe(0);
    expect(contextAssembly.injectSystemMessage).toHaveBeenCalledWith(
      '<stop-hook>\nall checks passed\n</stop-hook>',
    );
    expect(runFinalizer.emitTaskComplete).toHaveBeenCalled();
  });

  it('skips user stop hook for simple tasks', async () => {
    const triggerStop = vi.fn();
    const ctx = buildCtx({ hookManager: { triggerStop } });
    const contextAssembly = buildContextAssembly(ctx);
    const processor = createProcessor(ctx as DeepPartial<RuntimeContext>, contextAssembly, buildRunFinalizer());

    const action = await processor.handleTextResponse(
      completeTextResponse,
      true, // isSimpleTask
      1,
      false,
      { endSpan: vi.fn() },
    );

    expect(action).toBe('break');
    expect(triggerStop).not.toHaveBeenCalled();
  });
});
