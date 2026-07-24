// ============================================================================
// B4 target 粒度长期授权 —— match / mint / 撤权 的安全变异测试
// ============================================================================
// 真 in-memory SQLite 跑 SessionAutomationService 的真实 SQL（getBySourceRefId / UPDATE
// config_json）+ 一张 sessionId→origin 的 getSession 假表，验证：
//   ① 铸权只能人工触发（模型侧无入口）——未铸造前 match 恒 false；
//   ② target 不同 → 仍走审批（match=false）；
//   ③ 删除/归档 automation → 规则失效（match=false）。

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.unmock('better-sqlite3');
import Database from 'better-sqlite3';
import type BetterSqlite3 from 'better-sqlite3';

const state = vi.hoisted(() => ({
  db: null as BetterSqlite3.Database | null,
  sessions: new Map<string, { origin?: { id?: string } }>(),
}));

vi.mock('../../../src/host/platform', () => ({
  broadcastToRenderer: vi.fn(),
}));

vi.mock('../../../src/host/services/infra/sessionManager', () => ({
  getSessionManager: () => ({ addMessageToSession: vi.fn() }),
}));

vi.mock('../../../src/host/services/infra/logger', () => ({
  createLogger: () => ({ warn: vi.fn(), info: vi.fn(), debug: vi.fn(), error: vi.fn() }),
}));

vi.mock('../../../src/host/services/core/databaseService', () => ({
  getDatabase: () => ({
    getDb: () => state.db,
    getSession: (id: string) => state.sessions.get(id) ?? null,
  }),
}));

import { SessionAutomationService } from '../../../src/host/services/sessionAutomation/sessionAutomationService';

const SOURCE_REF = 'cron-def-1';
const RUN_SESSION = 'run-session-abc';
const TOOL = 'mail_send';
const TARGET = 'a@x.com,b@x.com';

function createSchema(db: BetterSqlite3.Database): void {
  db.exec(`
    CREATE TABLE session_automations (
      id TEXT PRIMARY KEY,
      source_session_id TEXT,
      type TEXT NOT NULL,
      status TEXT NOT NULL,
      title TEXT NOT NULL,
      cadence_label TEXT,
      next_run_at INTEGER,
      last_run_at INTEGER,
      source_ref_id TEXT,
      result_session_id TEXT,
      config_json TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
  `);
}

function insertAutomation(db: BetterSqlite3.Database, status: string, config: object = {}): void {
  db.prepare(`
    INSERT INTO session_automations
      (id, source_session_id, type, status, title, source_ref_id, config_json, created_at, updated_at)
    VALUES (?, ?, 'cron', ?, 'demo', ?, ?, 1, 1)
  `).run('cron:cron-def-1', 'src-session', status, SOURCE_REF, JSON.stringify(config));
}

describe('B4 standing grant — match / mint / 撤权', () => {
  let svc: SessionAutomationService;

  beforeEach(() => {
    state.db = new Database(':memory:');
    createSchema(state.db);
    state.sessions.clear();
    // 运行会话 origin.id = cron 定义 id = automation sourceRefId（cronService.createSession 的约定）
    state.sessions.set(RUN_SESSION, { origin: { id: SOURCE_REF } });
    svc = new SessionAutomationService();
  });

  afterEach(() => {
    state.db?.close();
    state.db = null;
  });

  it('① 未铸造前 match 恒 false（模型跑工具不能自铸权，需人工 allow_standing 才有规则）', () => {
    insertAutomation(state.db!, 'active');
    expect(svc.matchStandingGrant(RUN_SESSION, TOOL, TARGET)).toBe(false);
  });

  it('人工铸造后同 (tool,target) 命中 → match=true', () => {
    insertAutomation(state.db!, 'active');
    expect(svc.mintStandingGrant(RUN_SESSION, TOOL, TARGET, 1000)).toBe(true);
    expect(svc.matchStandingGrant(RUN_SESSION, TOOL, TARGET)).toBe(true);
  });

  it('铸造幂等：重复铸造同 (tool,target) 不产生第二条规则', () => {
    insertAutomation(state.db!, 'active');
    svc.mintStandingGrant(RUN_SESSION, TOOL, TARGET, 1000);
    svc.mintStandingGrant(RUN_SESSION, TOOL, TARGET, 2000);
    const record = svc.getBySourceRefId(SOURCE_REF);
    expect(record?.config?.standingGrants).toHaveLength(1);
  });

  it('② target 不同 → 仍走审批（match=false，防换收件人/频道复用授权提权）', () => {
    insertAutomation(state.db!, 'active');
    svc.mintStandingGrant(RUN_SESSION, TOOL, TARGET, 1000);
    expect(svc.matchStandingGrant(RUN_SESSION, TOOL, 'a@x.com,c@x.com')).toBe(false);
    expect(svc.matchStandingGrant(RUN_SESSION, TOOL, 'a@x.com')).toBe(false);
    // 工具不同也不命中
    expect(svc.matchStandingGrant(RUN_SESSION, 'mcp__lark__im_v1_message_create', TARGET)).toBe(false);
  });

  it('③ automation 归档（删除 cron 的效果）→ 规则失效（match=false，撤权）', () => {
    insertAutomation(state.db!, 'active');
    svc.mintStandingGrant(RUN_SESSION, TOOL, TARGET, 1000);
    expect(svc.matchStandingGrant(RUN_SESSION, TOOL, TARGET)).toBe(true);
    // 删除 cron → recordCronAutomationArchived 把 automation 置 archived
    state.db!.prepare('UPDATE session_automations SET status = ? WHERE source_ref_id = ?').run('archived', SOURCE_REF);
    expect(svc.matchStandingGrant(RUN_SESSION, TOOL, TARGET)).toBe(false);
  });

  it('③b automation 整行删除 → 规则失效（match=false）', () => {
    insertAutomation(state.db!, 'active');
    svc.mintStandingGrant(RUN_SESSION, TOOL, TARGET, 1000);
    state.db!.prepare('DELETE FROM session_automations WHERE source_ref_id = ?').run(SOURCE_REF);
    expect(svc.matchStandingGrant(RUN_SESSION, TOOL, TARGET)).toBe(false);
  });

  it('非 automation 会话（origin 无 id）不能铸权也不命中', () => {
    insertAutomation(state.db!, 'active');
    state.sessions.set('manual-session', { origin: {} });
    expect(svc.mintStandingGrant('manual-session', TOOL, TARGET, 1000)).toBe(false);
    expect(svc.matchStandingGrant('manual-session', TOOL, TARGET)).toBe(false);
  });

  it('paused automation 仍可命中（active/running/paused 都算有效），completed 不算', () => {
    insertAutomation(state.db!, 'paused');
    svc.mintStandingGrant(RUN_SESSION, TOOL, TARGET, 1000);
    expect(svc.matchStandingGrant(RUN_SESSION, TOOL, TARGET)).toBe(true);
    state.db!.prepare('UPDATE session_automations SET status = ? WHERE source_ref_id = ?').run('completed', SOURCE_REF);
    expect(svc.matchStandingGrant(RUN_SESSION, TOOL, TARGET)).toBe(false);
  });
});
