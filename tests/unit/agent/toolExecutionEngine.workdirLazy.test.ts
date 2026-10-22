// ============================================================================
// 懒开目录的引擎侧落盘（N-DELIVERABLE-WORKDIR-LAZY）
//
// 无文件夹会话的工作目录首轮只规划不落盘。本文件钉：
// - 首个非只读工具（Write/Bash）派发前，缺失且在默认工作根之内的 cwd 被
//   materializeRunWorkDirectoryOnce 建出来（executor 看到的目录已存在）；
// - 只读工具（Read/Glob/ListDirectory）不触发——纯问答会话不产生任何目录；
// - 同一路径只建一次；默认根之外的缺失目录绝不自动创建；
// - createRunContext 对缺失 cwd 不抛（懒开前提：run 上下文先于目录存在）。
// 反向变异：引擎里 materializeRunWorkDirectoryOnce 调用摘掉 → Write 用例立红。
// ============================================================================
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ToolCall, ToolResult } from '../../../src/shared/contract';
import { ToolExecutionEngine } from '../../../src/host/agent/runtime/toolExecutionEngine';
import { AntiPatternDetector } from '../../../src/host/agent/antiPattern/detector';
import type { RuntimeContext } from '../../../src/host/agent/runtime/runtimeContext';
import { TurnState } from '../../../src/host/agent/runtime/turnState';
import { fileReadTracker } from '../../../src/host/tools/fileReadTracker';
import { ControlState } from '../../../src/host/agent/runtime/controlState';
import { ContextHealthState } from '../../../src/host/agent/runtime/contextHealthState';
import { RunStatsState } from '../../../src/host/agent/runtime/runStatsState';
import { ArtifactState } from '../../../src/host/agent/runtime/artifactState';
import { createRunContext, resolveCanonicalRunPath } from '../../../src/host/runtime/runContext';

const serviceMocks = vi.hoisted(() => ({
  langfuse: {
    startNestedSpan: vi.fn(),
    endSpan: vi.fn(),
  },
}));

vi.mock('../../../src/host/services', () => ({
  getConfigService: vi.fn(),
  getAuthService: vi.fn(),
  getBudgetService: vi.fn(),
  getSessionManager: vi.fn(),
  getLangfuseService: () => serviceMocks.langfuse,
  BudgetAlertLevel: {},
}));

vi.mock('../../../src/host/services/citation/citationService', () => ({
  getCitationService: () => ({
    extractAndStore: vi.fn().mockReturnValue([]),
  }),
}));

vi.mock('../../../src/host/services/git/fileWatcherService', () => ({
  getFileWatcherService: () => ({
    getRecentExternalChanges: vi.fn().mockReturnValue([]),
    markAsAgentModified: vi.fn(),
  }),
}));

vi.mock('../../../src/host/services/git/gitStatusService', () => ({
  getGitStatusService: () => ({
    onPostToolUse: vi.fn(),
  }),
}));

vi.mock('../../../src/host/mcp/mcpClient', () => ({
  getMCPClient: () => ({
    getToolAnnotationsMap: () => new Map(),
    getToolDefinitions: () => [],
  }),
}));

