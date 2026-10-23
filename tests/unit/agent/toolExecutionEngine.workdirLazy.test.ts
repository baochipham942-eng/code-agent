// ============================================================================
// 懒开目录的引擎侧落盘（N-DELIVERABLE-WORKDIR-LAZY / FU1）
//
// 无文件夹会话的工作目录首轮只规划不落盘。本文件钉：
// - 首个会写工作目录的工具（Write/Bash）派发前，缺失且在默认工作根之内的 cwd 被
//   materializeRunWorkDirectoryOnce 建出来（executor 看到的目录已存在）；
// - 只读工具（Read/Glob/ListDirectory）不触发——纯问答会话不产生任何目录；
// - 非只读但显式声明不碰工作目录的工具（AskUserQuestion/confirm_action/
//   MemoryWrite/memory_amend，FU1）也不触发——纯问答+记忆轮不产生任何目录；
// - 连接器/网络写工具（calendar/mail/reminders/tmeetMeetingCreate/jira/
//   http_request，FU1-FU1）handler 不碰 cwd，同批不触发——只存记忆或只调
//   连接器/网页的会话不产生空任务夹；github_pr 的 handler 拿会话目录当 git/gh
//   的 cwd，保持落盘；Bash 永远落盘（spawn cwd 缺失 = ENOENT）；
// - 同一路径只建一次；默认根之外的缺失目录绝不自动创建；
// - createRunContext 对缺失 cwd 不抛（懒开前提：run 上下文先于目录存在）。
// 反向变异：引擎里 materializeRunWorkDirectoryOnce 调用摘掉 → Write 用例立红；
// 判据退回 readOnly !== true（FU1 前）→ 问答+记忆用例立红；
// mail_send 摘掉 touchesWorkDirectory（FU1-FU1 前）→ 连接器单批用例立红。
// ============================================================================
import { existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
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
import { getToolDefinitionWithCloudMeta } from '../../../src/host/tools/dispatch/toolDefinitions';
import {
  shouldMaterializeWorkDirectoryForTool,
} from '../../../src/host/agent/runtime/workDirectoryMaterializer';
import { getProtocolRegistry } from '../../../src/host/tools/protocolRegistry';
import {
  hasProtocolTool,
  registerProtocolTool,
  unregisterProtocolTool,
} from '../../../src/host/tools/protocolToolRegistration';
import { calendarCreateEventSchema } from '../../../src/host/tools/modules/connectors/calendarCreateEvent.schema';
import { calendarUpdateEventSchema } from '../../../src/host/tools/modules/connectors/calendarUpdateEvent.schema';
import { calendarDeleteEventSchema } from '../../../src/host/tools/modules/connectors/calendarDeleteEvent.schema';
import { mailDraftSchema } from '../../../src/host/tools/modules/connectors/mailDraft.schema';
import { mailSendSchema } from '../../../src/host/tools/modules/connectors/mailSend.schema';
import { remindersCreateSchema } from '../../../src/host/tools/modules/connectors/remindersCreate.schema';
import { remindersUpdateSchema } from '../../../src/host/tools/modules/connectors/remindersUpdate.schema';
import { remindersDeleteSchema } from '../../../src/host/tools/modules/connectors/remindersDelete.schema';

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

  it('does not materialize for declared cwd-free tools — a pure Q&A + memory turn leaves no folder (FU1)', async () => {
    const plannedDir = path.join(defaultRoot, '任务_1016_问答与记忆');
    const execute = vi.fn(async (name: string): Promise<ToolResult> => ({
      toolCallId: '', success: true, output: `${name} ok`,
    }));
    const { engine } = makeEngine(execute, plannedDir);

    const results = await engine.executeToolsWithHooks([
      {
        id: 'ask-1',
        name: 'AskUserQuestion',
        arguments: { questions: [{ question: '格式？', header: '格式', options: [{ label: 'Markdown' }, { label: 'Word' }] }] },
      } as ToolCall,
    ]);
    // AskUserQuestion / confirm_action 都是 barrier 工具：同批后续调用会被延后
    // （BATCH_TERMINATED），真实形状是问句/确认各自单独一批、用户应答后再来记忆批
    // ——mock executor 不带 awaitingUserInput 元数据，后续批照常派发。
    const confirmed = await engine.executeToolsWithHooks([
      { id: 'confirm-1', name: 'confirm_action', arguments: { title: '确认', message: '继续？' } } as ToolCall,
    ]);
    const memory = await engine.executeToolsWithHooks([
      { id: 'mem-1', name: 'MemoryWrite', arguments: { action: 'write', filename: 'note.md', content: 'x' } } as ToolCall,
      { id: 'amend-1', name: 'memory_amend', arguments: { id: 'mem_1', action: 'forget' } } as ToolCall,
    ]);
    expect([...results, ...confirmed, ...memory].every((result) => result.success)).toBe(true);
    expect(existsSync(plannedDir)).toBe(false);
    expect(existsSync(defaultRoot)).toBe(false);
  });

  it('a later Write still materializes exactly one entry in the default root (FU1)', async () => {
    const plannedDir = path.join(defaultRoot, '任务_1016_问答后落盘');
    const execute = vi.fn(async (name: string): Promise<ToolResult> => ({
      toolCallId: '', success: true, output: `${name} ok`,
    }));
    const { engine } = makeEngine(execute, plannedDir);

    await engine.executeToolsWithHooks([
      { id: 'ask-1', name: 'AskUserQuestion', arguments: { questions: [{ question: '格式？', header: '格式', options: [{ label: 'Markdown' }, { label: 'Word' }] }] } } as ToolCall,
    ]);
    await engine.executeToolsWithHooks([
      { id: 'write-1', name: 'Write', arguments: { file_path: 'report.md', content: 'x' } } as ToolCall,
    ]);
    // 问答轮不落盘，Write 轮落盘：默认根里恰好一个条目，就是规划的那个任务夹
    expect(readdirSync(defaultRoot)).toEqual([path.basename(plannedDir)]);
  });

  it('Bash alone still materializes — undeclared tools keep the fail-safe default (FU1)', async () => {
    const plannedDir = path.join(defaultRoot, '任务_1016_仅Bash');
    const execute = vi.fn(async (name: string): Promise<ToolResult> => ({
      toolCallId: '', success: true, output: `${name} ok`,
    }));
    const { engine } = makeEngine(execute, plannedDir);

    await engine.executeToolsWithHooks([
      { id: 'bash-1', name: 'Bash', arguments: { command: 'pwd' } } as ToolCall,
    ]);
    expect(existsSync(plannedDir)).toBe(true);
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

// ============================================================================
// 连接器/网络写工具的豁免（N-DELIVERABLE-WORKDIR-LAZY-FU1-FU1）
//
// 判定输入必须走真实链路：schema 单一真源 → getProtocolToolSchemas →
// schemaToDefinition（toolDefinitions.ts）→ 引擎内 getToolDefinitionWithCloudMeta，
// 不手搓 plain object。github_pr 的 handler 拿会话目录当 git/gh 子进程 cwd
// （network/githubPr.ts execGh），必须保持落盘——它是「非只读但绝不豁免」的对照位。
//
// 连接器组（calendar/mail/reminders，8 个）在 modules/index.ts 是 darwin-only 注册
// （AppleScript 依赖，windows-support.md §1.5），Linux CI 注册表里没有它们。本
// describe 钉的是 schema→definition 转换与引擎判定，与平台无关：非 darwin 上把
// 真实 schema 补注册进真实注册表（executor 是 mock，loader 不应被调起），跑完注销
// ——沿用 toolAccessCoverageInvariant.test.ts 的补注册模式。
// ============================================================================
describe('connector/network tools declared cwd-free (N-DELIVERABLE-WORKDIR-LAZY-FU1-FU1)', () => {
  const markedTools: Array<[name: string, args: Record<string, unknown>]> = [
    ['calendar_create_event', { calendar: 'Work', title: 'Sync', start_ms: 1760000000000 }],
    ['calendar_update_event', { calendar: 'Work', event_uid: 'evt-1', title: 'Sync v2' }],
    ['calendar_delete_event', { calendar: 'Work', event_uid: 'evt-1' }],
    ['mail_draft', { subject: 'Draft', to: ['someone@example.com'] }],
    ['mail_send', { subject: 'Hello', to: ['someone@example.com'] }],
    ['reminders_create', { list: 'Reminders', title: 'Buy milk' }],
    ['reminders_update', { list: 'Reminders', reminder_id: 'rem-1', completed: true }],
    ['reminders_delete', { list: 'Reminders', reminder_id: 'rem-1' }],
    ['tmeetMeetingCreate', { subject: 'Standup', start: '2026-10-22T09:00:00+08:00', end: '2026-10-22T09:30:00+08:00' }],
    ['jira', { action: 'query', jql: 'assignee = currentUser()' }],
    ['http_request', { url: 'https://example.com' }],
  ];
  const cwdBoundTools = ['github_pr', 'Bash'] as const;

  const darwinOnlySchemas = [
    calendarCreateEventSchema,
    calendarUpdateEventSchema,
    calendarDeleteEventSchema,
    mailDraftSchema,
    mailSendSchema,
    remindersCreateSchema,
    remindersUpdateSchema,
    remindersDeleteSchema,
  ] as const;
  let registeredForTest: string[] = [];

  beforeAll(() => {
    // 端口懒初始化（resolveToolCallAccess 首次调用才建单例）：先强制初始化，
    // 再补注册非 darwin 平台缺席的连接器 schema
    getProtocolRegistry();
    registeredForTest = darwinOnlySchemas
      .filter((schema) => !hasProtocolTool(schema.name))
      .map((schema) => {
        registerProtocolTool(schema, async () => {
          throw new Error(`loader for ${schema.name} must not run in workdirLazy tests`);
        });
        return schema.name;
      });
  });

  afterAll(() => {
    for (const name of registeredForTest) unregisterProtocolTool(name);
    registeredForTest = [];
  });

  let tempDataDir: string;
  let defaultRoot: string;
  let priorDataDir: string | undefined;

  beforeEach(() => {
    vi.clearAllMocks();
    fileReadTracker.clear();
    tempDataDir = mkdtempSync(path.join(tmpdir(), 'workdir-lazy-fu1fu1-data-'));
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

  it('the 11 marked tools skip materialization through the real schema→definition conversion; github_pr and Bash do not', () => {
    for (const [name] of markedTools) {
      const definition = getToolDefinitionWithCloudMeta(name);
      expect(definition, `${name} is registered`).toBeDefined();
      expect(shouldMaterializeWorkDirectoryForTool(definition), `${name} declared cwd-free`).toBe(false);
    }
    for (const name of cwdBoundTools) {
      const definition = getToolDefinitionWithCloudMeta(name);
      expect(definition, `${name} is registered`).toBeDefined();
      // handler 真拿会话目录当 cwd（github_pr 的 git/gh；Bash 的 spawn cwd）——保持落盘
      expect(shouldMaterializeWorkDirectoryForTool(definition), `${name} still materializes`).toBe(true);
    }
  });

  it('a turn calling only the marked connector/network tools leaves no planned dir and no default root', async () => {
    const plannedDir = path.join(defaultRoot, '任务_1022_只调连接器');
    const execute = vi.fn(async (name: string): Promise<ToolResult> => ({
      toolCallId: '', success: true, output: `${name} ok`,
    }));
    const { engine } = makeEngine(execute, plannedDir);

    const results = await engine.executeToolsWithHooks(
      markedTools.map(([name, args], index) => ({ id: `call-${index}`, name, arguments: args }) as ToolCall),
    );
    expect(results.every((result) => result.success)).toBe(true);
    expect(existsSync(plannedDir)).toBe(false);
    expect(existsSync(defaultRoot)).toBe(false);
  });

  it('connector-only turn followed by a Write materializes exactly one entry in the default root', async () => {
    const plannedDir = path.join(defaultRoot, '任务_1022_连接器后写文件');
    const execute = vi.fn(async (name: string): Promise<ToolResult> => ({
      toolCallId: '', success: true, output: `${name} ok`,
    }));
    const { engine } = makeEngine(execute, plannedDir);

    await engine.executeToolsWithHooks([
      { id: 'mail-1', name: 'mail_send', arguments: { subject: 'Hello', to: ['someone@example.com'] } } as ToolCall,
      { id: 'http-1', name: 'http_request', arguments: { url: 'https://example.com' } } as ToolCall,
    ]);
    expect(existsSync(defaultRoot)).toBe(false);
    await engine.executeToolsWithHooks([
      { id: 'write-1', name: 'Write', arguments: { file_path: 'notes.md', content: 'x' } } as ToolCall,
    ]);
    // 连接器轮不落盘，Write 轮落盘：默认根里恰好一个条目，就是规划的那个任务夹
    expect(readdirSync(defaultRoot)).toEqual([path.basename(plannedDir)]);
  });

  it('github_pr alone still materializes — its handler runs git/gh with the session dir as cwd', async () => {
    const plannedDir = path.join(defaultRoot, '任务_1022_仅github_pr');
    const execute = vi.fn(async (name: string): Promise<ToolResult> => ({
      toolCallId: '', success: true, output: `${name} ok`,
    }));
    const { engine } = makeEngine(execute, plannedDir);

    await engine.executeToolsWithHooks([
      { id: 'gh-1', name: 'github_pr', arguments: { action: 'list' } } as ToolCall,
    ]);
    expect(existsSync(plannedDir)).toBe(true);
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
