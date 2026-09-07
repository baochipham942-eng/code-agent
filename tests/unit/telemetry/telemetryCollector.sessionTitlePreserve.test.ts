// ============================================================================
// N-TELEMETRY-SESSION-TITLE-STALE — startSession 不拿占位标题反砸既有真标题
// insertSession 是 INSERT OR REPLACE 全列覆盖；同一会话续跑（新进程/新一轮）时
// config.title 仍是入口占位（'CLI Session' / 首条消息前 80 字），不保的话会把
// 写路径同步来的真标题砸回快照。这里钉住保标题语义。
// ============================================================================

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// tests/setup.ts 全局 mock 了 better-sqlite3；本文件要真实 SQLite 行为
vi.unmock('better-sqlite3');
import Database from 'better-sqlite3';

import { applySchema } from '../../../src/host/services/core/database/schema';
import { applyTelemetrySchema } from '../../../src/host/services/core/database/schemaTelemetry';
import { TelemetryStorage } from '../../../src/host/telemetry/telemetryStorage';
import { TelemetryCollector } from '../../../src/host/telemetry/telemetryCollector';

const LOGGER = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } as never;

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

function storedTitle(db: Database.Database, sessionId: string): string | null {
  const row = db.prepare('SELECT title FROM telemetry_sessions WHERE id = ?').get(sessionId) as { title: string | null } | undefined;
  return row?.title ?? null;
}

describe('TelemetryCollector.startSession 标题保真', () => {
  let db: Database.Database;
  let collector: TelemetryCollector;

  beforeEach(() => {
    db = new Database(':memory:');
    applySchema(db, LOGGER);
    applyTelemetrySchema(db, LOGGER);
    (TelemetryCollector as unknown as { instance: TelemetryCollector | null }).instance = null;
    collector = TelemetryCollector.initInstanceWithStorage(new TelemetryStorage(db));
  });

  afterEach(async () => {
    await collector.dispose();
    (TelemetryCollector as unknown as { instance: TelemetryCollector | null }).instance = null;
    db.close();
  });

  it('续跑已有真标题的会话：占位 config.title 不覆盖库里的标题', () => {
    db.prepare(
      'INSERT INTO telemetry_sessions (id, title, model_provider, model_name, working_directory, start_time, status) VALUES (?, ?, ?, ?, ?, ?, ?)',
    ).run('s-cont', '写路径同步过的真标题', 'deepseek', 'deepseek-chat', '/ws', 1, 'completed');

    collector.startSession('s-cont', {
      title: 'CLI Session',
      modelProvider: 'deepseek',
      modelName: 'deepseek-chat',
      workingDirectory: '/ws',
    });

    expect(storedTitle(db, 's-cont')).toBe('写路径同步过的真标题');
    // 内存里的 activeSession 也带真标题，session_end 事件不再回落占位
    expect(collector.getSessionData('s-cont')?.title).toBe('写路径同步过的真标题');
  });

  it('全新会话：没有既有行，照旧落入口占位', () => {
    collector.startSession('s-fresh', {
      title: '第一条消息前 80 字占位',
      modelProvider: 'deepseek',
      modelName: 'deepseek-chat',
      workingDirectory: '/ws',
    });

    expect(storedTitle(db, 's-fresh')).toBe('第一条消息前 80 字占位');
  });

  it('既有行标题为空白：视为没标题，落入口占位', () => {
    db.prepare(
      'INSERT INTO telemetry_sessions (id, title, model_provider, model_name, working_directory, start_time, status) VALUES (?, ?, ?, ?, ?, ?, ?)',
    ).run('s-blank', '   ', 'deepseek', 'deepseek-chat', '/ws', 1, 'completed');

    collector.startSession('s-blank', {
      title: '新占位',
      modelProvider: 'deepseek',
      modelName: 'deepseek-chat',
      workingDirectory: '/ws',
    });

    expect(storedTitle(db, 's-blank')).toBe('新占位');
  });

  it('首次建行：sessions 已有真标题时用它，不落入口占位', () => {
    db.prepare(`
      INSERT INTO sessions (id, title, model_provider, model_name, session_type, created_at, updated_at)
      VALUES (?, ?, 'deepseek', 'deepseek-chat', 'chat', 0, 0)
    `).run('s-named', '用户先改的名字');

    collector.startSession('s-named', {
      title: '第一条消息前 80 字占位',
      modelProvider: 'deepseek',
      modelName: 'deepseek-chat',
      workingDirectory: '/ws',
    });

    expect(storedTitle(db, 's-named')).toBe('用户先改的名字');
    expect(collector.getSessionData('s-named')?.title).toBe('用户先改的名字');
  });

  it('续跑：sessions 已改名时覆盖旧遥测标题（云端直写不走 SM 钩子）', () => {
    db.prepare(
      'INSERT INTO telemetry_sessions (id, title, model_provider, model_name, working_directory, start_time, status) VALUES (?, ?, ?, ?, ?, ?, ?)',
    ).run('s-cloud', 'CLI Session', 'deepseek', 'deepseek-chat', '/ws', 1, 'completed');
    db.prepare(`
      INSERT INTO sessions (id, title, model_provider, model_name, session_type, created_at, updated_at)
      VALUES (?, ?, 'deepseek', 'deepseek-chat', 'chat', 0, 0)
    `).run('s-cloud', '云端同步来的真标题');

    collector.startSession('s-cloud', {
      title: 'CLI Session',
      modelProvider: 'deepseek',
      modelName: 'deepseek-chat',
      workingDirectory: '/ws',
    });

    expect(storedTitle(db, 's-cloud')).toBe('云端同步来的真标题');
  });

  it('首次建行：sessions 仍是 New Chat 时保留入口快照', () => {
    db.prepare(`
      INSERT INTO sessions (id, title, model_provider, model_name, session_type, created_at, updated_at)
      VALUES (?, ?, 'deepseek', 'deepseek-chat', 'chat', 0, 0)
    `).run('s-default', 'New Chat');

    collector.startSession('s-default', {
      title: '第一条消息前 80 字占位',
      modelProvider: 'deepseek',
      modelName: 'deepseek-chat',
      workingDirectory: '/ws',
    });

    expect(storedTitle(db, 's-default')).toBe('第一条消息前 80 字占位');
  });
});
