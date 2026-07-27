import { afterEach, describe, expect, it, vi } from 'vitest';

vi.unmock('better-sqlite3');
import Database from 'better-sqlite3';

import { applySchema } from '../../../src/host/services/core/database/schema';
import { applySessionsMigrations } from '../../../src/host/services/core/database/migrations';
import { applyConversationBranchSchema } from '../../../src/host/services/core/database/schemaConversationBranch';
import { ConversationBranchRepository } from '../../../src/host/services/core/repositories/ConversationBranchRepository';
import { SessionForkRepository } from '../../../src/host/services/core/repositories/SessionForkRepository';
import { SessionRepository } from '../../../src/host/services/core/repositories/SessionRepository';
import { ProjectRepository } from '../../../src/host/services/core/repositories/ProjectRepository';
import { createLogger } from '../../../src/host/services/infra/logger';

const logger = createLogger('ConversationBranchProductionIntegration.test');
vi.spyOn(logger, 'debug').mockImplementation(() => undefined);
vi.spyOn(logger, 'info').mockImplementation(() => undefined);
vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
vi.spyOn(logger, 'error').mockImplementation(() => undefined);
const boundary = { ownerUserId: 'owner-1', projectId: 'project-1' } as const;

describe('immutable conversation ledger production write integration', () => {
  let db: InstanceType<typeof Database>;

  afterEach(() => db?.close());

  it('double-writes Session/Message/Fork/Rewind atomically while sharing the fork prefix', () => {
    db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    applySchema(db, logger);
    applySessionsMigrations(db, logger);
    applyConversationBranchSchema(db, { backfillLegacy: false });

    const sessions = new SessionRepository(db);
    const ledger = new ConversationBranchRepository(db);
    const forks = new SessionForkRepository(db, ledger);
    sessions.createSession({
      id: 'source',
      userId: 'owner-1',
      projectId: 'project-1',
      title: 'Source',
      modelConfig: { provider: 'openai', model: 'gpt-5' },
      status: 'idle',
      createdAt: 1,
      updatedAt: 1,
    } as never);
    for (const [id, role, content, timestamp] of [
      ['u1', 'user', 'one', 10],
      ['a1', 'assistant', 'answer one', 20],
      ['u2', 'user', 'two', 30],
      ['a2', 'assistant', 'answer two', 40],
      ['u3', 'user', 'three', 50],
    ] as const) {
      sessions.addMessage('source', { id, role, content, timestamp });
    }

    const sourceProjectionBefore = JSON.stringify(
      db.prepare('SELECT * FROM sessions WHERE id = ?').get('source'),
    ) + JSON.stringify(
      db.prepare('SELECT * FROM messages WHERE session_id = ? ORDER BY timestamp, rowid').all('source'),
    );
    const fork = forks.createFork({
      sourceSessionId: 'source',
      anchorAssistantMessageId: 'a2',
      idempotencyKey: 'fork-at-a2',
      ownerUserId: 'owner-1',
      forkId: 'fork-1',
      childSessionId: 'child',
      childTitle: 'Child',
      workspaceMode: 'shared_current',
      contextDeliveryMode: 'neo_native_prefix',
      now: 100,
    });

    expect(JSON.stringify(
      db.prepare('SELECT * FROM sessions WHERE id = ?').get('source'),
    ) + JSON.stringify(
      db.prepare('SELECT * FROM messages WHERE session_id = ? ORDER BY timestamp, rowid').all('source'),
    )).toBe(sourceProjectionBefore);

    const sourceReplay = ledger.replay('source', boundary);
    const childReplay = ledger.replay('child', boundary);
    expect(sourceReplay.messages.map((message) => message.projectedMessageId))
      .toEqual(['u1', 'a1', 'u2', 'a2', 'u3']);
    expect(childReplay.messages.map((message) => message.entryId))
      .toEqual(sourceReplay.messages.slice(0, 4).map((message) => message.entryId));
    expect(childReplay.messages.map((message) => message.projectedMessageId))
      .toEqual(fork.messageMappings.map((mapping) => mapping.childMessageId));

    const childUserTwo = fork.messageMappings.find((mapping) => mapping.sourceMessageId === 'u2');
    expect(childUserTwo).toBeDefined();
    const rewind = sessions.applyPromptRewind('child', childUserTwo!.childMessageId, {
      ownerUserId: 'owner-1',
      idempotencyKey: 'rewind-child-u2',
      createdAt: 110,
    });
    expect(rewind.hiddenMessageIds).toEqual(
      fork.messageMappings.slice(3).map((mapping) => mapping.childMessageId),
    );
    expect(ledger.replay('child', boundary).messages.map((message) => message.projectedMessageId))
      .toEqual(fork.messageMappings.slice(0, 3).map((mapping) => mapping.childMessageId));

    sessions.restorePromptRewind('child', rewind.rewindId, 120, 'owner-1');
    expect(ledger.replay('child', boundary).messages.map((message) => message.projectedMessageId))
      .toEqual(fork.messageMappings.map((mapping) => mapping.childMessageId));
    expect(ledger.auditLineage('source', boundary).status).toBe('healthy');
    expect(ledger.auditLineage('child', boundary).status).toBe('healthy');
  });

  it('binds an empty session lazily and rejects Project drift after immutable history exists', () => {
    db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    applySchema(db, logger);
    applySessionsMigrations(db, logger);
    applyConversationBranchSchema(db, { backfillLegacy: false });

    const sessions = new SessionRepository(db);
    const projects = new ProjectRepository(db);
    sessions.createSession({
      id: 'empty',
      userId: 'owner-1',
      projectId: 'unsorted',
      title: 'Empty',
      modelConfig: { provider: 'openai', model: 'gpt-5' },
      createdAt: 1,
      updatedAt: 1,
    } as never);
    expect(db.prepare(`
      SELECT COUNT(*) AS count FROM conversation_branches WHERE session_id = 'empty'
    `).get()).toEqual({ count: 0 });

    projects.assignSessionProject('empty', 'project-1');
    sessions.addMessage('empty', {
      id: 'u1',
      role: 'user',
      content: 'hello',
      timestamp: 2,
    });
    expect(new ConversationBranchRepository(db).getBranch(
      'empty',
      boundary,
    ).projectId).toBe('project-1');

    expect(() => projects.assignSessionProject('empty', 'project-2'))
      .toThrow('PROJECT_BOUNDARY_IMMUTABLE');
    expect(db.prepare("SELECT project_id FROM sessions WHERE id = 'empty'").get())
      .toEqual({ project_id: 'project-1' });
  });

  it('persists only sanitized attachment and Artifact provenance in immutable entries', () => {
    db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    applySchema(db, logger);
    applySessionsMigrations(db, logger);
    applyConversationBranchSchema(db, { backfillLegacy: false });
    const sessions = new SessionRepository(db);
    sessions.createSession({
      id: 'private-message',
      userId: 'owner-1',
      projectId: 'project-1',
      title: 'Private',
      modelConfig: { provider: 'openai', model: 'gpt-5' },
      createdAt: 1,
      updatedAt: 1,
    } as never);
    sessions.addMessage('private-message', {
      id: 'a-private',
      role: 'assistant',
      content: 'result\n```mermaid\ngraph TD\nsecret-node --> leaked\n```',
      timestamp: 2,
      attachments: [{
        id: 'attachment-private',
        type: 'file',
        category: 'text',
        name: 'private.txt',
        size: 12,
        mimeType: 'text/plain',
        data: 'secret-attachment-bytes',
        path: '/Users/private/private.txt',
        thumbnail: 'secret-thumbnail-bytes',
        sheetsJson: '{"token":"secret-sheet"}',
        docxJson: '{"token":"secret-docx"}',
        pptJson: '{"token":"secret-ppt"}',
        files: [{ name: 'nested.txt', content: 'secret-nested-content' }],
        archiveManifest: { entries: [{ path: 'nested.txt', size: 12 }] },
        metadata: { token: 'secret-attachment-token' },
      }],
    } as never);

    const immutableRow = db.prepare(`
      SELECT message_json FROM conversation_entries
      WHERE source_session_id = 'private-message'
    `).get() as { message_json: string } | undefined;
    const immutableJson = String(immutableRow?.message_json ?? '');
    expect(immutableJson).not.toContain('secret-attachment-bytes');
    expect(immutableJson).not.toContain('/Users/private');
    expect(immutableJson).not.toContain('secret-node');
    expect(immutableJson).not.toContain('secret-thumbnail');
    expect(immutableJson).not.toContain('secret-sheet');
    expect(immutableJson).not.toContain('secret-docx');
    expect(immutableJson).not.toContain('secret-ppt');
    expect(immutableJson).not.toContain('secret-nested-content');
    expect(immutableJson).not.toContain('secret-attachment-token');
    expect(immutableJson).toContain('readOnlyArtifactProvenance');
    expect(immutableJson).toContain('contentDigest');
  });

  it('accepts legal legacy revisions and replacements but quarantines direct active projection tampering', () => {
    db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    applySchema(db, logger);
    applySessionsMigrations(db, logger);

    const legacySessions = new SessionRepository(db);
    legacySessions.createSession({
      id: 'legacy',
      userId: 'owner-1',
      projectId: 'project-1',
      title: 'Legacy',
      modelConfig: { provider: 'openai', model: 'gpt-5' },
      createdAt: 1,
      updatedAt: 1,
    } as never);
    legacySessions.addMessage('legacy', {
      id: 'u1',
      role: 'user',
      content: 'old prompt',
      timestamp: 2,
    });
    legacySessions.addMessage('legacy', {
      id: 'a1',
      role: 'assistant',
      content: 'old answer',
      timestamp: 3,
    });

    applyConversationBranchSchema(db);
    const sessions = new SessionRepository(db);
    const ledger = new ConversationBranchRepository(db);

    sessions.updateMessage('a1', { content: 'revised answer' }, 'legacy');
    expect(ledger.replay('legacy', boundary).messages.map((message) => message.message.content))
      .toEqual(['old prompt', 'revised answer']);
    expect(ledger.auditLineage('legacy', boundary).status).toBe('healthy');

    sessions.replaceMessages('legacy', [
      { id: 'u1', role: 'user', content: 'replacement prompt', timestamp: 2 },
      { id: 'a1', role: 'assistant', content: 'replacement answer', timestamp: 3 },
    ]);
    expect(ledger.replay('legacy', boundary).messages.map((message) => message.message.content))
      .toEqual(['replacement prompt', 'replacement answer']);
    expect(ledger.auditLineage('legacy', boundary).status).toBe('healthy');

    db.prepare(`
      UPDATE messages
      SET content = 'tampered outside repository'
      WHERE session_id = 'legacy' AND id = 'a1'
    `).run();
    const audit = ledger.auditLineage('legacy', boundary);
    expect(audit.status).toBe('quarantined');
    expect(audit.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({
        code: 'PROJECTION_ALIAS_PAYLOAD_MISMATCH',
        entryId: expect.any(String),
      }),
    ]));
    expect(() => ledger.replay('legacy', boundary)).toThrow('BRANCH_QUARANTINED');
  });

  it('creates a remote session and preserves controlled owner/Project claiming before history exists', () => {
    db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    applySchema(db, logger);
    applySessionsMigrations(db, logger);
    applyConversationBranchSchema(db, { backfillLegacy: false });
    const sessions = new SessionRepository(db);

    sessions.createSessionWithId('remote-new', {
      title: 'Remote new',
      userId: 'cloud-owner',
      projectId: 'cloud-project',
      modelConfig: { provider: 'openai', model: 'gpt-5' },
      createdAt: 1,
      updatedAt: 2,
    }, { syncOrigin: 'remote' });
    expect(db.prepare(`
      SELECT user_id, project_id, title
      FROM sessions
      WHERE id = 'remote-new'
    `).get()).toEqual({
      user_id: 'cloud-owner',
      project_id: 'cloud-project',
      title: 'Remote new',
    });

    sessions.createSession({
      id: 'unbound',
      userId: null,
      projectId: null,
      title: 'Local placeholder',
      modelConfig: { provider: 'openai', model: 'gpt-4.1' },
      createdAt: 3,
      updatedAt: 3,
    } as never);
    expect(db.prepare(`
      SELECT COUNT(*) AS count
      FROM conversation_branches
      WHERE session_id = 'unbound'
    `).get()).toEqual({ count: 0 });

    sessions.createSessionWithId('unbound', {
      title: 'Claimed from cloud',
      userId: 'cloud-owner',
      projectId: 'cloud-project',
      modelConfig: { provider: 'anthropic', model: 'claude-sonnet-4' },
      createdAt: 3,
      updatedAt: 4,
    }, { syncOrigin: 'remote' });
    expect(db.prepare(`
      SELECT user_id, project_id, title, model_provider, model_name
      FROM sessions
      WHERE id = 'unbound'
    `).get()).toEqual({
      user_id: 'cloud-owner',
      project_id: 'cloud-project',
      title: 'Claimed from cloud',
      model_provider: 'anthropic',
      model_name: 'claude-sonnet-4',
    });
  });

  it('rejects remote owner claiming after a local anonymous branch exists with zero writes', () => {
    db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    applySchema(db, logger);
    applySessionsMigrations(db, logger);
    applyConversationBranchSchema(db, { backfillLegacy: false });
    const sessions = new SessionRepository(db);
    sessions.createSession({
      id: 'local-history',
      userId: null,
      projectId: 'project-1',
      title: 'Local history',
      modelConfig: { provider: 'openai', model: 'gpt-5' },
      createdAt: 1,
      updatedAt: 1,
    } as never);
    sessions.addMessage('local-history', {
      id: 'u1',
      role: 'user',
      content: 'local only',
      timestamp: 2,
    });
    const before = JSON.stringify({
      session: db.prepare("SELECT * FROM sessions WHERE id = 'local-history'").get(),
      branch: db.prepare("SELECT * FROM conversation_branches WHERE session_id = 'local-history'").get(),
      entries: db.prepare(`
        SELECT * FROM conversation_entries
        WHERE source_session_id = 'local-history'
        ORDER BY id
      `).all(),
      events: db.prepare(`
        SELECT event.*
        FROM conversation_branch_events AS event
        JOIN conversation_branches AS branch ON branch.id = event.branch_id
        WHERE branch.session_id = 'local-history'
        ORDER BY event.sequence
      `).all(),
    });

    expect(() => sessions.createSessionWithId('local-history', {
      title: 'Cloud takeover',
      userId: 'cloud-owner',
      projectId: 'project-1',
      modelConfig: { provider: 'anthropic', model: 'claude-sonnet-4' },
      createdAt: 1,
      updatedAt: 99,
    }, { syncOrigin: 'remote' })).toThrow('OWNER_MISMATCH');

    expect(JSON.stringify({
      session: db.prepare("SELECT * FROM sessions WHERE id = 'local-history'").get(),
      branch: db.prepare("SELECT * FROM conversation_branches WHERE session_id = 'local-history'").get(),
      entries: db.prepare(`
        SELECT * FROM conversation_entries
        WHERE source_session_id = 'local-history'
        ORDER BY id
      `).all(),
      events: db.prepare(`
        SELECT event.*
        FROM conversation_branch_events AS event
        JOIN conversation_branches AS branch ON branch.id = event.branch_id
        WHERE branch.session_id = 'local-history'
        ORDER BY event.sequence
      `).all(),
    })).toBe(before);
  });

  it('rejects remote Project drift after immutable history exists with zero writes', () => {
    db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    applySchema(db, logger);
    applySessionsMigrations(db, logger);
    applyConversationBranchSchema(db, { backfillLegacy: false });
    const sessions = new SessionRepository(db);
    sessions.createSession({
      id: 'project-history',
      userId: 'owner-1',
      projectId: 'project-1',
      title: 'Project history',
      modelConfig: { provider: 'openai', model: 'gpt-5' },
      createdAt: 1,
      updatedAt: 1,
    } as never);
    sessions.addMessage('project-history', {
      id: 'u1',
      role: 'user',
      content: 'project one',
      timestamp: 2,
    });
    const before = JSON.stringify({
      session: db.prepare("SELECT * FROM sessions WHERE id = 'project-history'").get(),
      branch: db.prepare("SELECT * FROM conversation_branches WHERE session_id = 'project-history'").get(),
      messages: db.prepare(`
        SELECT * FROM messages
        WHERE session_id = 'project-history'
        ORDER BY timestamp, rowid
      `).all(),
    });

    expect(() => sessions.createSessionWithId('project-history', {
      title: 'Wrong project',
      userId: 'owner-1',
      projectId: 'project-2',
      modelConfig: { provider: 'openai', model: 'gpt-5' },
      createdAt: 1,
      updatedAt: 99,
    }, { syncOrigin: 'remote' })).toThrow('PROJECT_MISMATCH');

    expect(JSON.stringify({
      session: db.prepare("SELECT * FROM sessions WHERE id = 'project-history'").get(),
      branch: db.prepare("SELECT * FROM conversation_branches WHERE session_id = 'project-history'").get(),
      messages: db.prepare(`
        SELECT * FROM messages
        WHERE session_id = 'project-history'
        ORDER BY timestamp, rowid
      `).all(),
    })).toBe(before);
  });

  it('allows idempotent remote metadata refresh when owner and Project match the immutable branch', () => {
    db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    applySchema(db, logger);
    applySessionsMigrations(db, logger);
    applyConversationBranchSchema(db, { backfillLegacy: false });
    const sessions = new SessionRepository(db);
    sessions.createSession({
      id: 'same-boundary',
      userId: 'owner-1',
      projectId: 'project-1',
      title: 'Before',
      modelConfig: { provider: 'openai', model: 'gpt-4.1' },
      workingDirectory: '/workspace/before',
      createdAt: 1,
      updatedAt: 1,
    } as never);
    sessions.addMessage('same-boundary', {
      id: 'u1',
      role: 'user',
      content: 'keep immutable',
      timestamp: 2,
    });
    const branchBefore = JSON.stringify(
      db.prepare("SELECT * FROM conversation_branches WHERE session_id = 'same-boundary'").get(),
    );
    const entriesBefore = JSON.stringify(
      db.prepare("SELECT * FROM conversation_entries WHERE source_session_id = 'same-boundary'").all(),
    );
    const refresh = () => sessions.createSessionWithId('same-boundary', {
      title: 'After',
      userId: 'owner-1',
      projectId: 'project-1',
      modelConfig: { provider: 'anthropic', model: 'claude-sonnet-4' },
      workingDirectory: '/workspace/after',
      createdAt: 1,
      updatedAt: 9,
    }, { syncOrigin: 'remote' });

    expect(refresh).not.toThrow();
    expect(refresh).not.toThrow();
    expect(db.prepare(`
      SELECT user_id, project_id, title, model_provider, model_name,
             working_directory, created_at, updated_at
      FROM sessions
      WHERE id = 'same-boundary'
    `).get()).toEqual({
      user_id: 'owner-1',
      project_id: 'project-1',
      title: 'After',
      model_provider: 'anthropic',
      model_name: 'claude-sonnet-4',
      working_directory: '/workspace/after',
      created_at: 1,
      updated_at: 9,
    });
    expect(JSON.stringify(
      db.prepare("SELECT * FROM conversation_branches WHERE session_id = 'same-boundary'").get(),
    )).toBe(branchBefore);
    expect(JSON.stringify(
      db.prepare("SELECT * FROM conversation_entries WHERE source_session_id = 'same-boundary'").all(),
    )).toBe(entriesBefore);
  });
});
