import { describe, expect, it, vi } from 'vitest';

vi.unmock('better-sqlite3');
import Database from 'better-sqlite3';

import { applySchema } from '../../../src/host/services/core/database/schema';
import { PermissionDecisionRepository } from '../../../src/host/services/core/repositories/PermissionDecisionRepository';
import type { DecisionTrace } from '../../../src/shared/contract/decisionTrace';

function createLogger() {
  return { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

function freshDb() {
  const db = new Database(':memory:');
  applySchema(db, createLogger() as never);
  return db;
}

const sampleTrace: DecisionTrace = {
  toolName: 'Bash',
  finalOutcome: 'deny',
  steps: [
    { layer: 'permission_classifier', rule: 'dangerous-bash', result: 'deny', reason: '危险命令', durationMs: 2, timestamp: 1000 },
  ],
  totalDurationMs: 2,
};

describe('PermissionDecisionRepository（事件账本第一期）', () => {
  it('schema 建出 permission_decisions 表与索引', () => {
    const db = freshDb();
    try {
      const cols = db.prepare('PRAGMA table_info(permission_decisions)').all().map((r) => (r as { name: string }).name);
      expect(cols).toEqual(expect.arrayContaining([
        'id', 'session_id', 'tool_name', 'summary', 'final_outcome', 'history_outcome', 'reason', 'duration_ms', 'recorded_at', 'trace_json',
      ]));
      const idx = db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='permission_decisions'").all().map((r) => (r as { name: string }).name);
      expect(idx).toEqual(expect.arrayContaining([
        'idx_permission_decisions_recorded',
        'idx_permission_decisions_session',
        'idx_permission_decisions_tool',
      ]));
    } finally {
      db.close();
    }
  });

  it('append → getRecent 取回，trace round-trip 还原', () => {
    const db = freshDb();
    try {
      const repo = new PermissionDecisionRepository(db);
      repo.append({
        sessionId: 's1', toolName: 'Bash', summary: 'rm -rf /',
        finalOutcome: 'deny', historyOutcome: 'classifier-deny', reason: '危险命令',
        durationMs: 3, recordedAt: 1234, trace: sampleTrace,
      });
      const recent = repo.getRecent();
      expect(recent).toHaveLength(1);
      expect(recent[0]).toMatchObject({
        sessionId: 's1', toolName: 'Bash', summary: 'rm -rf /',
        finalOutcome: 'deny', historyOutcome: 'classifier-deny', reason: '危险命令',
        durationMs: 3, recordedAt: 1234,
      });
      // trace JSON 往返还原
      expect(recent[0].trace).toEqual(sampleTrace);
    } finally {
      db.close();
    }
  });

  it('无 trace / 无 sessionId 时也能落库与读回（字段可空）', () => {
    const db = freshDb();
    try {
      const repo = new PermissionDecisionRepository(db);
      repo.append({
        toolName: 'WebFetch', summary: 'https://x', finalOutcome: 'allow',
        historyOutcome: 'auto-approve', reason: 'safe', durationMs: 1, recordedAt: 10,
      });
      const r = repo.getRecent()[0];
      expect(r.sessionId).toBeNull();
      expect(r.trace).toBeNull();
      expect(r.finalOutcome).toBe('allow');
    } finally {
      db.close();
    }
  });

  it('getBySession 只返回该 session；count 随 append 递增', () => {
    const db = freshDb();
    try {
      const repo = new PermissionDecisionRepository(db);
      repo.append({ sessionId: 'a', toolName: 'Bash', summary: 'x', finalOutcome: 'allow', historyOutcome: 'auto-approve', reason: 'r', durationMs: 1, recordedAt: 1 });
      repo.append({ sessionId: 'b', toolName: 'Bash', summary: 'y', finalOutcome: 'deny', historyOutcome: 'ask-denied', reason: 'r', durationMs: 1, recordedAt: 2 });
      repo.append({ sessionId: 'a', toolName: 'Write', summary: 'z', finalOutcome: 'allow', historyOutcome: 'auto-approve', reason: 'r', durationMs: 1, recordedAt: 3 });
      expect(repo.count()).toBe(3);
      const aOnly = repo.getBySession('a');
      expect(aOnly).toHaveLength(2);
      expect(aOnly.every((d) => d.sessionId === 'a')).toBe(true);
      // 升序（第三期 HIGH-1 修正）：getBySession 服务于一本账投影，按时间正序返回，
      // 最早的 recorded_at=1 在前（与 ToolExecutionEventRepository.getBySession 对齐）。
      expect(aOnly.map((d) => d.recordedAt)).toEqual([1, 3]);
    } finally {
      db.close();
    }
  });

  it('append-only 不变量：仓储不暴露任何 update/delete 方法', () => {
    const db = freshDb();
    try {
      const repo = new PermissionDecisionRepository(db) as unknown as Record<string, unknown>;
      const methods = [
        ...Object.getOwnPropertyNames(Object.getPrototypeOf(repo)),
      ].filter((m) => m !== 'constructor');
      const mutating = methods.filter((m) => /update|delete|remove|clear|set|drop/i.test(m));
      expect(mutating).toEqual([]);
      // 公开方法只应是 append + 查询
      expect(methods.sort()).toEqual(['append', 'count', 'getBySession', 'getRecent']);
    } finally {
      db.close();
    }
  });
});
