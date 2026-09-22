// ============================================================================
// MessageProcessor 交付物落盘核对（issue #1998）— 补轮闭环
// 声称交付且文件在 → 放行收尾（break）；声称交付但文件缺 → 回喂补一轮（continue），
// 预算（TURN_OUTCOME.MAX_DELIVERABLE_REPAIR_ROUNDS）用尽仍缺 → break 且 final 如实说明。
// ============================================================================

import { ArtifactState } from '../../../src/host/agent/runtime/artifactState';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { RuntimeContext } from '../../../src/host/agent/runtime/runtimeContext';
import type { ContextAssembly } from '../../../src/host/agent/runtime/contextAssembly';
import type { RunFinalizer } from '../../../src/host/agent/runtime/runFinalizer';
import type { ToolExecutionEngine } from '../../../src/host/agent/runtime/toolExecutionEngine';

const sessionManagerState = vi.hoisted(() => ({
  addMessage: vi.fn(),
  addMessageToSession: vi.fn(),
}));

vi.mock('../../../src/host/services', () => ({
  getSessionManager: () => sessionManagerState,
}));

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

import { MessageProcessor } from '../../../src/host/agent/runtime/messageProcessor';
import { TurnState } from '../../../src/host/agent/runtime/turnState';
import { ControlState } from '../../../src/host/agent/runtime/controlState';
import { ContextHealthState } from '../../../src/host/agent/runtime/contextHealthState';
import { RunStatsState } from '../../../src/host/agent/runtime/runStatsState';

// 见 messageProcessor.deliveryCritic.test.ts 同名类型的注释：局部 mock 需要深层可选。
type DeepPartial<T> = T extends (infer U)[]
  ? DeepPartial<U>[]
  : T extends object
    ? { -readonly [P in keyof T]?: DeepPartial<T[P]> }
    : T;

const workRoot = path.join(os.tmpdir(), `mp-deliverable-check-${process.pid}-${Date.now()}`);

