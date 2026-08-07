import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
vi.unmock('better-sqlite3');
import Database from 'better-sqlite3';
import { DatabaseService } from '../../../../src/host/services/core/databaseService';
import { applySchema } from '../../../../src/host/services/core/database/schema';
import { applySessionsMigrations } from '../../../../src/host/services/core/database/migrations';
import { SessionRepository } from '../../../../src/host/services/core/repositories/SessionRepository';

// T6: getSnapshot -> SessionManager.getSession() 的懒加载云端回填分支曾经在
// "本地存在同 id 消息（例如已被 rewind 隐藏，不计入 active 消息数）" 时
// 无条件 INSERT，命中 messages.id 主键冲突并把 UNIQUE constraint 错误一路
// 抛到 Surface Execution IPC（"getSnapshot 报 messages.id UNIQUE"）。
// 本测试真跑 SessionManager.getSession() 全链路（真实 SQLite + 打桩 Supabase），
// 钉死：读路径不再因为回填触发的重复写入而报错，且本地既有状态不被云端覆盖。

const currentUser = vi.hoisted(() => ({ value: { id: 'user-1' } as { id: string } | null }));
const supabaseRows = vi.hoisted(() => ({ value: [] as Array<Record<string, unknown>> }));

vi.mock('../../../../src/host/services/infra/toolCache', () => ({
  getToolCache: () => ({ clearSession: vi.fn() }),
}));

vi.mock('../../../../src/host/services/auth/authService', () => ({
  getAuthService: () => ({ getCurrentUser: () => currentUser.value }),
}));

vi.mock('../../../../src/host/services/infra/supabaseService', () => ({
  isSupabaseInitialized: () => true,
  getSupabase: () => ({
    from: () => ({
      select: () => ({
        eq: () => ({
          eq: () => ({
            order: () => Promise.resolve({ data: supabaseRows.value, error: null }),
          }),
        }),
      }),
    }),
  }),
}));

const coreDatabase = vi.hoisted(() => ({ current: null as DatabaseService | null }));

vi.mock('../../../../src/host/services/core', () => ({
  getDatabase: () => {
    if (!coreDatabase.current) throw new Error('core database unavailable');
    return coreDatabase.current;
  },
}));

import { SessionManager } from '../../../../src/host/services/infra/sessionManager';

const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };

describe('SessionManager.getSession 云端回填幂等（T6 messages.id UNIQUE）', () => {
  let tmpDir: string;
  let previousDataDir: string | undefined;
  let coreDb: DatabaseService;
  let coreConnection: Database.Database;
  let sessionManager: SessionManager;

  beforeEach(() => {
    vi.clearAllMocks();
    currentUser.value = { id: 'user-1' };
    supabaseRows.value = [];
    previousDataDir = process.env.CODE_AGENT_DATA_DIR;
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sm-cloud-pull-'));
    process.env.CODE_AGENT_DATA_DIR = tmpDir;

    coreDb = new DatabaseService();
    coreConnection = new Database(path.join(tmpDir, 'code-agent.db'));
    coreConnection.pragma('journal_mode = WAL');
    applySchema(coreConnection, logger as never);
    applySessionsMigrations(coreConnection, logger as never);
    Object.assign(coreDb as unknown as Record<string, unknown>, {
      db: coreConnection,
      sessionRepo: new SessionRepository(coreConnection),
    });
    coreDatabase.current = coreDb;
    sessionManager = new SessionManager();
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await sessionManager?.dispose();
    coreDatabase.current = null;
    try { coreDb.close(); } catch { /* noop */ }
    if (previousDataDir === undefined) delete process.env.CODE_AGENT_DATA_DIR;
    else process.env.CODE_AGENT_DATA_DIR = previousDataDir;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('本地已存在同 id 消息（rewind 隐藏、active 计数为 0）时，云端回填不报错也不覆盖本地状态', async () => {
    coreDb.createSessionWithId('sess-rewound', {
      title: 'sess-rewound',
      userId: 'user-1',
      modelConfig: { provider: 'zhipu', model: 'glm-5' },
    });
    // 本地物理上已有这条消息，但因 visibility=hidden 不计入 getRecentMessages(active) 的计数，
    // 这正是 sessionManager.getSession() 判定"本地没有消息，去云端拉"的触发条件。
    coreConnection.prepare(`
      INSERT INTO messages (id, session_id, role, content, timestamp, visibility, hidden_by_rewind_id, hidden_at)
      VALUES ('m1', 'sess-rewound', 'user', 'local original (hidden)', 10, 'hidden', 'rewind-1', 20)
    `).run();
    // 云端返回的是这条消息 rewind 之前的快照——同 id、不同内容。
    supabaseRows.value = [{
      id: 'm1',
      role: 'user',
      content: 'cloud stale copy',
      timestamp: 10,
      visibility: 'active',
      hidden_by_rewind_id: null,
      hidden_at: null,
      is_deleted: false,
    }];

    await expect(sessionManager.getSession('sess-rewound')).resolves.not.toThrow();

    const row = coreConnection.prepare(
      "SELECT content, visibility, hidden_by_rewind_id FROM messages WHERE id = 'm1'",
    ).get() as { content: string; visibility: string; hidden_by_rewind_id: string | null };
    // 本地状态（含隐藏标记）必须保持不变——云端回填绝不能盖掉本地更新的撤回状态。
    expect(row).toEqual({
      content: 'local original (hidden)',
      visibility: 'hidden',
      hidden_by_rewind_id: 'rewind-1',
    });
    expect(coreConnection.prepare('SELECT COUNT(*) AS c FROM messages WHERE id = ?').get('m1'))
      .toEqual({ c: 1 });
  });

  it('本地确实没有消息时，云端回填照常把新消息写入本地（未被幂等修复误伤）', async () => {
    coreDb.createSessionWithId('sess-empty', {
      title: 'sess-empty',
      userId: 'user-1',
      modelConfig: { provider: 'zhipu', model: 'glm-5' },
    });
    supabaseRows.value = [{
      id: 'm-new',
      role: 'assistant',
      content: 'hydrated from cloud',
      timestamp: 5,
      visibility: 'active',
      hidden_by_rewind_id: null,
      hidden_at: null,
      is_deleted: false,
    }];

    const session = await sessionManager.getSession('sess-empty');

    expect(session?.messages.map((m) => m.content)).toEqual(['hydrated from cloud']);
    expect(coreConnection.prepare('SELECT content FROM messages WHERE id = ?').get('m-new'))
      .toEqual({ content: 'hydrated from cloud' });
  });
});
