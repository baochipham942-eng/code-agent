import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

vi.unmock('better-sqlite3');
import Database from 'better-sqlite3';
import { DatabaseService } from '../../../src/host/services/core/databaseService';
import { applySchema } from '../../../src/host/services/core/database/schema';
import { applySessionsMigrations } from '../../../src/host/services/core/database/migrations';
import { applyConversationBranchSchema } from '../../../src/host/services/core/database/schemaConversationBranch';
import { ConversationBranchRepository } from '../../../src/host/services/core/repositories/ConversationBranchRepository';
import { HistoricalSessionRecoveryRepository } from '../../../src/host/services/core/repositories/HistoricalSessionRecoveryRepository';
import { SessionRepository } from '../../../src/host/services/core/repositories/SessionRepository';
import { ConfigRepository } from '../../../src/host/services/core/repositories/ConfigRepository';
import { SessionForkWorkspaceRepository } from '../../../src/host/services/core/repositories/SessionForkWorkspaceRepository';
import { createLogger } from '../../../src/host/services/infra/logger';
import { readModule } from '../../../src/host/tools/modules/file/read';
import { fileReadTracker } from '../../../src/host/tools/fileReadTracker';

const fixture = vi.hoisted(() => ({ database: null as DatabaseService | null, actor: 'fixture-owner' }));
// Only singleton wiring and the external identity/cloud services are replaced.
// DatabaseService, SessionManager, repositories, replay and Read remain real.
vi.mock('../../../src/host/services/core', () => ({ getDatabase: () => {
  if (!fixture.database) throw new Error('fixture database is unavailable');
  return fixture.database;
} }));
vi.mock('../../../src/host/services/auth/authService', () => ({ getAuthService: () => ({
  getCurrentUser: () => ({ id: fixture.actor }), hasVerifiedSession: () => true,
}) }));
vi.mock('../../../src/host/services/infra/supabaseService', () => ({
  getSupabase: () => { throw new Error('network is forbidden in this fixture'); },
  isSupabaseInitialized: () => false,
}));
import { SessionManager } from '../../../src/host/services/infra/sessionManager';

const sourceId = 'cli_session_12345678_continue';
const owner = 'fixture-owner';
const logger = createLogger('historical-continuation-fixture');

