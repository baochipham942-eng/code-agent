import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.unmock('better-sqlite3');
import Database from 'better-sqlite3';
import type BetterSqlite3 from 'better-sqlite3';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { applySchema } from '../../../src/host/services/core/database/schema';
import {
  CLOUD_RUN_STATES,
  CloudRunAccountRequiredError,
  canTransitionCloudRunState,
  isTerminalCloudRunState,
} from '../../../src/shared/contract/cloudRun';
import { createCloudRunLedger } from '../../../src/host/services/cloudRun/cloudRunLedger';
import type {
  CloudRunRecord,
  CloudRunTransitionRecord,
} from '../../../src/host/services/core/repositories/CloudRunRepository';
import { getAuthService } from '../../../src/host/services/auth/authService';
import type { AuthUser } from '../../../src/shared/contract';

const logger = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
} as unknown as Parameters<typeof applySchema>[1];

// 验收口径里的两组状态（与合同常量分开写死：测试要独立于实现断言词汇）
const TERMINAL_STATES = ['succeeded', 'failed', 'cancelled', 'timed_out', 'interrupted', 'abandoned'] as const;
const IN_FLIGHT_STATES = ['running', 'waiting-approval', 'waiting-reconnect'] as const;

const VERIFIED_ACCOUNT = 'acct_verified';

function cachedUser(id: string): AuthUser {
  return { id, email: `${id}@example.com` } as AuthUser;
}

function openDb(file: string): BetterSqlite3.Database {
  const db = new Database(file);
  applySchema(db, logger);
  return db;
}

function rawRunRow(db: BetterSqlite3.Database, runId: string): Record<string, unknown> {
  return db.prepare('SELECT * FROM cloud_runs WHERE run_id = ?').get(runId) as Record<string, unknown>;
}

function runCount(db: BetterSqlite3.Database): number {
  return Number((db.prepare('SELECT COUNT(*) AS total FROM cloud_runs').get() as { total: number }).total);
}

function transitionCount(db: BetterSqlite3.Database): number {
  return Number(
    (db.prepare('SELECT COUNT(*) AS total FROM cloud_run_transitions').get() as { total: number }).total,
  );
}

