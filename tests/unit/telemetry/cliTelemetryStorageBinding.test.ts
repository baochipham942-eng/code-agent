// ============================================================================
// CLI 遥测落库绑定（缺口修复：neo session timeline 的 Telemetry turns 恒为 0）
//
// 根因：TelemetryStorage 默认走主 DatabaseService，CLI 进程刻意不初始化它，
// CLI 会话的 turn 边界全部静默落在内存。修复 = CLI schema 建 telemetry 表 +
// TelemetryCollector 单例用 dbOverride 绑定 CLI 连接。本文件钉住这三处。
// ============================================================================

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// tests/setup.ts 全局 mock 了 better-sqlite3；本文件要真实 SQLite 行为
vi.unmock('better-sqlite3');

import Database from 'better-sqlite3';
import { applyTelemetrySchema } from '../../../src/host/services/core/database/schemaTelemetry';
import { createCliTables } from '../../../src/cli/cliDatabaseSchema';
import { TelemetryStorage } from '../../../src/host/telemetry/telemetryStorage';
import { TelemetryCollector } from '../../../src/host/telemetry/telemetryCollector';

vi.mock('../../../src/host/services/infra/logger', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

vi.mock('../../../src/host/services/serviceRegistry', () => ({
  getServiceRegistry: () => ({ register: vi.fn() }),
}));

// trackNode（PostHog）离线无害化
vi.mock('../../../src/host/services/infra/posthog', () => ({
  trackNode: vi.fn(),
}));

vi.mock('../../../src/host/services/auth/authService', () => ({
  getAuthService: () => ({ getCurrentUser: () => null }),
}));

const schemaLogger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };

function createTelemetryDb(): Database.Database {
  const db = new Database(':memory:');
  applyTelemetrySchema(db, schemaLogger as never);
  db.exec(`ALTER TABLE telemetry_turns ADD COLUMN agent_id TEXT DEFAULT 'main'`);
  return db;
}

describe('CLI telemetry schema（cliDatabaseSchema 建 telemetry 表）', () => {
  it('createCliTables 建出 telemetry_turns（含 agent_id 列）与 telemetry_sessions', () => {
    const db = new Database(':memory:');
    createCliTables(db);

    const turnColumns = (db.pragma('table_info(telemetry_turns)') as Array<{ name: string }>)
      .map((column) => column.name);
    expect(turnColumns).toContain('session_id');
    expect(turnColumns).toContain('turn_number');
    expect(turnColumns).toContain('agent_id');
    expect(turnColumns).toContain('turn_type');
    expect(
      db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='telemetry_sessions'").get(),
    ).toBeTruthy();
    db.close();
  });

  it('applyTelemetrySchema 幂等（与桌面共库，重复执行不炸）', () => {
    const db = new Database(':memory:');
    createCliTables(db);
    createCliTables(db);
    db.close();
  });
});

describe('TelemetryCollector.initInstanceWithStorage（CLI dbOverride 绑定）', () => {
  beforeEach(() => {
    (TelemetryCollector as unknown as { instance: TelemetryCollector | null }).instance = null;
  });

  afterEach(async () => {
    const instance = (TelemetryCollector as unknown as { instance: TelemetryCollector | null }).instance;
    if (instance) await instance.dispose();
    (TelemetryCollector as unknown as { instance: TelemetryCollector | null }).instance = null;
  });

  it('首个显式 storage 生效，后续 getInstance / init 不覆盖', () => {
    const dbA = createTelemetryDb();
    const dbB = createTelemetryDb();
    const first = TelemetryCollector.initInstanceWithStorage(new TelemetryStorage(dbA));
    const second = TelemetryCollector.initInstanceWithStorage(new TelemetryStorage(dbB));

    expect(second).toBe(first);
    expect(TelemetryCollector.getInstance()).toBe(first);
    dbA.close();
    dbB.close();
  });

  it('CLI 生命周期端到端：turn 边界落到 telemetry_turns（timeline 不再恒 0）', () => {
    const db = createTelemetryDb();
    const collector = TelemetryCollector.initInstanceWithStorage(new TelemetryStorage(db));
    const sessionId = 'cli_session_test_telemetry';

    collector.startSession(sessionId, {
      title: 'CLI Session',
      modelProvider: 'custom-tokenrhythm',
      modelName: 'glm-5.3-flash',
      workingDirectory: '/tmp/neo-verify',
    });
    const adapter = collector.createAdapter(sessionId, 'cli');
    adapter.onTurnStart('turn-1', 1, '只回复 ok');
    adapter.onTurnEnd('turn-1', 'ok', undefined, 'hash-1');
    collector.endSession(sessionId);

    const turns = db
      .prepare('SELECT id, session_id, turn_number, outcome_status FROM telemetry_turns WHERE session_id = ?')
      .all(sessionId) as Array<Record<string, unknown>>;
    expect(turns).toHaveLength(1);
    expect(turns[0]).toMatchObject({ id: 'turn-1', session_id: sessionId, turn_number: 1 });

    const session = db
      .prepare('SELECT id, status FROM telemetry_sessions WHERE id = ?')
      .get(sessionId) as Record<string, unknown>;
    expect(session).toMatchObject({ id: sessionId, status: 'completed' });
    db.close();
  });
});
