// ============================================================================
// N-TELEMETRY-SESSION-TITLE-STALE — sessions.title 变更同步回遥测表
// 改名 / 自动起标题都收口在 SessionManager.updateSession（sessionManager.ts:1240 的
// maybeUpdateTitleForSession 与 session.ipc / sessionDomainHandler 的改名都走它），
// 这里钉住：updates.title 非空时 telemetry_sessions.title 跟随为脱敏后的值。
// ============================================================================

import { beforeEach, describe, expect, it, vi } from 'vitest';

// tests/setup.ts 全局 mock 了 better-sqlite3；本文件要真实 SQLite 行为
vi.unmock('better-sqlite3');
import Database from 'better-sqlite3';

import { applySchema } from '../../../../src/host/services/core/database/schema';
import { applyTelemetrySchema } from '../../../../src/host/services/core/database/schemaTelemetry';
import { guardTelemetryText } from '../../../../src/host/telemetry/telemetryStorageParsers';

const LOGGER = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } as never;

const temp = vi.hoisted(() => ({ db: null as Database.Database | null }));

const RENAME_TITLE = '帮我修登录页 sk-proj-abcdefghij1234567890';

const database = vi.hoisted(() => ({
  isReady: true,
  getDb: vi.fn(() => temp.db),
  getSession: vi.fn((sessionId: string) => ({
    id: sessionId,
    userId: null,
    title: 'New Session',
    modelConfig: { provider: 'deepseek', model: 'deepseek-chat' },
    workingDirectory: null,
    createdAt: 1,
    updatedAt: 1,
    messageCount: 1,
    turnCount: 1,
  })),
  updateSession: vi.fn(),
  logAuditEvent: vi.fn(),
  getRecentMessages: vi.fn(() => []),
  hasConversationBranch: vi.fn(() => false),
  getTodos: vi.fn(() => []),
}));

vi.mock('../../../../src/host/services/core', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../../../src/host/services/core')>(),
  getDatabase: () => database,
}));

vi.mock('../../../../src/host/services/core/databaseService', () => ({
  getDatabase: () => database,
}));

vi.mock('../../../../src/host/services/auth/authService', () => ({
  getAuthService: () => ({ getCurrentUser: () => null }),
}));

vi.mock('../../../../src/host/services/infra/supabaseService', () => ({
  isSupabaseInitialized: () => false,
  getSupabase: () => null,
}));

vi.mock('../../../../src/host/services/infra/toolCache', () => ({
  getToolCache: () => ({ clearSession: vi.fn(), setSessionId: vi.fn() }),
}));

vi.mock('../../../../src/host/observability/posthogNode', () => ({
  trackNode: vi.fn(),
}));

vi.mock('../../../../src/host/telemetry/systemPromptCache', () => ({
  getSystemPromptCache: () => ({ ensureTable: vi.fn() }),
}));

vi.mock('../../../../src/host/telemetry/diagnosticVersions', () => ({
  getDiagnosticVersions: () => ({ agentVersion: 't', promptVersion: 't', toolSchemaVersion: 't' }),
}));

// 自动起标题用例里 generateSmartTitle 动态 import 的 quickModel：关掉走降级截断分支
vi.mock('../../../../src/host/model/quickModel', () => ({
  isQuickModelAvailable: () => false,
  quickTask: vi.fn(),
}));

import { SessionManager } from '../../../../src/host/services/infra/sessionManager';

function telemetryTitle(db: Database.Database, sessionId: string): string | null {
  const row = db.prepare('SELECT title FROM telemetry_sessions WHERE id = ?').get(sessionId) as { title: string | null } | undefined;
  return row?.title ?? null;
}

describe('SessionManager.updateSession 标题同步遥测表', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // TelemetryStorage 单例的 stmtCache 绑首个库，整文件共用一个 :memory: 库、按用例清行
    if (!temp.db) {
      temp.db = new Database(':memory:');
      applySchema(temp.db, LOGGER);
      applyTelemetrySchema(temp.db, LOGGER);
    }
    temp.db.prepare('DELETE FROM telemetry_sessions').run();
    temp.db.prepare(
      'INSERT INTO telemetry_sessions (id, title, model_provider, model_name, working_directory, start_time, status) VALUES (?, ?, ?, ?, ?, ?, ?)',
    ).run('s-rename', 'CLI Session', 'deepseek', 'deepseek-chat', '/ws', 1, 'recording');
    temp.db.prepare(
      'INSERT INTO telemetry_sessions (id, title, model_provider, model_name, working_directory, start_time, status) VALUES (?, ?, ?, ?, ?, ?, ?)',
    ).run('s-auto', 'CLI Session', 'deepseek', 'deepseek-chat', '/ws', 1, 'recording');
  });

  it('用户改名：telemetry_sessions.title 跟随为脱敏后的值', async () => {
    const manager = new SessionManager();

    await manager.updateSession('s-rename', { title: RENAME_TITLE });

    const expected = guardTelemetryText(RENAME_TITLE, 2_000);
    expect(expected).not.toBe(RENAME_TITLE); // 样例里确实带密钥，guard 必须真改写
    expect(telemetryTitle(temp.db!, 's-rename')).toBe(expected);
  });

  it('自动起标题（maybeUpdateTitleForSession 降级分支）同样跟随', async () => {
    const manager = new SessionManager();

    await (manager as unknown as { maybeUpdateTitleForSession: (id: string, msg: string) => Promise<void> })
      .maybeUpdateTitleForSession('s-auto', '第一句话特别长'.repeat(20));

    const title = telemetryTitle(temp.db!, 's-auto');
    expect(title).toBeTruthy();
    expect(title).not.toBe('CLI Session');
    expect(database.updateSession).toHaveBeenCalledWith('s-auto', expect.objectContaining({ title: expect.any(String) }));
  });

  it('updates.title 为空/缺省时不动遥测表', async () => {
    const manager = new SessionManager();

    await manager.updateSession('s-rename', { status: 'archived' });
    expect(telemetryTitle(temp.db!, 's-rename')).toBe('CLI Session');

    await manager.updateSession('s-rename', { title: '   ' });
    expect(telemetryTitle(temp.db!, 's-rename')).toBe('CLI Session');
  });
});