describe('CloudRunLedger (ADR-086 S1)', () => {
  let db: BetterSqlite3.Database;
  let tick: number;

  beforeEach(() => {
    db = openDb(':memory:');
    tick = 1_700_000_000_000;
  });

  afterEach(() => {
    db.close();
    vi.restoreAllMocks();
  });

  const clock = () => tick;
  const verifiedAccount = () => VERIFIED_ACCOUNT;

  describe('账户拥有 run（验收 ① ②）', () => {
    it('默认解析器 + 无登录用户：CLOUD_RUN_ACCOUNT_REQUIRED，cloud_runs 零行', () => {
      const getCurrentUser = vi.spyOn(getAuthService(), 'getCurrentUser').mockReturnValue(null);
      vi.spyOn(getAuthService(), 'hasVerifiedSession').mockReturnValue(false);
      const ledger = createCloudRunLedger({ db, clock });

      let thrown: unknown;
      try {
        ledger.createRun({ sessionId: 'sess_a', trigger: 'manual' });
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeInstanceOf(CloudRunAccountRequiredError);
      expect((thrown as CloudRunAccountRequiredError).code).toBe('CLOUD_RUN_ACCOUNT_REQUIRED');
      expect(runCount(db)).toBe(0);

      // 用户已缓存但会话未验证：默认解析器只读 getCurrentUser/hasVerifiedSession 这两个口
      getCurrentUser.mockReturnValue(cachedUser('acct_cached'));
      thrown = undefined;
      try {
        ledger.createRun({ sessionId: 'sess_a', trigger: 'manual' });
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeInstanceOf(CloudRunAccountRequiredError);
      expect((thrown as CloudRunAccountRequiredError).code).toBe('CLOUD_RUN_ACCOUNT_REQUIRED');
      expect(runCount(db)).toBe(0);

      // 注入解析器返回 null 的同形状兜底
      const injected = createCloudRunLedger({ db, clock, accountResolver: () => null });
      expect(() => injected.createRun({ sessionId: 'sess_a', trigger: 'manual' })).toThrowError(
        CloudRunAccountRequiredError,
      );
      expect(runCount(db)).toBe(0);
    });

    it('已验证账户拥有行；初始行带齐保留期钩子列', () => {
      vi.spyOn(getAuthService(), 'getCurrentUser').mockReturnValue(cachedUser(VERIFIED_ACCOUNT));
      vi.spyOn(getAuthService(), 'hasVerifiedSession').mockReturnValue(true);
      const ledger = createCloudRunLedger({ db, clock });

      const run = ledger.createRun({ sessionId: 'sess_own', trigger: 'cron' });
      const row = rawRunRow(db, run.runId);
      expect(row.account_id).toBe(VERIFIED_ACCOUNT);
      expect(row.session_id).toBe('sess_own');
      expect(row.trigger).toBe('cron');
      expect(row.state).toBe('queued');
      expect(row.workspace_status).toBe('active');
      expect(row.retention_notice_at).toBeNull();
      expect(row.export_available).toBeNull();
      expect(row.created_at).toBe(tick);
      expect(row.updated_at).toBe(tick);
      expect(String(row.workspace_id)).toMatch(/^ws_/);
      expect(String(row.workspace_id)).not.toContain('sess_own'); // workspaceId 不从 sessionId 推导
    });

    it('请求体形状的多余用户字段成不了 account_id（验收 ②）', () => {
      const ledger = createCloudRunLedger({ db, clock, accountResolver: verifiedAccount });

      const run = ledger.createRun({
        sessionId: 'sess_b',
        trigger: 'manual',
        userId: 'evil',
        accountId: 'evil',
      } as never);
      const row = rawRunRow(db, run.runId);
      expect(row.account_id).toBe(VERIFIED_ACCOUNT);
      expect(JSON.stringify(row)).not.toContain('evil');
    });
  });

  describe('终态闭合与停车（验收 ③）', () => {
    it('终态行拒绝一切在飞/queued/终态目标：报错、行不变、无多余迁移记录', () => {
      for (const terminal of TERMINAL_STATES) {
        const loopDb = openDb(':memory:');
        try {
          const ledger = createCloudRunLedger({ db: loopDb, clock, accountResolver: verifiedAccount });
          const run = ledger.createRun({ sessionId: `sess_${terminal}`, trigger: 'manual' });
          ledger.transition(run.runId, 'running');
          ledger.transition(run.runId, terminal);

          const before = rawRunRow(loopDb, run.runId);
          const transitionsBefore = transitionCount(loopDb);
          for (const target of [...IN_FLIGHT_STATES, 'queued', ...TERMINAL_STATES]) {
            expect(() => ledger.transition(run.runId, target as CloudRunRecord['state'])).toThrow(/terminal/);
          }
          expect(rawRunRow(loopDb, run.runId)).toEqual(before);
          expect(transitionCount(loopDb)).toBe(transitionsBefore);
        } finally {
          loopDb.close();
        }
      }
    });

    it('waiting-approval 不是终态，可回 running；直跳 succeeded 被拒', () => {
      const ledger = createCloudRunLedger({ db, clock, accountResolver: verifiedAccount });
      const run = ledger.createRun({ sessionId: 'sess_park', trigger: 'manual' });
      ledger.transition(run.runId, 'running');

      expect(isTerminalCloudRunState('waiting-approval')).toBe(false);
      expect(canTransitionCloudRunState('waiting-approval', 'running')).toBe(true);
      const parked = ledger.transition(run.runId, 'waiting-approval');
      expect(parked.state).toBe('waiting-approval');
      expect(ledger.transition(run.runId, 'running').state).toBe('running');

      // queued 不能直跳 succeeded（没执行过就不是成功）
      const other = ledger.createRun({ sessionId: 'sess_skip', trigger: 'manual' });
      expect(() => ledger.transition(other.runId, 'succeeded')).toThrow(/illegal transition queued -> succeeded/);
      // 同态自跳也拒（无自环）
      expect(() => ledger.transition(run.runId, 'running')).toThrow(/illegal transition running -> running/);

      ledger.transition(run.runId, 'succeeded');
      expect(isTerminalCloudRunState('succeeded')).toBe(true);
      expect(() => ledger.transition(run.runId, 'running')).toThrow(/terminal/);
    });

    it('合同：状态集含 queued 共 10 个；每个终态出边为空', () => {
      expect(CLOUD_RUN_STATES).toHaveLength(10);
      expect(CLOUD_RUN_STATES).toContain('queued');
      for (const terminal of TERMINAL_STATES) {
        const targets: readonly CloudRunRecord['state'][] = [...IN_FLIGHT_STATES, 'queued', ...TERMINAL_STATES];
        for (const target of targets) {
          expect(canTransitionCloudRunState(terminal, target)).toBe(false);
        }
      }
    });
  });

  describe('迁移记录与监听器（验收 ④）', () => {
    it('每条迁移都落 cloud_run_transitions；监听器收到终态进入与停车进出；抛错监听器不回滚', () => {
      const ledger = createCloudRunLedger({ db, clock, accountResolver: verifiedAccount });
      const received: CloudRunTransitionRecord[] = [];
      ledger.onTransition((transition) => received.push(transition));
      const throwing = vi.fn(() => {
        throw new Error('listener boom');
      });
      ledger.onTransition(throwing);

      const run = ledger.createRun({ sessionId: 'sess_evt', trigger: 'channel' });
      ledger.transition(run.runId, 'running');
      ledger.transition(run.runId, 'waiting-approval'); // 停车进入
      ledger.transition(run.runId, 'running'); // 停车离开
      ledger.transition(run.runId, 'succeeded'); // 终态进入

      const rows = ledger.listTransitions(0);
      expect(rows).toHaveLength(4);
      expect(rows.map((row) => [row.fromState, row.toState])).toEqual([
        ['queued', 'running'],
        ['running', 'waiting-approval'],
        ['waiting-approval', 'running'],
        ['running', 'succeeded'],
      ]);
      expect(rows.every((row) => row.runId === run.runId)).toBe(true);
      const seqs = rows.map((row) => row.seq);
      expect(seqs).toEqual([...seqs].sort((left, right) => left - right));

      expect(received.map((transition) => transition.toState)).toEqual([
        'running',
        'waiting-approval',
        'running',
        'succeeded',
      ]);
      expect(throwing).toHaveBeenCalledTimes(4);
      // 抛错监听器既没回滚迁移，也没挡住正常监听器
      expect(ledger.getRun(run.runId)?.state).toBe('succeeded');
      expect(received).toHaveLength(4);

      // afterSeq 增量读口：重启后从断点续读
      const catchUp = ledger.listTransitions(rows[2].seq);
      expect(catchUp.map((row) => row.toState)).toEqual(['succeeded']);

      // 退订函数生效
      const run2 = ledger.createRun({ sessionId: 'sess_evt2', trigger: 'manual' });
      const later = vi.fn();
      ledger.onTransition(later)();
      ledger.transition(run2.runId, 'running');
      expect(later).not.toHaveBeenCalled();
      expect(received).toHaveLength(5);
    });
  });

  describe('重启持久与不可变标识（验收 ⑤）', () => {
    it('close/reopen 后同一 runId 指向同一 workspaceId 与同一状态；身份列 UPDATE 被触发器拒', () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cloud-run-ledger-'));
      const file = path.join(dir, 'ledger.db');
      try {
        const db1 = openDb(file);
        const ledger1 = createCloudRunLedger({ db: db1, clock, accountResolver: verifiedAccount });
        const run = ledger1.createRun({ sessionId: 'sess_restart', trigger: 'cron' });
        ledger1.transition(run.runId, 'running');
        ledger1.transition(run.runId, 'waiting-approval');
        db1.close();

        // 重启 = 重开文件库、重放 schema、新账本实例
        const db2 = openDb(file);
        const ledger2 = createCloudRunLedger({ db: db2, clock, accountResolver: verifiedAccount });
        const reopened = ledger2.getRun(run.runId);
        expect(reopened?.workspaceId).toBe(run.workspaceId);
        expect(reopened?.state).toBe('waiting-approval');
        expect(ledger2.listTransitions(0).map((row) => row.toState)).toEqual(['running', 'waiting-approval']);
        // 停车跨重启后仍可回到 running（ADR-082：等人的是同一 run）
        expect(ledger2.transition(run.runId, 'running').state).toBe('running');

        for (const [column, value] of [
          ['workspace_id', 'ws_evil'],
          ['account_id', 'acct_evil'],
          ['run_id', 'run_evil'],
          ['session_id', 'sess_evil'],
        ] as const) {
          expect(() =>
            db2.prepare(`UPDATE cloud_runs SET ${column} = ? WHERE run_id = ?`).run(value, run.runId),
          ).toThrow(/immutable/);
        }
        // 合法更新（状态机路径）不受触发器影响
        expect(() => ledger2.transition(run.runId, 'failed')).not.toThrow();
        db2.close();
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    });
  });

  describe('schema 守卫', () => {
    it('state / trigger 列只接受合同词汇', () => {
      const ledger = createCloudRunLedger({ db, clock, accountResolver: verifiedAccount });
      const run = ledger.createRun({ sessionId: 'sess_check', trigger: 'delegate' });
      expect(() =>
        db.prepare('UPDATE cloud_runs SET state = ? WHERE run_id = ?').run('bogus', run.runId),
      ).toThrow(/CHECK/);
      expect(() =>
        db.prepare(
          `INSERT INTO cloud_runs (run_id, account_id, session_id, "trigger", state, workspace_id, created_at, updated_at)
           VALUES ('run_bad', 'a', 's', 'telepathy', 'queued', 'ws_x', 1, 1)`,
        ).run(),
      ).toThrow(/CHECK/);
      expect(runCount(db)).toBe(1);
    });
  });
});
