import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.unmock('better-sqlite3');
import Database from 'better-sqlite3';

import { runStartupMaintenance } from '../../../src/host/services/core/database/startupMaintenance';
import { applySessionsMigrations } from '../../../src/host/services/core/database/migrations';
import { applySchema } from '../../../src/host/services/core/database/schema';
import { applyConversationBranchSchema } from '../../../src/host/services/core/database/schemaConversationBranch';
import { MemoryRepository } from '../../../src/host/services/core/repositories/MemoryRepository';
import { PermissionDecisionRepository } from '../../../src/host/services/core/repositories/PermissionDecisionRepository';
import { SessionRepository } from '../../../src/host/services/core/repositories/SessionRepository';
import { ToolExecutionEventRepository } from '../../../src/host/services/core/repositories/ToolExecutionEventRepository';
import type { createLogger } from '../../../src/host/services/infra/logger';
import type { Message, Session } from '../../../src/shared/contract';

type Logger = ReturnType<typeof createLogger>;

const INTERRUPTED_PLACEHOLDER =
  'interrupted: process crashed before a result was recorded; do not assume it ran or succeeded';
const INTERRUPTED_PLACEHOLDER_NOT_STARTED =
  'interrupted: process crashed before this tool call started; it never began running and is safe to re-issue';

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
      toolCallId: 'call-1',
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

  it('classifies an orphan tool call with no ledger begin as NOT_STARTED', () => {
    createSession('not-started-session', 'running');
    sessionRepo.addMessage('not-started-session', assistantToolCall('assistant-ns', 'call-ns'));
    expect(toolExecutionEventRepo.hasBeginForToolCall('not-started-session', 'call-ns')).toBe(false);

    runMaintenance();

    const messages = sessionRepo.getMessages('not-started-session');
    expect(messages).toHaveLength(2);
    expect(messages[1]).toMatchObject({
      id: 'assistant-ns:interrupted-tool-results',
      role: 'tool',
      toolResults: [{
        toolCallId: 'call-ns',
        success: false,
        error: INTERRUPTED_PLACEHOLDER_NOT_STARTED,
        duration: 0,
        metadata: { crashRecoveryTier: 'NOT_STARTED' },
      }],
    });
  });

  it('classifies an orphan tool call with a ledger begin as OUTCOME_UNKNOWN with the legacy placeholder', () => {
    createSession('outcome-unknown-session', 'running');
    sessionRepo.addMessage('outcome-unknown-session', assistantToolCall('assistant-ou', 'call-ou'));
    toolExecutionEventRepo.appendBegin({
      executionId: 'execution-ou',
      sessionId: 'outcome-unknown-session',
      toolName: 'bash',
      summary: 'sleep 30',
      params: { command: 'sleep 30' },
      toolCallId: 'call-ou',
      recordedAt: 20,
    });
    // 开口执行（有 begin 无 complete）与 begin+recovered 两种形态都判「有 begin」
    expect(toolExecutionEventRepo.hasBeginForToolCall('outcome-unknown-session', 'call-ou')).toBe(true);
    toolExecutionEventRepo.appendComplete({
      executionId: 'execution-ou',
      toolName: 'bash',
      status: 'recovered',
      sessionId: 'outcome-unknown-session',
      recordedAt: 21,
    });
    expect(toolExecutionEventRepo.hasBeginForToolCall('outcome-unknown-session', 'call-ou')).toBe(true);

    runMaintenance();

    const messages = sessionRepo.getMessages('outcome-unknown-session');
    expect(messages).toHaveLength(2);
    expect(messages[1]).toMatchObject({
      role: 'tool',
      toolResults: [{
        toolCallId: 'call-ou',
        success: false,
        error: INTERRUPTED_PLACEHOLDER,
        duration: 0,
        metadata: { crashRecoveryTier: 'OUTCOME_UNKNOWN' },
      }],
    });
  });

  it('splits tiers per tool call inside one mixed assistant message', () => {
    createSession('mixed-session', 'running');
    sessionRepo.addMessage('mixed-session', {
      id: 'assistant-mixed',
      role: 'assistant',
      content: '',
      timestamp: 10,
      toolCalls: [
        { id: 'call-begun', name: 'bash', arguments: { command: 'sleep 30' } },
        { id: 'call-never-begun', name: 'Read', arguments: { file_path: 'README.md' } },
      ],
    });
    toolExecutionEventRepo.appendBegin({
      executionId: 'execution-mixed',
      sessionId: 'mixed-session',
      toolName: 'bash',
      summary: 'sleep 30',
      params: { command: 'sleep 30' },
      toolCallId: 'call-begun',
      recordedAt: 20,
    });

    runMaintenance();

    const messages = sessionRepo.getMessages('mixed-session');
    expect(messages).toHaveLength(2);
    expect(messages[1].toolResults).toEqual([
      expect.objectContaining({
        toolCallId: 'call-begun',
        error: INTERRUPTED_PLACEHOLDER,
        metadata: { crashRecoveryTier: 'OUTCOME_UNKNOWN' },
      }),
      expect.objectContaining({
        toolCallId: 'call-never-begun',
        error: INTERRUPTED_PLACEHOLDER_NOT_STARTED,
        metadata: { crashRecoveryTier: 'NOT_STARTED' },
      }),
    ]);
  });

  it('falls back to OUTCOME_UNKNOWN when the ledger begin lookup throws', () => {
    createSession('lookup-fail-session', 'running');
    sessionRepo.addMessage('lookup-fail-session', assistantToolCall('assistant-lf', 'call-lf'));
    vi.spyOn(toolExecutionEventRepo, 'hasBeginForToolCall').mockImplementation(() => {
      throw new Error('ledger unavailable');
    });

    runMaintenance();

    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('fail-safe OUTCOME_UNKNOWN'),
      expect.objectContaining({ message: 'ledger unavailable' }),
    );
    const messages = sessionRepo.getMessages('lookup-fail-session');
    expect(messages).toHaveLength(2);
    expect(messages[1]).toMatchObject({
      role: 'tool',
      toolResults: [{
        toolCallId: 'call-lf',
        success: false,
        error: INTERRUPTED_PLACEHOLDER,
        metadata: { crashRecoveryTier: 'OUTCOME_UNKNOWN' },
      }],
    });
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
});
