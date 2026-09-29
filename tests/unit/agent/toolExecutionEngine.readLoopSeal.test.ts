// ============================================================================
// 只读硬阈值后只封读、放行写（N-READLOOP-FORCEFINAL-WRITE / FB-253）
//
// 夜巡 2026-09-27：连续只读 15 次后全量 forceFinal 把 Write 也封死，GDPval
// 调研题交不出 docx。本文件钉：15 次只读后 Write / 写文件型 Bash / 产物工具
// 仍执行；第 16 次 Read 被拦。反向变异（HARD_LIMIT 仍 activateForceFinal）立红。
// ============================================================================
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
    sessionId: 'session-read-loop-seal',
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
  options: { priorReads?: number } = {},
) {
  const detector = new AntiPatternDetector();
  const priorReads = options.priorReads ?? 14;
  for (let index = 0; index < priorReads; index += 1) {
    detector.trackToolExecution('Read', true);
  }
  const ctx = makeRuntimeContext({
    toolExecutor: { execute } as never,
    antiPatternDetector: detector,
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
  return { ctx, engine, injectSystemMessage };
}

describe('ToolExecutionEngine read-loop seal (FB-253)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    fileReadTracker.clear();
  });

  afterEach(() => {
    fileReadTracker.clear();
  });

  it('after 15 reads, Write still executes and a follow-up Read without a write stays blocked', async () => {
    const execute = vi.fn(async (name: string, args: Record<string, unknown>): Promise<ToolResult> => ({
      toolCallId: '',
      success: true,
      output: `${name} ok ${String(args.file_path ?? args.command ?? '')}`,
    }));
    const { ctx, engine, injectSystemMessage } = makeEngine(execute);

    const [read15] = await engine.executeToolsWithHooks([
      { id: 'read-15', name: 'Read', arguments: { file_path: '/tmp/evidence.txt' } } as ToolCall,
    ]);
    expect(read15).toMatchObject({
      success: false,
      metadata: expect.objectContaining({ readLoopSeal: true, hardLimitPreflight: true }),
    });
    expect(read15.error).toContain('立刻交付');
    expect(ctx.control.readLoopSealActive).toBe(true);
    expect(ctx.control.forceFinalResponseReason).toBeUndefined();
    expect(injectSystemMessage).toHaveBeenCalledWith(
      expect.stringContaining('Stop researching'),
      'file-consistency-guard',
    );
    expect(String(injectSystemMessage.mock.calls[0]?.[0])).not.toContain('Do not call any tool');

    const [read16] = await engine.executeToolsWithHooks([
      { id: 'read-16', name: 'Read', arguments: { file_path: '/tmp/evidence.txt' } } as ToolCall,
    ]);
    expect(read16).toMatchObject({
      success: false,
      metadata: expect.objectContaining({ readLoopSeal: true }),
    });
    expect(execute.mock.calls.some((call) => call[0] === 'Read' && call[1]?.file_path === '/tmp/evidence.txt')).toBe(false);
    expect(ctx.control.forceFinalResponseReason).toBeUndefined();
  });

  it('after a successful Write while sealed, the next Read is allowed', async () => {
    const execute = vi.fn(async (name: string, args: Record<string, unknown>): Promise<ToolResult> => ({
      toolCallId: '',
      success: true,
      output: `${name} ok ${String(args.file_path ?? args.command ?? '')}`,
    }));
    const { ctx, engine } = makeEngine(execute);

    await engine.executeToolsWithHooks([
      { id: 'read-15', name: 'Read', arguments: { file_path: '/tmp/evidence.txt' } } as ToolCall,
    ]);
    expect(ctx.control.readLoopSealActive).toBe(true);

    const [write] = await engine.executeToolsWithHooks([
      { id: 'write-docx', name: 'Write', arguments: { file_path: '/tmp/deliverable.docx', content: 'memo' } } as ToolCall,
    ]);
    expect(write.success).toBe(true);
    expect(ctx.control.readLoopSealActive).toBe(false);
    expect(execute).toHaveBeenCalledWith(
      'Write',
      expect.objectContaining({ file_path: '/tmp/deliverable.docx' }),
      expect.anything(),
    );

    const [readAfterWrite] = await engine.executeToolsWithHooks([
      { id: 'read-self-check', name: 'Read', arguments: { file_path: '/tmp/deliverable.docx' } } as ToolCall,
    ]);
    expect(readAfterWrite.success).toBe(true);
    expect(execute).toHaveBeenCalledWith(
      'Read',
      expect.objectContaining({ file_path: '/tmp/deliverable.docx' }),
      expect.anything(),
    );
  });

  it('after the seal is cleared at run end, the next Read is not blocked', async () => {
    const execute = vi.fn(async (name: string): Promise<ToolResult> => ({
      toolCallId: '',
      success: true,
      output: `${name} ok`,
    }));
    const { ctx, engine } = makeEngine(execute, { priorReads: 0 });
    ctx.control.activateReadLoopSeal();
    ctx.control.recordBlockedReadDuringReadLoopSeal();

    const [blocked] = await engine.executeToolsWithHooks([
      { id: 'read-sealed', name: 'Read', arguments: { file_path: '/tmp/a.ts' } } as ToolCall,
    ]);
    expect(blocked.success).toBe(false);
    expect(blocked.metadata).toEqual(expect.objectContaining({ readLoopSeal: true }));
    expect(execute).not.toHaveBeenCalled();

    ctx.control.clearReadLoopSeal();

    const [allowed] = await engine.executeToolsWithHooks([
      { id: 'read-after-run', name: 'Read', arguments: { file_path: '/tmp/a.ts' } } as ToolCall,
    ]);
    expect(allowed.success).toBe(true);
    expect(execute).toHaveBeenCalledWith(
      'Read',
      expect.objectContaining({ file_path: '/tmp/a.ts' }),
      expect.anything(),
    );
  });

  it('same-batch Read at the hard limit still lets Write/Edit run', async () => {
    const execute = vi.fn(async (name: string): Promise<ToolResult> => ({
      toolCallId: '',
      success: true,
      output: `${name} ok`,
    }));
    const { ctx, engine } = makeEngine(execute);

    const results = await engine.executeToolsWithHooks([
      { id: 'read-15', name: 'Read', arguments: { file_path: '/tmp/a.ts' } } as ToolCall,
      { id: 'write-1', name: 'Write', arguments: { file_path: '/tmp/out.docx', content: 'x' } } as ToolCall,
      { id: 'edit-1', name: 'Edit', arguments: { file_path: '/tmp/out.docx', edits: [{ old_text: 'x', new_text: 'y' }] } } as ToolCall,
    ]);

    expect(results[0]?.success).toBe(false);
    expect(results[1]?.success).toBe(true);
    expect(results[2]?.success).toBe(true);
    expect(execute).toHaveBeenCalledWith('Write', expect.anything(), expect.anything());
    expect(execute).toHaveBeenCalledWith('Edit', expect.anything(), expect.anything());
    expect(ctx.control.forceFinalResponseReason).toBeUndefined();
  });

  it('blocks read-only Bash and still runs write-file Bash and ppt/docx generators', async () => {
    const execute = vi.fn(async (name: string): Promise<ToolResult> => ({
      toolCallId: '',
      success: true,
      output: `${name} ok`,
    }));
    const { engine } = makeEngine(execute);

    await engine.executeToolsWithHooks([
      { id: 'read-15', name: 'Read', arguments: { file_path: '/tmp/a.ts' } } as ToolCall,
    ]);

    const results = await engine.executeToolsWithHooks([
      { id: 'bash-cat', name: 'Bash', arguments: { command: 'cat evidence.txt' } } as ToolCall,
      { id: 'bash-write', name: 'Bash', arguments: { command: 'python3 -c "Path(\'out.docx\').write_text(\'x\')"' } } as ToolCall,
      { id: 'ppt', name: 'ppt_generate', arguments: { file_path: '/tmp/out.pptx' } } as ToolCall,
      { id: 'docx', name: 'docx_generate', arguments: { file_path: '/tmp/out.docx' } } as ToolCall,
    ]);

    expect(results[0]).toMatchObject({ success: false, metadata: expect.objectContaining({ readLoopSeal: true }) });
    expect(results[1]?.success).toBe(true);
    // ppt/docx 可能因 schema 校验失败，但不得被只封读拦住（没有 readLoopSeal 元数据）。
    expect(results[2]?.metadata?.readLoopSeal).toBeUndefined();
    expect(results[3]?.metadata?.readLoopSeal).toBeUndefined();
    expect(execute).toHaveBeenCalledWith('Bash', expect.objectContaining({ command: expect.stringContaining('write_text') }), expect.anything());
    expect(execute).not.toHaveBeenCalledWith('Bash', expect.objectContaining({ command: 'cat evidence.txt' }), expect.anything());
  });

  it('escalates to full forceFinal after 3 extra blocked reads', async () => {
    const execute = vi.fn(async (): Promise<ToolResult> => ({
      toolCallId: '',
      success: true,
      output: 'ok',
    }));
    const { ctx, engine } = makeEngine(execute);

    await engine.executeToolsWithHooks([
      { id: 'read-15', name: 'Read', arguments: { file_path: '/tmp/a.ts' } } as ToolCall,
    ]);
    expect(ctx.control.forceFinalResponseReason).toBeUndefined();

    for (let index = 0; index < 2; index += 1) {
      await engine.executeToolsWithHooks([
        { id: `read-extra-${index}`, name: 'Read', arguments: { file_path: `/tmp/extra-${index}.ts` } } as ToolCall,
      ]);
      expect(ctx.control.forceFinalResponseReason).toBeUndefined();
    }

    await engine.executeToolsWithHooks([
      { id: 'read-escalate', name: 'Read', arguments: { file_path: '/tmp/escalate.ts' } } as ToolCall,
    ]);
    expect(ctx.control.forceFinalResponseReason).toContain('连续只读操作达到硬阈值');
    expect(ctx.control.forceFinalResponsePrompt).toContain('Do not call any tool');
  });
});
