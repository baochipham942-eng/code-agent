import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.unmock('better-sqlite3');
import Database from 'better-sqlite3';

import { runStartupMaintenance } from '../../../src/host/services/core/database/startupMaintenance';
import { applySessionsMigrations } from '../../../src/host/services/core/database/migrations';
import { applySchema } from '../../../src/host/services/core/database/schema';
import { applyConversationBranchSchema } from '../../../src/host/services/core/database/schemaConversationBranch';
import { MemoryRepository } from '../../../src/host/services/core/repositories/MemoryRepository';
import { PermissionDecisionRepository } from '../../../src/host/services/core/repositories/PermissionDecisionRepository';
import { ConversationBranchRepository } from '../../../src/host/services/core/repositories/ConversationBranchRepository';
import { SessionRepository } from '../../../src/host/services/core/repositories/SessionRepository';
import { ToolExecutionEventRepository } from '../../../src/host/services/core/repositories/ToolExecutionEventRepository';
import { DatabaseReadOnlyError } from '../../../src/host/services/core/database/sqliteErrors';
import type { createLogger } from '../../../src/host/services/infra/logger';
import type { Message, Session } from '../../../src/shared/contract';

type Logger = ReturnType<typeof createLogger>;

const INTERRUPTED_PLACEHOLDER =
  'interrupted: process crashed before a result was recorded; do not assume it ran or succeeded';

