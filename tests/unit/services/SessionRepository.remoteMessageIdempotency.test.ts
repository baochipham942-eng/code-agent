import { afterEach, describe, expect, it, vi } from 'vitest';

vi.unmock('better-sqlite3');
import Database from 'better-sqlite3';
import { applySchema } from '../../../src/host/services/core/database/schema';
import { applySessionsMigrations } from '../../../src/host/services/core/database/migrations';
import { applyConversationBranchSchema } from '../../../src/host/services/core/database/schemaConversationBranch';
import { SessionRepository } from '../../../src/host/services/core/repositories/SessionRepository';
import { createLogger } from '../../../src/host/services/infra/logger';

const logger = createLogger('SessionRepository.remoteMessageIdempotency.test');
vi.spyOn(logger, 'debug').mockImplementation(() => undefined);
vi.spyOn(logger, 'info').mockImplementation(() => undefined);
vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
vi.spyOn(logger, 'error').mockImplementation(() => undefined);

// T6: sessionManager.getSession() 的懒加载云端回填分支会用 syncOrigin:'remote'
// 重新 addMessage() 本地可能已经存在的消息 id（并发回填 / 本地消息已被 rewind
// 隐藏而不计入 active 计数两种情况都会触发）。addMessage() 之前对同 id 无条件
// INSERT，命中 messages.id 主键冲突就把 "UNIQUE constraint failed: messages.id"
// 一路抛给调用方（真机复现：getSnapshot 报该错误）。
// 本测试直接钉死 SessionRepository.addMessage 的契约：
//   - syncOrigin:'remote' 对已存在的 id 是幂等 no-op（不抛错、不覆盖本地内容）
//   - 不带 syncOrigin（本地写入路径）对已存在的 id 仍然严格报错，
//     因为那意味着真实的 ID 生成 bug，不能被静默吞掉。
describe('SessionRepository.addMessage 对同 id 消息的幂等契约（T6 messages.id UNIQUE）', () => {
  let db: InstanceType<typeof Database>;

  afterEach(() => db?.close());

  function setUp(): SessionRepository {
    db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    applySchema(db, logger);
    applySessionsMigrations(db, logger);
    applyConversationBranchSchema(db, { backfillLegacy: false });
    const sessions = new SessionRepository(db);
    sessions.createSession({
      id: 'sess-1',
      userId: 'owner-1',
      projectId: 'project-1',
      title: 'Session',
      modelConfig: { provider: 'openai', model: 'gpt-5' },
      status: 'idle',
      createdAt: 1,
      updatedAt: 1,
    } as never);
    return sessions;
  }

  it('syncOrigin:remote 对已存在的消息 id 是幂等 no-op：不抛错、不覆盖本地内容', () => {
    const sessions = setUp();
    sessions.addMessage('sess-1', { id: 'm1', role: 'user', content: 'local original', timestamp: 10 });

    expect(() => sessions.addMessage('sess-1', {
      id: 'm1',
      role: 'user',
      content: 'cloud stale copy',
      timestamp: 10,
    }, { syncOrigin: 'remote', skipTimestampUpdate: true })).not.toThrow();

    const row = db.prepare('SELECT content FROM messages WHERE id = ?').get('m1') as { content: string };
    expect(row.content).toBe('local original');
    expect(db.prepare('SELECT COUNT(*) AS c FROM messages WHERE id = ?').get('m1')).toEqual({ c: 1 });
    // 账本也不应该因为这次 no-op 写入产生第二条 append 事件。
    expect(
      db.prepare(`
        SELECT COUNT(*) AS c FROM conversation_branch_entries
        WHERE projected_session_id = 'sess-1' AND projected_message_id = 'm1'
      `).get(),
    ).toEqual({ c: 1 });
  });

  it('本地写入路径（无 syncOrigin）对已存在的消息 id 依旧严格报错——真实 ID 冲突不能被静默吞掉', () => {
    const sessions = setUp();
    sessions.addMessage('sess-1', { id: 'm1', role: 'user', content: 'first', timestamp: 10 });

    expect(() => sessions.addMessage('sess-1', {
      id: 'm1',
      role: 'user',
      content: 'duplicate id bug',
      timestamp: 20,
    })).toThrow(/UNIQUE constraint failed/);
  });
});
