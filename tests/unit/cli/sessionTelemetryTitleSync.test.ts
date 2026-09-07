// ============================================================================
// N-TELEMETRY-SESSION-TITLE-STALE — CLI SessionManager 标题同步遥测表
// 生产 webServer 的 /api/run 链路（webSessionStore.prepareCliSessionForWrite /
// commitTurn、CLI 自动起标题）都经 cli/session.ts updateSession 写 sessions.title，
// 这里钉住：updates.title 非空时 telemetry_sessions.title 跟随为脱敏后的值。
// ============================================================================

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// tests/setup.ts 全局 mock 了 better-sqlite3；本文件要真实 SQLite 行为
vi.unmock('better-sqlite3');
import Database from 'better-sqlite3';

import { applySchema } from '../../../src/host/services/core/database/schema';
import { applyTelemetrySchema } from '../../../src/host/services/core/database/schemaTelemetry';
import { TelemetryStorage } from '../../../src/host/telemetry/telemetryStorage';
import { TelemetryCollector } from '../../../src/host/telemetry/telemetryCollector';
import { guardTelemetryText } from '../../../src/host/telemetry/telemetryStorageParsers';

const LOGGER = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } as never;

const RENAME_TITLE = 'CLI 改名 sk-proj-abcdefghij1234567890';

const cliDatabase = vi.hoisted(() => ({
  isInitialized: true,
  getSession: vi.fn((sessionId: string) => ({
    id: sessionId,
    userId: null,
    title: 'CLI Session 2026/9/7 上午10:00:00',
    modelConfig: { provider: 'deepseek', model: 'deepseek-chat' },
    createdAt: 1,
    updatedAt: 1,
    messageCount: 1,
    turnCount: 1,
  })),
  updateSession: vi.fn(),
}));

vi.mock('../../../src/cli/database', () => ({
  getCLIDatabase: () => cliDatabase,
}));

vi.mock('../../../src/host/services/infra/logger', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

vi.mock('../../../src/host/services/serviceRegistry', () => ({
  getServiceRegistry: () => ({ register: vi.fn() }),
}));

vi.mock('../../../src/host/services/auth/authService', () => ({
  getAuthService: () => ({ getCurrentUser: () => null }),
}));

vi.mock('../../../src/host/observability/posthogNode', () => ({
  trackNode: vi.fn(),
}));

vi.mock('../../../src/host/telemetry/systemPromptCache', () => ({
  getSystemPromptCache: () => ({ ensureTable: vi.fn() }),
}));

vi.mock('../../../src/host/telemetry/diagnosticVersions', () => ({
  getDiagnosticVersions: () => ({ agentVersion: 't', promptVersion: 't', toolSchemaVersion: 't' }),
}));

const { CLISessionManager } = await import('../../../src/cli/session');

function resetCollectorSingleton(db: Database.Database): void {
  (TelemetryCollector as unknown as { instance: TelemetryCollector | null }).instance = null;
  TelemetryCollector.initInstanceWithStorage(new TelemetryStorage(db));
}

describe('CLI SessionManager.updateSession 标题同步遥测表', () => {
  let db: Database.Database;
  let manager: InstanceType<typeof CLISessionManager>;

  beforeEach(() => {
    vi.clearAllMocks();
    db = new Database(':memory:');
    applySchema(db, LOGGER);
    applyTelemetrySchema(db, LOGGER);
    db.prepare(
      'INSERT INTO telemetry_sessions (id, title, model_provider, model_name, working_directory, start_time, status) VALUES (?, ?, ?, ?, ?, ?, ?)',
    ).run('cli-s1', 'CLI Session', 'deepseek', 'deepseek-chat', '/ws', 1, 'recording');
    resetCollectorSingleton(db);
    manager = new CLISessionManager();
  });

  afterEach(async () => {
    const instance = (TelemetryCollector as unknown as { instance: TelemetryCollector | null }).instance;
    if (instance) await instance.dispose();
    (TelemetryCollector as unknown as { instance: TelemetryCollector | null }).instance = null;
    db.close();
  });

  it('标题变更（webSessionStore 首条消息派生标题 / 改名）同步遥测，脱敏后落库', async () => {
    await manager.updateSession('cli-s1', { title: RENAME_TITLE });

    const expected = guardTelemetryText(RENAME_TITLE, 2_000);
    expect(expected).not.toBe(RENAME_TITLE);
    const row = db.prepare('SELECT title FROM telemetry_sessions WHERE id = ?').get('cli-s1') as { title: string | null };
    expect(row.title).toBe(expected);
  });

  it('updates.title 为空/缺省时不动遥测表', async () => {
    await manager.updateSession('cli-s1', { status: 'archived' });
    await manager.updateSession('cli-s1', { title: '' });

    const row = db.prepare('SELECT title FROM telemetry_sessions WHERE id = ?').get('cli-s1') as { title: string | null };
    expect(row.title).toBe('CLI Session');
  });
});