describe('startup maintenance orphan tool-call closure', () => {
  let db: InstanceType<typeof Database>;
  let sessionRepo: SessionRepository;
  let toolExecutionEventRepo: ToolExecutionEventRepository;
  let logger: Logger;

  beforeEach(() => {
    db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    logger = {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    } as unknown as Logger;
    applySchema(db, logger);
    applySessionsMigrations(db, logger);
    applyConversationBranchSchema(db, { backfillLegacy: false });
    sessionRepo = new SessionRepository(db);
    toolExecutionEventRepo = new ToolExecutionEventRepository(db);
  });

  afterEach(() => db.close());

  function createSession(id: string, status: Session['status']): void {
    sessionRepo.createSession({
      id,
      title: id,
      modelConfig: { provider: 'openai', model: 'gpt-5' },
      createdAt: 1,
      updatedAt: 1,
      status,
    } as Session);
  }

  function assistantToolCall(id: string, toolCallId: string): Message {
    return {
      id,
      role: 'assistant',
      content: '',
      timestamp: 10,
      toolCalls: [{ id: toolCallId, name: 'bash', arguments: { command: 'sleep 30' } }],
    };
  }

  function runMaintenance(): void {
    runStartupMaintenance({
      db,
      sessionRepo,
      memoryRepo: new MemoryRepository(db),
      toolExecutionEventRepo,
      permissionDecisionRepo: new PermissionDecisionRepository(db),
      logger,
      step: vi.fn(),
    });
  }

  it('appends interrupted results and an immutable conversation append for a crashed session', () => {
    createSession('crashed-session', 'running');
    sessionRepo.addMessage('crashed-session', assistantToolCall('assistant-1', 'call-1'));
    toolExecutionEventRepo.appendBegin({
      executionId: 'execution-1',
      sessionId: 'crashed-session',
      toolName: 'bash',
      summary: 'sleep 30',
      params: { command: 'sleep 30' },
      recordedAt: 20,
    });
    const branchEventsBefore = db.prepare(
      'SELECT COUNT(*) AS count FROM conversation_branch_events',
    ).get() as { count: number };

    runMaintenance();

    const messages = sessionRepo.getMessages('crashed-session');
    expect(messages).toHaveLength(2);
    expect(messages[1]).toMatchObject({
      id: 'assistant-1:interrupted-tool-results',
      role: 'tool',
      toolResults: [{
        toolCallId: 'call-1',
        success: false,
        error: INTERRUPTED_PLACEHOLDER,
        duration: 0,
      }],
    });
    expect(db.prepare('SELECT COUNT(*) AS count FROM conversation_branch_events').get())
      .toEqual({ count: branchEventsBefore.count + 1 });
    const provenance = db.prepare(`
      SELECT provenance_json
      FROM conversation_entries
      WHERE source_session_id = ? AND source_message_id = ?
    `).get('crashed-session', 'assistant-1:interrupted-tool-results') as { provenance_json: string };
    expect(JSON.parse(provenance.provenance_json)).toMatchObject({ kind: 'crash-recovery' });
    expect(toolExecutionEventRepo.getBySession('crashed-session')).toMatchObject([
      { executionId: 'execution-1', phase: 'begin', status: null },
      { executionId: 'execution-1', phase: 'complete', status: 'recovered' },
    ]);
  });

  // 返修 r1：begin 写入全链路 fail-safe 吞错（toolExecutionLedger.begin 的 catch、
  // databaseService.appendToolExecutionBegin 在 db 未就绪/只读降级时静默返回、其余错误仅 warn），
  // 工具照常执行——这层已由 tests/unit/tools/toolExecutor.executionLedger.test.ts 钉住。
  // 因此「账本无 begin 行」推不出「从未执行」。这里钉住后果：begin 行没写进去（工具实际
  // 已执行、随后崩溃、结果未落盘）时，清算必须维持「不得假设跑过」的保守占位串。
  function runBeginWriteFailureScenario(createWriteError: () => Error): void {
    createSession('begin-write-failed-session', 'running');
    sessionRepo.addMessage('begin-write-failed-session', assistantToolCall('assistant-bwf', 'call-bwf'));
    const appendBegin = vi.spyOn(toolExecutionEventRepo, 'appendBegin').mockImplementation(() => {
      throw createWriteError();
    });
    // 运行期：执行器已走到 begin 落账点，但写入抛错（生产链路里被上游吞掉），行未落盘
    expect(() =>
      toolExecutionEventRepo.appendBegin({
        executionId: 'execution-bwf',
        sessionId: 'begin-write-failed-session',
        toolName: 'bash',
        summary: 'sleep 30',
        params: { command: 'sleep 30' },
        toolCallId: 'call-bwf',
        recordedAt: 20,
      }),
    ).toThrow();
    appendBegin.mockRestore();
    expect(
      db.prepare(`SELECT COUNT(*) AS count FROM tool_execution_events WHERE phase = 'begin'`).get(),
    ).toEqual({ count: 0 });

    runMaintenance();

    const closure = sessionRepo.getMessages('begin-write-failed-session')[1];
    expect(closure.toolResults).toEqual([
      expect.objectContaining({
        toolCallId: 'call-bwf',
        success: false,
        error: INTERRUPTED_PLACEHOLDER,
        duration: 0,
      }),
    ]);
    expect(JSON.stringify(closure.toolResults)).not.toContain('safe to re-issue');
    expect(JSON.stringify(closure.toolResults)).not.toContain('never began running');
    expect(closure.toolResults?.[0]?.metadata).toBeUndefined();
  }

  it('keeps the do-not-assume placeholder when the begin ledger write failed with SQLITE_BUSY before the crash', () => {
    runBeginWriteFailureScenario(() => new Error('database is locked'));
  });

  it('keeps the do-not-assume placeholder when the begin ledger write failed in read-only degraded mode', () => {
    runBeginWriteFailureScenario(() => new DatabaseReadOnlyError());
  });

  it('does not append a second result when the recovered session crashes again', () => {
    createSession('repeat-session', 'running');
    sessionRepo.addMessage('repeat-session', assistantToolCall('assistant-repeat', 'call-repeat'));

    runMaintenance();
    const addMessage = vi.spyOn(sessionRepo, 'addMessage');
    db.prepare(`UPDATE sessions SET status = 'running' WHERE id = ?`).run('repeat-session');
    runMaintenance();

    expect(addMessage).not.toHaveBeenCalled();
    expect(
      sessionRepo.getMessages('repeat-session').filter((message) => message.role === 'tool'),
    ).toHaveLength(1);
    expect(db.prepare(`
      SELECT COUNT(*) AS count
      FROM conversation_branch_events
      WHERE event_type = 'append'
    `).get()).toEqual({ count: 2 });
  });

  it('leaves stored-automatic calls open for application continuation instead of interrupting them', () => {
    createSession('automatic-session', 'running');
    sessionRepo.addMessage(
      'automatic-session',
      assistantToolCall('assistant-automatic', 'call-automatic'),
    );
    toolExecutionEventRepo.appendBegin({
      executionId: 'execution-automatic',
      sessionId: 'automatic-session',
      toolName: 'Read',
      summary: 'read file',
      params: { file_path: 'README.md' },
      toolCallId: 'call-automatic',
      replaySafety: 'automatic',
      recordedAt: 20,
    });

    runMaintenance();

    expect(sessionRepo.getMessages('automatic-session')).toHaveLength(1);
    expect(toolExecutionEventRepo.getOpenExecutions()).toEqual([
      expect.objectContaining({
        executionId: 'execution-automatic',
        toolCallId: 'call-automatic',
        replaySafety: 'automatic',
      }),
    ]);
  });

  it('does not modify completed sessions or crashed sessions whose tool calls already have results', () => {
    createSession('completed-session', 'completed');
    sessionRepo.addMessage(
      'completed-session',
      assistantToolCall('assistant-completed', 'call-completed'),
    );
    createSession('already-settled-session', 'running');
    sessionRepo.addMessage(
      'already-settled-session',
      assistantToolCall('assistant-settled', 'call-settled'),
    );
    sessionRepo.addMessage('already-settled-session', {
      id: 'tool-settled',
      role: 'tool',
      content: 'done',
      timestamp: 11,
      toolResults: [{ toolCallId: 'call-settled', success: true, output: 'done' }],
    });
    const messageCountBefore = db.prepare('SELECT COUNT(*) AS count FROM messages').get();
    const branchEventCountBefore = db.prepare(
      'SELECT COUNT(*) AS count FROM conversation_branch_events',
    ).get();

    runMaintenance();

    expect(db.prepare('SELECT COUNT(*) AS count FROM messages').get()).toEqual(messageCountBefore);
    expect(db.prepare('SELECT COUNT(*) AS count FROM conversation_branch_events').get())
      .toEqual(branchEventCountBefore);
    expect(sessionRepo.getSession('completed-session')?.status).toBe('completed');
  });

  it('warns and continues when one crashed session cannot persist its closure', () => {
    createSession('broken-session', 'running');
    sessionRepo.addMessage('broken-session', assistantToolCall('assistant-broken', 'call-broken'));
    createSession('healthy-session', 'running');
    sessionRepo.addMessage('healthy-session', assistantToolCall('assistant-healthy', 'call-healthy'));
    const addMessage = sessionRepo.addMessage.bind(sessionRepo);
    vi.spyOn(sessionRepo, 'addMessage').mockImplementation((sessionId, message, options) => {
      if (sessionId === 'broken-session' && message.role === 'tool') {
        throw new Error('injected closure failure');
      }
      addMessage(sessionId, message, options);
    });

    runMaintenance();

    expect(sessionRepo.getMessages('broken-session')).toHaveLength(1);
    expect(sessionRepo.getMessages('healthy-session')).toHaveLength(2);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('broken-session'),
      expect.objectContaining({ message: 'injected closure failure' }),
    );
  });

  it('projects a crash-recovery closure after legacy rows when the session has no branch yet', () => {
    const sessionId = 'legacy-crashed';
    createSession(sessionId, 'running');
    sessionRepo.addMessage(sessionId, {
      id: 'user-legacy',
      role: 'user',
      content: 'run the long command',
      timestamp: 1,
    }, { skipConversationLedger: true });
    sessionRepo.addMessage(
      sessionId,
      assistantToolCall('assistant-legacy', 'call-legacy'),
      { skipConversationLedger: true },
    );
    expect(db.prepare(
      'SELECT COUNT(*) AS count FROM conversation_branches WHERE session_id = ?',
    ).get(sessionId)).toEqual({ count: 0 });

    runMaintenance();
    applyConversationBranchSchema(db);

    const boundary = { ownerUserId: null, projectId: null };
    const branchRepo = new ConversationBranchRepository(db);
    const audit = branchRepo.auditLineage(sessionId, boundary);
    const messageIds = sessionRepo.getMessages(sessionId).map((message) => message.id);
    const ledgerIds = (db.prepare(`
      SELECT projected_message_id
      FROM conversation_branch_entries
      WHERE branch_id = (SELECT id FROM conversation_branches WHERE session_id = ?)
      ORDER BY ordinal ASC
    `).all(sessionId) as Array<{ projected_message_id: string }>)
      .map((row) => row.projected_message_id);
    let replayError: string | null = null;
    try {
      branchRepo.replay(sessionId, boundary);
    } catch (error) {
      replayError = error instanceof Error ? error.message : String(error);
    }
    expect({
      auditStatus: audit.status,
      issues: audit.issues.map((issue) => `${issue.code}: ${issue.detail}`),
      replayError,
      ledgerIds,
      messageIds,
    }).toEqual({
      auditStatus: 'healthy',
      issues: [],
      replayError: null,
      ledgerIds: messageIds,
      messageIds: [
        'user-legacy',
        'assistant-legacy',
        'assistant-legacy:interrupted-tool-results',
      ],
    });
  });

  it('keeps the immutable crash-recovery append when the session already has a branch', () => {
    const sessionId = 'branched-crashed';
    createSession(sessionId, 'running');
    sessionRepo.addMessage(sessionId, assistantToolCall('assistant-branched', 'call-branched'));
    expect(db.prepare(
      'SELECT COUNT(*) AS count FROM conversation_branches WHERE session_id = ?',
    ).get(sessionId)).toEqual({ count: 1 });
    const eventsBefore = db.prepare(
      'SELECT COUNT(*) AS count FROM conversation_branch_events',
    ).get() as { count: number };

    runMaintenance();

    const provenance = db.prepare(`
      SELECT provenance_json
      FROM conversation_entries
      WHERE source_session_id = ? AND source_message_id = ?
    `).get(sessionId, 'assistant-branched:interrupted-tool-results') as { provenance_json: string };
    expect(JSON.parse(provenance.provenance_json)).toMatchObject({ kind: 'crash-recovery' });
    expect(db.prepare('SELECT COUNT(*) AS count FROM conversation_branch_events').get())
      .toEqual({ count: eventsBefore.count + 1 });
    const boundary = { ownerUserId: null, projectId: null };
    const branchRepo = new ConversationBranchRepository(db);
    expect(branchRepo.auditLineage(sessionId, boundary)).toMatchObject({
      status: 'healthy',
      issues: [],
    });
    const messageIds = sessionRepo.getMessages(sessionId).map((message) => message.id);
    expect(messageIds).toEqual([
      'assistant-branched',
      'assistant-branched:interrupted-tool-results',
    ]);
    expect(branchRepo.replay(sessionId, boundary).messages.map((message) => message.projectedMessageId))
      .toEqual(messageIds);
  });
});
