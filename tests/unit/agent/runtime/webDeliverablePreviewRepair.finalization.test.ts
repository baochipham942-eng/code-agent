import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { randomUUID } from 'crypto';
import Database from 'better-sqlite3';
import type { AgentEvent, Message } from '../../../../src/shared/contract';
import type { RuntimeContext } from '../../../../src/host/agent/runtime/runtimeContext';
import type { ContextAssembly } from '../../../../src/host/agent/runtime/contextAssembly';
import type { ArtifactPreviewHealthSummary } from '../../../../src/host/agent/runtime/browser/artifactPreviewHealth';

vi.unmock('better-sqlite3');
vi.mock('../../../../src/host/agent/runtime/browser/artifactPreviewHealth', () => ({ runArtifactPreviewHealth: vi.fn() }));
vi.mock('../../../../src/host/services/core/databaseService', () => ({
  getDatabase: () => ({ isReady: false }),
}));
vi.mock('../../../../src/host/services/infra/logger', () => ({
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));
vi.mock('../../../../src/host/mcp/logCollector.js', () => ({
  logCollector: { agent: vi.fn() },
}));
vi.mock('../../../../src/host/services', () => ({
  getLangfuseService: vi.fn(),
  getBudgetService: vi.fn(),
  BudgetAlertLevel: { None: 'none' },
}));
vi.mock('../../../../src/host/lightMemory/sessionMetadata', () => ({
  recordSessionEnd: vi.fn(async () => undefined),
}));
vi.mock('../../../../src/host/lightMemory/recentConversations', () => ({
  appendConversationSummary: vi.fn(),
  isLoopAutomationSummaryText: () => false,
}));
vi.mock('../../../../src/host/lightMemory/conversationJudge', () => ({
  judgeConversation: vi.fn(async () => ({
    worth: false,
    isMeeting: false,
    title: '',
    worthKnowledge: [],
    durableFacts: [],
    source: 'heuristic',
  })),
}));
vi.mock('../../../../src/host/lightMemory/durableFactWriter', () => ({ writeDurableFacts: vi.fn() }));
vi.mock('../../../../src/host/observability/posthogNode', () => ({ trackNode: vi.fn() }));
vi.mock('../../../../src/host/session/completionSummaryService', () => ({
  buildCompletionSummaryRecord: vi.fn(async () => ({ id: 'summary-1', status: 'failed' })),
  persistCompletionSummaryRecord: vi.fn(),
}));
vi.mock('../../../../src/host/agent/runtime/turnOutcomeStamp', () => ({
  recordTurnOutcomeStamp: vi.fn(),
}));
vi.mock('../../../../src/host/services/surfaceExecution/SurfaceExecutionRuntime', () => ({
  getConfiguredSurfaceExecutionRuntime: () => null,
}));
vi.mock('../../../../src/host/services/planning/taskStore', () => ({
  getIncompleteTasks: () => [],
}));
vi.mock('../../../../src/host/mcp/cuaSessionLock', () => ({ releaseCuaLock: vi.fn() }));
vi.mock('../../../../src/host/mcp/cuaTrajectoryBudget', () => ({ resetCuaBudget: vi.fn() }));


vi.mock('../../../../src/host/services/core/promptSuggestions', () => ({ generateContextSuggestions: async () => [] }));
vi.mock('../../../../src/host/services/roleAssets/roleProactivity', () => ({ triggerEventWakes: vi.fn() }));

import { RunFinalizer } from '../../../../src/host/agent/runtime/runFinalizer';
import { ArtifactState } from '../../../../src/host/agent/runtime/artifactState';
import { maybeRunWebDeliverablePreviewRepair } from '../../../../src/host/agent/runtime/webDeliverablePreviewRepair';
import { addAndPersistMessage } from '../../../../src/host/agent/runtime/contextAssembly/systemContextStack';
import { SessionRepository } from '../../../../src/host/services/core/repositories/SessionRepository';
import { applySchema } from '../../../../src/host/services/core/database/schema';
import { projectTurns } from '../../../../src/renderer/hooks/useTurnProjection';
import { app } from '../../../../src/host/platform';
import { createLogger } from '../../../../src/host/services/infra/logger';

const sessionId = 'preview-repair-session';
const broken: ArtifactPreviewHealthSummary = {
  attempted: true, passed: false, checks: [], failures: [],
  findings: [
    { code: 'broken_image', message: 'image missing', viewport: 'desktop' },
    { code: 'broken_image', message: 'image missing', viewport: 'mobile' },
    { code: 'horizontal_overflow', message: 'overflow', viewport: 'mobile' },
  ],
};
const fixed: ArtifactPreviewHealthSummary = { attempted: true, passed: true, findings: [], checks: [], failures: [] };

function harness(persistMessage = vi.fn(async (_message: Message) => {})) {
  const events: AgentEvent[] = [];
  const ctx = {
    sessionId, workingDirectory: '/tmp', artifact: ArtifactState.forTest(),
    persistLongTermMemory: false,
    onEvent: (event: AgentEvent) => events.push(event), persistMessage,
    messages: [
      { id: 'user', role: 'user', content: 'Make a page', timestamp: 1 },
      { id: 'assistant', role: 'assistant', content: 'Here is the page', timestamp: 2 },
    ],
    modelConfig: { provider: 'test', model: 'test-model' }, maxIterations: 10,
    stats: { traceId: 'trace', totalInputTokens: 0, totalOutputTokens: 0 },
    control: { isCancelled: false, isInterrupted: false },
    circuitBreaker: { isTripped: () => false },
    nudgeManager: { getModifiedFiles: () => new Set() },
    turn: { currentTurnId: 'assistant' },
  } as unknown as RuntimeContext;
  const contextAssembly = {
    generateId: randomUUID, injectSystemMessage: vi.fn(),
    addAndPersistMessage: (message: Message) => addAndPersistMessage({
      runtime: ctx, recordContextEventsForMessage: vi.fn(),
    } as never, message),
  } as unknown as ContextAssembly;
  const runFinalizer = new RunFinalizer(ctx);
  runFinalizer.setModules(contextAssembly, {} as never);
  const healthRunner = vi.fn().mockResolvedValueOnce(broken);
  const check = (absolutePath = '/tmp/page.html') => maybeRunWebDeliverablePreviewRepair({
    ctx, contextAssembly, runFinalizer, healthRunner, absolutePath,
    toolCall: { id: 'write', name: 'Write', arguments: { file_path: absolutePath } },
    toolResult: { toolCallId: 'write', success: true },
  });
  const finish = () => runFinalizer.finalizeRun(1, 'Make a page', {
    endTrace: vi.fn(), flush: async () => {},
  } as never, 8);
  return { ctx, events, healthRunner, check, finish, persistMessage, contextAssembly };
}

beforeEach(() => { Object.defineProperty(app, 'getLocale', { value: () => 'zh-CN', configurable: true }); });
afterEach(() => { Reflect.deleteProperty(app, 'getLocale'); vi.restoreAllMocks(); });

describe('web preview repair finalization and persistence', () => {
  it('forces exactly one recheck at turn end when the file was not rewritten', async () => {
    const h = harness();
    h.healthRunner.mockResolvedValueOnce(broken);
    await h.check();
    expect(h.contextAssembly.injectSystemMessage).toHaveBeenCalledTimes(1);
    await h.finish();
    expect(h.healthRunner).toHaveBeenCalledTimes(2);
    expect(h.persistMessage).toHaveBeenCalledTimes(1);
    expect(h.persistMessage).toHaveBeenCalledWith(expect.objectContaining({
      role: 'system', content: 'page.html: 网页仍有 2 个问题：图片无法显示、内容超出页面宽度',
      metadata: expect.objectContaining({ agentRecoveryNotice: { kind: 'web_preview_repair' } }),
    }));
    const noticeIndex = h.events.findIndex((event) => event.type === 'message');
    const completeIndex = h.events.findIndex((event) => event.type === 'agent_complete');
    expect(noticeIndex).toBeGreaterThanOrEqual(0);
    expect(completeIndex).toBeGreaterThan(noticeIndex);
    await h.finish();
    await h.check();
    expect(h.healthRunner).toHaveBeenCalledTimes(2);
    expect(h.persistMessage).toHaveBeenCalledTimes(1);
  });

  it('does not recheck again at turn end after a repair write was checked', async () => {
    const h = harness();
    h.healthRunner.mockResolvedValueOnce(fixed);
    await h.check();
    await h.check();
    await h.finish();
    expect(h.healthRunner).toHaveBeenCalledTimes(2);
    expect(h.persistMessage).toHaveBeenCalledTimes(1);
    expect(h.persistMessage).toHaveBeenCalledWith(expect.objectContaining({ content: 'page.html: 网页显示问题已修好' }));
  });

  it.each(['skipped', 'checkerFailed', 'crashed'] as const)('persists an unavailable notice for a %s final recheck without retrying', async (failure) => {
    const h = harness();
    if (failure === 'crashed') h.healthRunner.mockRejectedValueOnce(new Error('runtime missing'));
    else h.healthRunner.mockResolvedValueOnce({ ...fixed, [failure]: true });
    await h.check();
    await h.finish();
    await h.finish();
    expect(h.healthRunner).toHaveBeenCalledTimes(2);
    expect(h.persistMessage).toHaveBeenCalledTimes(1);
    expect(h.persistMessage).toHaveBeenCalledWith(expect.objectContaining({
      content: 'page.html: 未能体检这个网页（预览检查不可用）',
    }));
  });

  it('checks every pending file once even if the game repair guard became active', async () => {
    const h = harness();
    h.healthRunner.mockResolvedValueOnce(broken).mockResolvedValue(fixed);
    await h.check('/tmp/one.html');
    await h.check('/tmp/two.html');
    h.ctx.artifact.setRepairGuard({ targetFile: '/tmp/game.html', attempts: 1, phase: 'baseline_repair' });
    await h.finish();
    expect(h.healthRunner).toHaveBeenCalledTimes(4);
    expect(h.persistMessage).toHaveBeenCalledTimes(2);
  });

  it.each([
    ['fixed', fixed, '网页显示问题已修好'],
    ['remaining', broken, '网页仍有 2 个问题：图片无法显示、内容超出页面宽度'],
    ['unavailable', { ...fixed, skipped: true }, '未能体检这个网页（预览检查不可用）'],
  ] as const)('keeps the %s notice visible after reopening SQLite and reading the session', async (_outcome, result, text) => {
    const dir = await mkdtemp(join(tmpdir(), 'preview-outcome-'));
    const dbPath = join(dir, 'session.db');
    let db = new Database(dbPath);
    try {
      applySchema(db, createLogger('PreviewRepairPersistenceTest'));
      db.prepare(`INSERT INTO sessions (id, title, model_provider, model_name, created_at, updated_at) VALUES (?, 'Preview', 'test', 'test', 1, 1)`).run(sessionId);
      const repository = new SessionRepository(db);
      const h = harness(vi.fn(async (message: Message) => { repository.addMessage(sessionId, message); }));
      h.ctx.messages.forEach((message) => repository.addMessage(sessionId, message));
      h.healthRunner.mockResolvedValueOnce(result);
      await h.check();
      await h.finish();
      db.close();
      db = new Database(dbPath);
      const messages = new SessionRepository(db).getMessages(sessionId);
      expect(messages).toHaveLength(3);
      const notice = messages.at(-1)!;
      expect(notice.content).toBe(`page.html: ${text}`);
      expect(notice.metadata?.agentRecoveryNotice).toEqual({ kind: 'web_preview_repair' });
      const nodes = projectTurns(messages, sessionId, false).turns.flatMap((turn) => turn.nodes);
      expect(nodes).toContainEqual(expect.objectContaining({ type: 'system', content: notice.content }));
    } finally {
      db.close();
      await rm(dir, { recursive: true, force: true });
    }
  });
});