function makeRuntimeContext(overrides: Partial<RuntimeContext> = {}): RuntimeContext {
  const onEvent = vi.fn();
  const telemetryAdapter = {
    onTurnStart: vi.fn(),
    onModelCall: vi.fn(),
    onToolCallStart: vi.fn(),
    onToolCallEnd: vi.fn(),
    onTurnEnd: vi.fn(),
  };

  return {
    systemPrompt: '',
    modelConfig: { provider: 'openai', model: 'gpt-test' } as never,
    toolExecutor: { execute: vi.fn() } as never,
    messages: [],
    onEvent,
    modelRouter: {} as never,
    maxIterations: 10,
    workingDirectory: '/tmp/code-agent-test',
    isDefaultWorkingDirectory: false,
    sessionId: 'session-workdir-lazy',
    persistLongTermMemory: true,
    includeRecentConversations: true,
    circuitBreaker: {
      recordFailure: vi.fn().mockReturnValue(false),
      recordSuccess: vi.fn(),
      generateWarningMessage: vi.fn(),
      generateUserErrorMessage: vi.fn(),
    } as never,
    antiPatternDetector: new AntiPatternDetector(),
    goalTracker: { recordAction: vi.fn() } as never,
    nudgeManager: {
      trackModifiedFile: vi.fn(),
      checkProgressState: vi.fn(),
      checkPostForceExecute: vi.fn(),
    } as never,
    hookMessageBuffer: {} as never,
    messageHistoryCompressor: {} as never,
    autoCompressor: {} as never,
    compressionPipeline: {} as never,
    telemetryAdapter,
    turnTrace: {
      setTurn: vi.fn(),
      record: vi.fn(),
      flush: vi.fn(),
      getEvents: vi.fn().mockReturnValue([]),
    } as never,
    turn: TurnState.forTest({
      currentIterationSpanId: 'iteration-1',
      currentTurnId: 'turn-1',
      turnStartTime: Date.now(),
      effortLevel: 'medium' as never,
    }),
    autoApprovePlan: false,
    enableHooks: true,
    maxStopHookRetries: 0,
    maxToolCallRetries: 0,
    enableToolDeferredLoading: false,
    maxMode: false,
    maxModeCandidates: 1,
    maxStructuredOutputRetries: 0,
    stepByStepMode: false,
    turnQualityState: {},
    goalEvidenceState: { bounces: 0 },
    control: ControlState.forTest({} as never),
    budgetScope: 'foreground',
    consecutiveErrors: 0,
    stats: RunStatsState.forTest({
      traceId: 'trace-1',
      totalInputTokens: 0,
      totalOutputTokens: 0,
      runStartTime: Date.now(),
      totalTokensUsed: 0,
      totalToolCallCount: 0,
    } as never),
    MAX_CONSECUTIVE_TRUNCATIONS: 3,
    MAX_CONSECUTIVE_COMPACTS: 3,
    contextHealth: ContextHealthState.forTest({ persistentSystemContext: [] } as never),
    artifact: ArtifactState.forTest(),
    enableDeliveryCritic: false,
    ...overrides,
  };
}

function makeEngine(
  execute: (name: string, args: Record<string, unknown>) => Promise<ToolResult>,
  workingDirectory: string,
) {
  const ctx = makeRuntimeContext({
    toolExecutor: { execute } as never,
    workingDirectory,
  });
  const injectSystemMessage = vi.fn();
  const engine = new ToolExecutionEngine(ctx);
  engine.setModules(
    {
      injectSystemMessage,
      pushPersistentSystemContext: vi.fn(),
      getCurrentAttachments: vi.fn().mockReturnValue([]),
    } as never,
    { emitTaskProgress: vi.fn() } as never,
    { setPlanMode: vi.fn(), isPlanMode: vi.fn().mockReturnValue(false), generateAutoContinuationPrompt: vi.fn() } as never,
  );
  return { ctx, engine };
}

