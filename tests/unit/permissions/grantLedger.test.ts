// ============================================================================
// 统一授权台账（N-PERM-GRANT-LEDGER）—— 验收 ①②③⑤ 的钉子
// ============================================================================
// 真 in-memory SQLite 同时装 app 授权表与 session_automations 表，ConfirmationGate
// 走真单例，验证：
//   ① 一个台账列全三种「允许」（app 常驻 / app 会话 / tool-target / tool-session），
//      归一形状（kind/source/grantedAt/expiresAt）与 id 稳定可解析；
//   ② 撤销任何一种，下一次同名检查回到「从未授权」；
//   ③ 过期条目（注入时钟）不列出也不匹配；
//   ⑤ 没有任何 agent 可调用工具暴露 list/revoke（no-self-revoke）。

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

import { applyAppGrantsSchema } from '../../../src/host/services/core/database/schemaAppGrants';
import {
  bindAppGrantDatabase,
  matchAppGrant,
  mintAppGrantSession,
  mintAppGrantStanding,
} from '../../../src/host/permissions/appGrantStore';
import { listGrants, revokeGrant } from '../../../src/host/permissions/grantLedger';
import { SessionAutomationService } from '../../../src/host/services/sessionAutomation/sessionAutomationService';
import { getConfirmationGate, resetConfirmationGate } from '../../../src/host/agent/confirmationGate';

const logger = {
  info: () => {},
  warn: () => {},
  debug: () => {},
  error: () => {},
} as unknown as Parameters<typeof applyAppGrantsSchema>[1];

const SOURCE_REF = 'cron-def-ledger';
const RUN_SESSION = 'run-session-ledger';
const AUTOMATION_ID = 'cron:ledger';
const T0 = 1_700_000_000_000;
const EXPIRY = T0 + 10_000;