describe('historical recovery continues through real session restore and a native Read task', () => {
  let db: Database.Database;
  let directory: string;
  let manager: SessionManager;
  let ledger: ConversationBranchRepository;
  let recovery: HistoricalSessionRecoveryRepository;
  let oldDataDirectory: string | undefined;

  beforeEach(async () => {
    directory = await fs.mkdtemp(path.join(os.tmpdir(), 'neo-history-continuation-'));
    oldDataDirectory = process.env.CODE_AGENT_DATA_DIR;
    process.env.CODE_AGENT_DATA_DIR = directory;
    fixture.actor = owner;
    db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    applySchema(db, logger);
    applySessionsMigrations(db, logger);
    applyConversationBranchSchema(db, { backfillLegacy: false });
    const sessions = new SessionRepository(db);
    ledger = new ConversationBranchRepository(db);
    recovery = new HistoricalSessionRecoveryRepository(db);
    fixture.database = new DatabaseService(directory);
    Object.assign(fixture.database, {
      db, sessionRepo: sessions, conversationBranchRepo: ledger,
      configRepo: new ConfigRepository(db), sessionForkWorkspaceRepo: new SessionForkWorkspaceRepository(db),
    });
    manager = new SessionManager();
    sessions.createSession({ id: sourceId, title: 'Fixture reading task', workingDirectory: directory,
      modelConfig: { provider: 'openai', model: 'fixture-model' }, createdAt: 1, updatedAt: 1 } as never);
    sessions.addMessage(sourceId, { id: 'source-question', role: 'user',
      content: 'Read task.txt and report its verification token.', timestamp: 10 });
    sessions.addMessage(sourceId, { id: 'source-answer', role: 'assistant',
      content: 'The file reading task is awaiting continuation.', timestamp: 20 });
    db.prepare('UPDATE sessions SET user_id = ? WHERE id = ?').run(owner, sourceId);
    fileReadTracker.clear();
  });

  afterEach(async () => {
    await manager?.dispose();
    fixture.database = null;
    db?.close();
    fileReadTracker.clear();
    if (oldDataDirectory === undefined) delete process.env.CODE_AGENT_DATA_DIR;
    else process.env.CODE_AGENT_DATA_DIR = oldDataDirectory;
    if (directory) await fs.rm(directory, { recursive: true, force: true });
    vi.unstubAllGlobals();
  });

  it('blocks the original, executes Read from restored history, and persists the result under the recovered owner', async () => {
    const network = vi.fn(() => { throw new Error('external model/network must not run'); });
    vi.stubGlobal('fetch', network);
    const token = randomUUID();
    const taskFile = path.join(directory, 'task.txt');
    await fs.writeFile(taskFile, `verification-token=${token}\n`, 'utf8');
    const originalMessages = db.prepare('SELECT * FROM messages WHERE session_id = ? ORDER BY timestamp').all(sourceId);

    await expect(manager.restoreSession(sourceId)).rejects.toThrow(/OWNER_MISMATCH/);
    const plan = recovery.recover(owner, { sessionId: sourceId, projectId: null, action: 'inspect' });
    expect(plan.status).toBe('ready');
    const imported = recovery.recover(owner, { sessionId: sourceId, projectId: null,
      action: 'import', expectedDigest: plan.sourceDigest });
    expect(imported.status).toBe('imported');
    const targetId = imported.sessions![0].targetSessionId;
    const restored = await manager.restoreSession(targetId);
    expect(restored?.messages.map((message) => message.content)).toEqual([
      'Read task.txt and report its verification token.',
      'The file reading task is awaiting continuation.',
    ]);

    // Deterministic model stand-in: selects the file from the restored task, then
    // consumes actual tool output. It does not synthesize an expected tool result.
    const fileName = /^Read (\S+) and/.exec(restored!.messages[0].content)?.[1];
    expect(fileName).toBe('task.txt');
    await manager.addMessage({ id: 'continued-user', role: 'user', content: 'Continue the saved task.', timestamp: 30 });
    const handler = await readModule.createHandler();
    const progress: string[] = [];
    const result = await handler.execute({ file_path: fileName }, {
      sessionId: targetId, agentId: 'fixture-model', workingDir: restored!.workingDirectory!,
      abortSignal: new AbortController().signal, logger, emit: () => {},
    }, async (name, args) => {
      // This fixture authorizes only Read on its generated task file. There is no
      // approval record or approval response, and normal ownership replay is real.
      ledger.replay(targetId, { ownerUserId: fixture.actor, projectId: null });
      if (name === 'Read' && path.resolve(directory, String(args.file_path)) === taskFile) {
        return { allow: true };
      }
      return { allow: false, reason: 'Only reading the generated fixture task file is authorized' };
    }, (event) => progress.push(event.stage));
    expect(result).toMatchObject({ ok: true, output: expect.stringContaining(token) });
    expect(progress).toContain('completing');
    expect(fileReadTracker.getReadRecord(taskFile)?.digest).toBeDefined();
    if (!result.ok) throw new Error(result.error);
    const observedToken = /verification-token=([^\s]+)/.exec(String(result.output))?.[1];
    expect(observedToken).toBe(token);
    await manager.addMessage({ id: 'continued-result', role: 'assistant',
      content: `Read completed. Verification token: ${observedToken}`, timestamp: 40,
      toolCalls: [{ id: 'continued-read', name: 'Read', arguments: { file_path: fileName } }],
      toolResults: [{ toolCallId: 'continued-read', success: true, output: String(result.output) }],
    });
    // A fresh product manager must recover the persisted follow-up from the ledger.
    await manager.dispose();
    manager = new SessionManager();
    const completed = await manager.restoreSession(targetId);
    expect(completed?.messages.at(-1)?.content).toContain(token);
    expect(completed?.messages.at(-1)?.toolResults).toEqual([
      { toolCallId: 'continued-read', success: true, output: result.output },
    ]);
    expect(ledger.auditLineage(targetId, { ownerUserId: owner, projectId: null }).status).toBe('healthy');
    expect(db.prepare('SELECT * FROM messages WHERE session_id = ? ORDER BY timestamp').all(sourceId)).toEqual(originalMessages);
    expect(await fs.readFile(taskFile, 'utf8')).toBe(`verification-token=${token}\n`);

    fixture.actor = 'intruder';
    expect(await manager.restoreSession(targetId)).toBeNull();
    await expect(manager.addMessageToSession(targetId, { id: 'intruder-message', role: 'user',
      content: 'Unauthorized continuation', timestamp: 50 })).rejects.toThrow(/not found/);
    expect(db.prepare('SELECT id FROM messages WHERE id = ?').get('intruder-message')).toBeUndefined();
    expect(network).not.toHaveBeenCalled();
  });
});
