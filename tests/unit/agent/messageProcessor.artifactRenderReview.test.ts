// ============================================================================
// MessageProcessor 接入点：docx 视觉审查补轮
// 声称已交付且文件在盘上，但渲染审查指出溢出 → continue 回喂。
// 反向变异：把 applyDeliverableCloseGates 里的视觉审查调用摘掉，本文件必须红。
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
import { writeOverflowDocx } from './runtime/artifactRenderReview.fixtures';

const sessionManagerState = vi.hoisted(() => ({
  addMessage: vi.fn(),
  addMessageToSession: vi.fn(),
}));

const visionMock = vi.hoisted(() => ({
  analyzeImageWithVision: vi.fn(async () => JSON.stringify({
    passed: false,
    issues: [{ kind: 'overflow', description: '右侧表格被裁切，最后一列看不见', severity: 'high' }],
  })),
}));

const rasterMock = vi.hoisted(() => ({
  isLibreOfficeAvailable: vi.fn(() => true),
  convertOfficeToPdf: vi.fn((input: string) => input.replace(/\.docx$/i, '.pdf')),
  rasterizePdfToImages: vi.fn(async (_pdf: string, outputDir: string) => {
    const page = path.join(outputDir, 'overflow-1.jpg');
    writeFileSync(page, 'img');
    return [page];
  }),
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

vi.mock('../../../src/host/services/desktop/visionAnalysisService', () => visionMock);

vi.mock('../../../src/host/tools/media/officeRaster', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/host/tools/media/officeRaster')>();
  return { ...actual, ...rasterMock };
});

import { MessageProcessor } from '../../../src/host/agent/runtime/messageProcessor';
import { TurnState } from '../../../src/host/agent/runtime/turnState';
import { ControlState } from '../../../src/host/agent/runtime/controlState';
import { ContextHealthState } from '../../../src/host/agent/runtime/contextHealthState';
import { RunStatsState } from '../../../src/host/agent/runtime/runStatsState';

type DeepPartial<T> = T extends (infer U)[]
  ? DeepPartial<U>[]
  : T extends object
    ? { -readonly [P in keyof T]?: DeepPartial<T[P]> }
    : T;

const workRoot = path.join(os.tmpdir(), `mp-artifact-render-${process.pid}-${Date.now()}`);

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

function buildCtx(filePath: string) {
  return {
    sessionId: 'runtime-session-1',
    workingDirectory: workRoot,
    artifact: ArtifactState.forTest(),
    messages: [
      { id: 'user-1', role: 'user', content: '做一份报告', timestamp: Date.now() },
      {
        id: 'wrote-1', role: 'assistant', content: '', timestamp: Date.now() + 1,
        toolCalls: [{ id: 'write-1', name: 'Write', arguments: { file_path: filePath } }],
        toolResults: [{ toolCallId: 'write-1', success: true, output: 'ok', metadata: { outputPath: filePath } }],
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
  };
}

describe('MessageProcessor artifact render review hook', () => {
  beforeEach(() => {
    sessionManagerState.addMessage.mockReset();
    sessionManagerState.addMessageToSession.mockReset();
    sessionManagerState.addMessageToSession.mockResolvedValue(undefined);
    mkdirSync(workRoot, { recursive: true });
    visionMock.analyzeImageWithVision.mockClear();
  });

  afterEach(() => {
    if (existsSync(workRoot)) rmSync(workRoot, { recursive: true, force: true });
  });

  it('overflow docx on disk is intercepted: repair round, not persisted', async () => {
    const filePath = path.join(workRoot, 'overflow.docx');
    await writeOverflowDocx(filePath);
    const ctx = buildCtx(filePath);
    const contextAssembly = {
      stripInternalFormatMimicry: vi.fn((content: string) => content),
      generateId: vi.fn().mockReturnValue('assistant-message-1'),
      addAndPersistMessage: vi.fn(async () => undefined),
      injectSystemMessage: vi.fn(),
      updateContextHealth: vi.fn(),
    };
    const processor = createProcessor(
      ctx as DeepPartial<RuntimeContext>,
      contextAssembly as Partial<ContextAssembly>,
      { emitTaskProgress: vi.fn(), emitTaskComplete: vi.fn(), tryParseTodosFromResponse: vi.fn() },
    );

    const action = await processor.handleTextResponse(
      { type: 'text', content: '已生成 `overflow.docx`，请查收。', finishReason: 'stop', usage: { inputTokens: 10, outputTokens: 8 } },
      false,
      2,
      false,
      { endSpan: vi.fn() },
    );

    expect(action).toBe('continue');
    expect(processor.guardStateForTest.artifactRenderRepairCount).toBe(1);
    expect(contextAssembly.injectSystemMessage).toHaveBeenCalledWith(
      expect.stringContaining('<artifact-render-review>'),
      'artifact-render-review',
    );
    expect(contextAssembly.injectSystemMessage).toHaveBeenCalledWith(
      expect.stringContaining('右侧表格被裁切'),
      'artifact-render-review',
    );
    expect(contextAssembly.addAndPersistMessage).not.toHaveBeenCalled();
    expect(ctx.artifact.renderReview?.status).toBe('failed');
  });
});