function createProcessor(
  ctx: DeepPartial<RuntimeContext>,
  contextAssembly: Partial<ContextAssembly> = {},
  runFinalizer: Partial<RunFinalizer> = {},
  toolEngine: Partial<ToolExecutionEngine> = {},
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
    sessionId: 'runtime-session-1',
    workingDirectory: workRoot,
    artifact: ArtifactState.forTest(),
    // 带一条成功的 Write 调用：推断声称只在本 run 有产出类工具活动时核对（纯问答不触发）。
    messages: [
      { id: 'user-1', role: 'user', content: '做一份周报页面', timestamp: Date.now() },
      {
        id: 'wrote-1', role: 'assistant', content: '', timestamp: Date.now() + 1,
        toolCalls: [{ id: 'write-1', name: 'Write', arguments: { file_path: 'out.html' } }],
        toolResults: [{ toolCallId: 'write-1', success: true, output: 'ok' }],
      },
    ],
    modelConfig: { provider: 'zhipu', model: 'glm-5', maxTokens: 16384 },
    contextHealth: ContextHealthState.forTest({ currentSystemPromptHash: 'hash-1' } as never),
    MAX_CONSECUTIVE_TRUNCATIONS: 3,
    hookManager: undefined,
    planningService: undefined,
    turn: TurnState.forTest({ effortLevel: 'medium', currentTurnId: 'turn-1', currentIterationSpanId: 'iteration-1', researchModeActive: false, toolsUsedInTurn: [], isSimpleTaskMode: false } as never),
    turnQualityState: {},
    control: ControlState.forTest({ runAbortController: { signal: { aborted: false } } } as never),
    stats: RunStatsState.forTest({ totalToolCallCount: 1 } as never),
    enableDeliveryCritic: false,
    nudgeManager: {
      runNudgeChecks: vi.fn(() => false),
      runOutputValidation: vi.fn(() => false),
      getModifiedFiles: vi.fn(() => new Set<string>()),
      getModifiedFilesSince: vi.fn(() => [] as string[]),
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

function textResponse(content: string) {
  return {
    type: 'text' as const,
    content,
    finishReason: 'stop' as const,
    usage: { inputTokens: 100, outputTokens: 50 },
  };
}

describe('MessageProcessor deliverable disk check (#1998)', () => {
  beforeEach(() => {
    sessionManagerState.addMessage.mockReset();
    sessionManagerState.addMessageToSession.mockReset();
    sessionManagerState.addMessageToSession.mockResolvedValue(undefined);
    mkdirSync(workRoot, { recursive: true });
  });

  afterEach(() => {
    if (existsSync(workRoot)) rmSync(workRoot, { recursive: true, force: true });
  });

  it('claims delivered and file exists → break without any repair injection', async () => {
    writeFileSync(path.join(workRoot, 'report.html'), '<html>周报</html>');
    const ctx = buildCtx();
    const contextAssembly = buildContextAssembly(ctx);
    const processor = createProcessor(ctx as DeepPartial<RuntimeContext>, contextAssembly, buildRunFinalizer());

    const action = await processor.handleTextResponse(
      textResponse('已生成 `report.html`，请查收。'),
      false,
      2,
      false,
      { endSpan: vi.fn() },
    );

    expect(action).toBe('break');
    expect(processor.guardStateForTest.deliverableRepairCount).toBe(0);
    expect(contextAssembly.injectSystemMessage).not.toHaveBeenCalledWith(
      expect.stringContaining('<deliverable-disk-check>'),
      'deliverable-disk-check',
    );
  });

  it('claims delivered but file missing → feeds back one bounded repair round', async () => {
    const ctx = buildCtx();
    const contextAssembly = buildContextAssembly(ctx);
    const processor = createProcessor(ctx as DeepPartial<RuntimeContext>, contextAssembly, buildRunFinalizer());

    const action = await processor.handleTextResponse(
      textResponse('已生成 `ghost.html`，请查收。'),
      false,
      2,
      false,
      { endSpan: vi.fn() },
    );

    expect(action).toBe('continue');
    expect(processor.guardStateForTest.deliverableRepairCount).toBe(1);
    expect(contextAssembly.injectSystemMessage).toHaveBeenCalledWith(
      expect.stringContaining('<deliverable-disk-check>'),
      'deliverable-disk-check',
    );
    expect(contextAssembly.injectSystemMessage).toHaveBeenCalledWith(
      expect.stringContaining(path.join(workRoot, 'ghost.html')),
      'deliverable-disk-check',
    );
    // 补轮拦截发生在落库前：幻觉回复不进账本。
    expect(contextAssembly.addAndPersistMessage).not.toHaveBeenCalled();
  });

  it('still missing after the repair budget → break and the final reply states what was not delivered', async () => {
    const ctx = buildCtx();
    const contextAssembly = buildContextAssembly(ctx);
    const processor = createProcessor(ctx as DeepPartial<RuntimeContext>, contextAssembly, buildRunFinalizer());
    processor.guardStateForTest.deliverableRepairCount = 1;

    const action = await processor.handleTextResponse(
      textResponse('已生成 `ghost.html`，请查收。'),
      false,
      3,
      false,
      { endSpan: vi.fn() },
    );

    expect(action).toBe('break');
    expect(contextAssembly.injectSystemMessage).not.toHaveBeenCalledWith(
      expect.stringContaining('<deliverable-disk-check>'),
      'deliverable-disk-check',
    );
    const persisted = contextAssembly.addAndPersistMessage.mock.calls[0][0] as { content: string };
    expect(persisted.content).toContain('本轮实际未交付');
    expect(persisted.content).toContain('ghost.html');
  });

  it('declared deliverable (declare_deliverables this run) missing → same repair round', async () => {
    const artifact = ArtifactState.forTest();
    artifact.declareDeliverables({ finalArtifacts: ['declared-missing.html'], declaredAtMs: Date.now() });
    const ctx = buildCtx({ artifact });
    const contextAssembly = buildContextAssembly(ctx);
    const processor = createProcessor(ctx as DeepPartial<RuntimeContext>, contextAssembly, buildRunFinalizer());

    const action = await processor.handleTextResponse(
      textResponse('做完了，如上所述。'),
      false,
      2,
      false,
      { endSpan: vi.fn() },
    );

    expect(action).toBe('continue');
    expect(contextAssembly.injectSystemMessage).toHaveBeenCalledWith(
      expect.stringContaining('declared-missing.html'),
      'deliverable-disk-check',
    );
  });

  it('references to the input materials directory (资料/) are not treated as deliverables', async () => {
    const ctx = buildCtx();
    const contextAssembly = buildContextAssembly(ctx);
    const processor = createProcessor(ctx as DeepPartial<RuntimeContext>, contextAssembly, buildRunFinalizer());

    const action = await processor.handleTextResponse(
      textResponse('已读取 资料/周报.md，总结如下。'),
      false,
      2,
      false,
      { endSpan: vi.fn() },
    );

    expect(action).toBe('break');
    expect(contextAssembly.injectSystemMessage).not.toHaveBeenCalledWith(
      expect.stringContaining('<deliverable-disk-check>'),
      'deliverable-disk-check',
    );
  });
});