function createAutomationSchema(db: BetterSqlite3.Database): void {
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

function insertAutomation(db: BetterSqlite3.Database, config: object = {}, status = 'active'): void {
  db.prepare(`
    INSERT INTO session_automations
      (id, source_session_id, type, status, title, source_ref_id, config_json, created_at, updated_at)
    VALUES (?, 'src-session', 'cron', ?, '每周汇总', ?, ?, 1, 1)
  `).run(AUTOMATION_ID, status, SOURCE_REF, JSON.stringify(config));
}

function mintAllKinds(): void {
  mintAppGrantStanding({ name: 'Notes', bundleId: 'com.apple.Notes' }, T0);
  mintAppGrantSession('conv-1', { name: 'Safari' }, T0);
}

describe('统一授权台账', () => {
  let db: Database.Database;
  let svc: SessionAutomationService;

  beforeEach(() => {
    db = new Database(':memory:');
    state.db = db;
    applyAppGrantsSchema(db, logger);
    createAutomationSchema(db);
    state.sessions.clear();
    state.sessions.set(RUN_SESSION, { origin: { id: SOURCE_REF } });
    bindAppGrantDatabase(db, true);
    resetConfirmationGate();
    svc = new SessionAutomationService();
  });

  afterEach(() => {
    db.close();
    state.db = null;
    resetConfirmationGate();
  });

  it('① 一个台账列全三种存档的归一条目，id 稳定可解析', () => {
    insertAutomation(db);
    mintAllKinds();
    expect(svc.mintStandingGrant(RUN_SESSION, 'mail_send', 'team@example.com', T0)).toBe(true);
    getConfirmationGate().recordApproval('conv-2', 'bash', T0);

    const entries = listGrants(T0 + 1_000);
    expect(entries.map((entry) => entry.kind).sort()).toEqual(['app', 'app', 'tool-session', 'tool-target']);

    const standing = entries.find((entry) => entry.id.startsWith('app-standing:'));
    expect(standing).toMatchObject({
      kind: 'app',
      label: 'Notes',
      detail: 'com.apple.Notes',
      source: 'settings',
      grantedAt: T0,
      expiresAt: null,
    });

    const session = entries.find((entry) => entry.id.startsWith('app-session:'));
    expect(session).toMatchObject({
      kind: 'app',
      label: 'Safari',
      source: 'conversation',
      grantedAt: T0,
      expiresAt: null,
    });

    const target = entries.find((entry) => entry.id.startsWith('standing-grant:'));
    expect(target).toMatchObject({
      kind: 'tool-target',
      label: 'mail_send',
      detail: 'team@example.com',
      source: '每周汇总',
      grantedAt: T0,
      expiresAt: null,
    });

    const toolSession = entries.find((entry) => entry.id.startsWith('tool-session:'));
    expect(toolSession).toMatchObject({
      kind: 'tool-session',
      label: 'bash',
      source: 'conversation',
      grantedAt: T0,
      expiresAt: null,
    });

    // id 可解析回存储键：撤销键与存储键一一对应（appKey 自带冒号也要能往返）。
    expect(standing?.id).toBe(`app-standing:${encodeURIComponent('bundle:com.apple.Notes')}`);
    expect(session?.id).toBe(`app-session:${encodeURIComponent('conv-1')}:${encodeURIComponent('name:safari')}`);
    expect(target?.id).toBe(`standing-grant:${encodeURIComponent(AUTOMATION_ID)}:${encodeURIComponent('mail_send')}:${encodeURIComponent('team@example.com')}`);
    expect(toolSession?.id).toBe(`tool-session:${encodeURIComponent('conv-2')}:${encodeURIComponent('bash')}`);
  });

  it('② 撤销常驻 app 授权后，下一次检查按从未授权处理', () => {
    mintAllKinds();
    expect(matchAppGrant('later', { name: 'Notes', bundleId: 'com.apple.Notes' }, T0 + 1)).toBe(true);
    expect(revokeGrant(`app-standing:${encodeURIComponent('bundle:com.apple.Notes')}`)).toBe(true);
    expect(matchAppGrant('later', { name: 'Notes', bundleId: 'com.apple.Notes' }, T0 + 2)).toBe(false);
    expect(listGrants(T0 + 2).some((entry) => entry.id.startsWith('app-standing:'))).toBe(false);
  });

  it('② 撤销会话内 app 授权后，该会话下一次检查按从未授权处理', () => {
    mintAllKinds();
    expect(matchAppGrant('conv-1', { name: 'Safari' }, T0 + 1)).toBe(true);
    expect(revokeGrant(`app-session:${encodeURIComponent('conv-1')}:${encodeURIComponent('name:safari')}`)).toBe(true);
    expect(matchAppGrant('conv-1', { name: 'Safari' }, T0 + 2)).toBe(false);
  });

  it('② 撤销 automation 长期授权后，下一次检查按从未授权处理', () => {
    insertAutomation(db);
    expect(svc.mintStandingGrant(RUN_SESSION, 'mail_send', 'team@example.com', T0)).toBe(true);
    expect(svc.matchStandingGrant(RUN_SESSION, 'mail_send', 'team@example.com')).toBe(true);
    expect(revokeGrant(`standing-grant:${encodeURIComponent(AUTOMATION_ID)}:${encodeURIComponent('mail_send')}:${encodeURIComponent('team@example.com')}`)).toBe(true);
    expect(svc.matchStandingGrant(RUN_SESSION, 'mail_send', 'team@example.com')).toBe(false);
    expect(listGrants(Date.now()).some((entry) => entry.id.startsWith('standing-grant:'))).toBe(false);
  });

  it('② 撤销会话内工具放行后，下一次同类操作重新询问', () => {
    getConfirmationGate().recordApproval('conv-2', 'bash', T0);
    const gate = getConfirmationGate();
    gate.updateConfig({ policy: 'session_approve' });
    expect(gate.shouldConfirm({ toolName: 'bash', params: {}, riskLevel: 'medium' }, 'conv-2')).toBe(false);
    expect(revokeGrant(`tool-session:${encodeURIComponent('conv-2')}:${encodeURIComponent('bash')}`)).toBe(true);
    expect(gate.shouldConfirm({ toolName: 'bash', params: {}, riskLevel: 'medium' }, 'conv-2')).toBe(true);
    gate.updateConfig({ policy: 'ask_if_dangerous' });
  });

  it('③ 过期条目（注入时钟）不列出也不匹配——app 常驻与 automation 长期授权同判', () => {
    mintAppGrantStanding({ name: 'Notes' }, T0, EXPIRY);
    insertAutomation(db, {
      standingGrants: [{ tool: 'mail_send', target: 'x@example.com', grantedAt: T0, expiresAt: EXPIRY }],
    }, 'running');

    // 未到期：列出且匹配。
    expect(listGrants(T0 + 5_000).map((entry) => entry.label)).toEqual(['Notes', 'mail_send']);
    expect(matchAppGrant('any', { name: 'Notes' }, T0 + 5_000)).toBe(true);
    expect(svc.matchStandingGrant(RUN_SESSION, 'mail_send', 'x@example.com', T0 + 5_000)).toBe(true);

    // 到期时刻及之后：不列出、不匹配（下一次同类操作回到询问）。
    expect(listGrants(EXPIRY)).toEqual([]);
    expect(matchAppGrant('any', { name: 'Notes' }, EXPIRY)).toBe(false);
    expect(svc.matchStandingGrant(RUN_SESSION, 'mail_send', 'x@example.com', EXPIRY)).toBe(false);
  });

  it('⑤ 没有任何 agent 可调用工具暴露授权台账的 list/revoke', async () => {
    const { getProtocolRegistry } = await import('../../../src/host/tools/protocolRegistry');
    const schemas = getProtocolRegistry().getSchemas();
    const forbidden = ['listPermissionGrants', 'revokePermissionGrant', 'listGrants', 'revokeGrant', 'listAppGrants', 'revokeAppGrant'];
    expect(schemas.filter((schema) => forbidden.includes(schema.name))).toEqual([]);
    expect(schemas.filter((schema) => forbidden.some((name) => JSON.stringify(schema).includes(name))).map((schema) => schema.name)).toEqual([]);
  });
});