describe('ToolExecutionEngine lazy work directory (N-DELIVERABLE-WORKDIR-LAZY)', () => {
  let tempDataDir: string;
  let defaultRoot: string;
  let priorDataDir: string | undefined;

  beforeEach(() => {
    vi.clearAllMocks();
    fileReadTracker.clear();
    // 嵌套数据目录 → 默认工作根 = <dataDir>-work，与真实运行隔离
    tempDataDir = mkdtempSync(path.join(tmpdir(), 'workdir-lazy-data-'));
    priorDataDir = process.env.CODE_AGENT_DATA_DIR;
    process.env.CODE_AGENT_DATA_DIR = tempDataDir;
    defaultRoot = `${tempDataDir}-work`;
  });

  afterEach(() => {
    fileReadTracker.clear();
    if (priorDataDir === undefined) delete process.env.CODE_AGENT_DATA_DIR;
    else process.env.CODE_AGENT_DATA_DIR = priorDataDir;
    rmSync(tempDataDir, { recursive: true, force: true });
    rmSync(defaultRoot, { recursive: true, force: true });
  });

  it('materializes the missing planned work dir before the first non-read-only tool dispatch', async () => {
    const plannedDir = path.join(defaultRoot, '任务_1011_写一份笔记');
    const seenByExecutor: boolean[] = [];
    const execute = vi.fn(async (name: string): Promise<ToolResult> => {
      seenByExecutor.push(existsSync(plannedDir));
      return { toolCallId: '', success: true, output: `${name} ok` };
    });
    const { engine } = makeEngine(execute, plannedDir);

    const [write] = await engine.executeToolsWithHooks([
      { id: 'write-1', name: 'Write', arguments: { file_path: 'notes.md', content: 'x' } } as ToolCall,
    ]);
    expect(write.success).toBe(true);
    expect(existsSync(plannedDir)).toBe(true);
    // 派发那一刻目录已经就位（不是事后补建）
    expect(seenByExecutor).toEqual([true]);
  });

  it('does not materialize for read-only tools — a pure Q&A turn leaves no folder', async () => {
    const plannedDir = path.join(defaultRoot, '任务_1011_纯问答');
    const execute = vi.fn(async (name: string): Promise<ToolResult> => ({
      toolCallId: '', success: true, output: `${name} ok`,
    }));
    const { engine } = makeEngine(execute, plannedDir);

    const results = await engine.executeToolsWithHooks([
      { id: 'read-1', name: 'Read', arguments: { file_path: 'notes.md' } } as ToolCall,
      { id: 'glob-1', name: 'Glob', arguments: { pattern: '*.md' } } as ToolCall,
      { id: 'list-1', name: 'ListDirectory', arguments: {} } as ToolCall,
    ]);
    expect(results.every((result) => result.success)).toBe(true);
    expect(existsSync(plannedDir)).toBe(false);
    expect(existsSync(defaultRoot)).toBe(false);
  });

  it('materializes once per path: a second write reuses the same directory', async () => {
    const plannedDir = path.join(defaultRoot, '任务_1011_两次写入');
    const execute = vi.fn(async (name: string): Promise<ToolResult> => ({
      toolCallId: '', success: true, output: `${name} ok`,
    }));
    const { engine } = makeEngine(execute, plannedDir);

    await engine.executeToolsWithHooks([
      { id: 'write-1', name: 'Write', arguments: { file_path: 'a.md', content: 'x' } } as ToolCall,
    ]);
    mkdirSync(path.join(plannedDir, 'nested'), { recursive: true });
    writeFileSync(path.join(plannedDir, 'nested', 'keep.txt'), 'keep');
    await engine.executeToolsWithHooks([
      { id: 'bash-1', name: 'Bash', arguments: { command: 'ls' } } as ToolCall,
    ]);
    // 幂等：第二次不重建、不动既有内容
    expect(existsSync(path.join(plannedDir, 'nested', 'keep.txt'))).toBe(true);
  });

  it('never auto-creates a missing work dir outside the default work root', async () => {
    const outsideDir = path.join(tmpdir(), 'workdir-lazy-outside-project');
    const execute = vi.fn(async (name: string): Promise<ToolResult> => ({
      toolCallId: '', success: true, output: `${name} ok`,
    }));
    const { engine } = makeEngine(execute, outsideDir);

    await engine.executeToolsWithHooks([
      { id: 'write-1', name: 'Write', arguments: { file_path: 'a.md', content: 'x' } } as ToolCall,
    ]);
    expect(existsSync(outsideDir)).toBe(false);
    rmSync(outsideDir, { recursive: true, force: true });
  });
});

describe('run context tolerates a missing (planned, not yet materialized) cwd', () => {
  it('resolveCanonicalRunPath does not throw on a path that does not exist yet', () => {
    // 从已真实化的 tmpdir 锚起：既有祖先走真实路径（macOS /var → /private/var），
    // 缺失后缀原样保留
    const missing = path.join(realpathSync(tmpdir()), 'workdir-lazy-missing-root', '任务_1011_未落盘');
    expect(() => resolveCanonicalRunPath(missing)).not.toThrow();
    expect(resolveCanonicalRunPath(missing)).toBe(missing);
  });

  it('createRunContext accepts a missing workspace/cwd without throwing', () => {
    const missing = path.join(tmpdir(), 'workdir-lazy-missing-root-2', '任务_1011_未落盘');
    expect(() => createRunContext({
      runId: 'run-workdir-lazy',
      sessionId: 'session-workdir-lazy-ctx',
      workspace: missing,
      cwd: missing,
    })).not.toThrow();
  });
});
