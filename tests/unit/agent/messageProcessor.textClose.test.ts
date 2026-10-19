// ============================================================================
// MessageProcessor text-close persistence（N-HOME-STARTER-CARDS-FILES-FU3-FU1）
// 纯文本收尾回答必须原样落库并退出循环。此前 P2b（task-tracking hint）在长活
// 零任务时于 runNudgeChecks 注入提示并让 handleTextResponse 提前 return 'continue'，
// 抢在 addAndPersistMessage 之前——已流式展示的收尾正文成孤儿草稿，模型看不到
// 自己的总结、下一轮重写一遍（FU3 真跑双重总结根因）。这里用真实 NudgeManager
// （不 mock 它自身的判定逻辑）钉住：长活纯文本收尾恰好落一条 assistant 消息。
// ============================================================================

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { ModelResponse } from '../../../src/host/agent/loopTypes';
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

vi.mock('../../../src/host/agent/runtime/gameArtifactValidator', () => ({
  validateGameArtifact: vi.fn(),
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
import { NudgeManager } from '../../../src/host/agent/nudgeManager';
import { GoalTracker } from '../../../src/host/agent/goalTracker';
import { TurnState } from '../../../src/host/agent/runtime/turnState';
import { ControlState } from '../../../src/host/agent/runtime/controlState';
import { ContextHealthState } from '../../../src/host/agent/runtime/contextHealthState';
import { RunStatsState } from '../../../src/host/agent/runtime/runStatsState';
import { ArtifactState } from '../../../src/host/agent/runtime/artifactState';

// 测试 fixture 用的深度可选类型（与 messageProcessor.persistence.test.ts 同款）：
// RuntimeContext 的多个字段本身是复杂类/接口，Partial<T> 只在顶层可选，局部 mock 会
// TS2352；DeepPartial 逐层可选，允许 `as RuntimeContext` 的双射断言。
type DeepPartial<T> = T extends (infer U)[]
  ? DeepPartial<U>[]
  : T extends object
    ? { -readonly [P in keyof T]?: DeepPartial<T[P]> }
    : T;

// 与真跑同源的 starter 卡片 prompt（src/renderer/i18n/chatTranscript.ts sheetAnalysis）：
// 含 .xlsx（userExpectsOutput=true）但不含任务类关键词（enforceTaskCompletion=false）。
const SHEET_CARD_PROMPT = '分析下面这份月度销售数据，并生成一个 Excel 工作簿（.xlsx）：包含原始数据工作表和汇总表，汇总整体趋势、增长最快与下滑最快的品类、异常点及 3 条可执行的改进建议，结论用表格收拢。请写入一个 .xlsx 文件，并在回复中说明生成的文件名。不要问我任何问题。';

describe('MessageProcessor text-only close with a real NudgeManager', () => {
  let workDir: string;

  beforeEach(() => {
    delete process.env.CODE_AGENT_CLI_MODE;
    delete process.env.CODE_AGENT_WEB_MODE;
    sessionManagerState.addMessage.mockReset();
    sessionManagerState.addMessageToSession.mockReset();
    sessionManagerState.addMessageToSession.mockResolvedValue(undefined);
    workDir = mkdtempSync(path.join(os.tmpdir(), 'p2b-text-close-'));
    return () => rmSync(workDir, { recursive: true, force: true });
  });

  it('persists exactly one assistant message at iteration 7 and does not continue (P2b retired)', async () => {
    // 真实 NudgeManager：todo/task 存取链无 DB 时自然返回空清单，P1-P5/P7/P0 的
    // 真实判定全部走过——此前 P2b 恰好在这个形状（iterations≥6 + 空清单 + 纯文本
    // 收尾）注入 <task-tracking-hint> 并让调用方 continue。
    const nudgeManager = new NudgeManager();
    nudgeManager.reset([], SHEET_CARD_PROMPT, workDir, []);

    const ctx = {
      stats: RunStatsState.forTest({ totalToolCallCount: 12 } as never),
      contextHealth: ContextHealthState.forTest(),
      artifact: ArtifactState.forTest(),
      sessionId: 'p2b-text-close-session',
      messages: [{ id: 'user-1', role: 'user' as const, content: SHEET_CARD_PROMPT, timestamp: 1 }],
      control: ControlState.forTest({ isCancelled: false } as never),
      modelConfig: { model: 'glm-5.3' },
      turn: TurnState.forTest({
        currentTurnId: 'turn-7',
        toolsUsedInTurn: [],
        isSimpleTaskMode: false,
        researchModeActive: false,
      } as never),
      goalTracker: new GoalTracker(),
      workingDirectory: workDir,
      onEvent: vi.fn(),
      telemetryAdapter: { onTurnEnd: vi.fn() },
      nudgeManager,
      turnQualityState: {},
    };
    const addAndPersistMessage = vi.fn();
    const injectSystemMessage = vi.fn();
    const processor = new MessageProcessor(
      ctx as DeepPartial<RuntimeContext> as RuntimeContext,
      {
        generateId: () => 'assistant-close-1',
        stripInternalFormatMimicry: (content: string) => content,
        addAndPersistMessage,
        injectSystemMessage,
        updateContextHealth: vi.fn(),
        checkAndAutoCompress: vi.fn(),
      } as unknown as ContextAssembly,
      {
        emitTaskProgress: vi.fn(),
        emitTaskComplete: vi.fn(),
        tryParseTodosFromResponse: vi.fn(),
      } as unknown as RunFinalizer,
      {} as ToolExecutionEngine,
    );

    const action = await processor.handleTextResponse(
      {
        type: 'text',
        content: '已完成，文件名为 2024年1-6月销售数据分析.xlsx，包含原始数据与汇总分析两个工作表，核心结论与建议见汇总表。',
        finishReason: 'stop',
      } as ModelResponse,
      false,
      7,
      false,
      { endSpan: vi.fn() },
    );

    // 收尾正文恰好落一条 assistant 消息，循环收口，不再有第二轮生成
    expect(action).toBe('break');
    expect(addAndPersistMessage).toHaveBeenCalledTimes(1);
    expect(addAndPersistMessage).toHaveBeenCalledWith(expect.objectContaining({
      id: 'assistant-close-1',
      role: 'assistant',
    }));
    // 不再注入 task-tracking hint（也不注入任何 nudge）
    expect(injectSystemMessage).not.toHaveBeenCalled();
  });
});
