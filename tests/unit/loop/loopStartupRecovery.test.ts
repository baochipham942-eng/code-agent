import { beforeEach, describe, expect, it, vi } from 'vitest';
import { spawnSync } from 'node:child_process';

vi.unmock('better-sqlite3');
import Database from 'better-sqlite3';

const automationState = vi.hoisted(() => ({
  record: null as
    | { id: string; sourceSessionId: string | null; type: string; status: string; title: string }
    | null,
  recordEvent: vi.fn(),
}));

vi.mock('../../../src/host/services/sessionAutomation', () => ({
  getSessionAutomationService: () => ({
    getById: () => automationState.record,
    recordEvent: automationState.recordEvent,
  }),
}));

vi.mock('../../../src/host/services/core/databaseService', () => ({
  getDatabase: () => ({ getDb: () => null }),
}));

vi.mock('../../../src/host/services/infra/logger', () => ({
  createLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

import { markInterruptedLoops } from '../../../src/host/loop/loopStartupRecovery';
import { captureLoopOwnerStamp } from '../../../src/host/loop/loopOwnership';
import type { SessionAutomationOwnerIdentity } from '../../../src/shared/contract/sessionAutomation';
import {
  createBackgroundTaskLedger,
  getBackgroundTaskLedger,
  resetBackgroundTaskLedgerForTest,
} from '../../../src/host/task/backgroundTaskLedger';
import { SqliteBackgroundTaskStore } from '../../../src/host/task/backgroundTaskStore';

interface GhostLoopInput {
  id: string;
  sessionId: string;
  title: string;
  sourceRefId?: string;
  status?: string;
  /** 归属戳（写进 config_json.ownerProcess）；缺省 = 无戳（旧版本残留行）。 */
  owner?: { pid: number; processIdentity?: SessionAutomationOwnerIdentity; stampedAt?: number };
  /** 直接写坏的 config_json（优先于 owner）。 */
  configJson?: string;
}

function createGhostDb(): Database.Database {
  const db = new Database(':memory:');
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
      config_json TEXT DEFAULT '{}',
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )
  `);
  return db;
}

/** 真死的 pid：spawnSync 等待退出并收尸，返回的 pid 已确认不存在。 */
function deadOwnerPid(): number {
  const child = spawnSync(process.execPath, ['-e', ''], { timeout: 10_000 });
  if (!child.pid) throw new Error('failed to spawn a short-lived child for a dead pid');
  return child.pid;
}

function insertAutomation(db: Database.Database, input: GhostLoopInput): void {
  const configJson = input.configJson ?? (input.owner
    ? JSON.stringify({
      ownerProcess: {
        pid: input.owner.pid,
        ...(input.owner.processIdentity !== undefined ? { processIdentity: input.owner.processIdentity } : {}),
        stampedAt: input.owner.stampedAt ?? 1_000,
      },
    })
    : null);
  db.prepare(`
    INSERT INTO session_automations
      (id, source_session_id, type, status, title, source_ref_id, config_json, created_at, updated_at)
    VALUES (?, ?, 'loop', ?, ?, ?, ?, ?, ?)
  `).run(
    input.id,
    input.sessionId,
    input.status ?? 'running',
    input.title,
    input.sourceRefId ?? null,
    configJson,
    1_000,
    1_000,
  );
}

function automationStatus(db: Database.Database, id: string): string | undefined {
  const row = db.prepare('SELECT status FROM session_automations WHERE id = ?').get(id) as
    | { status: string }
    | undefined;
  return row?.status;
}

describe('markInterruptedLoops（N-LOOP-DURABLE 刀1：启动时把残留 running loop 说出来）', () => {
  beforeEach(() => {
    resetBackgroundTaskLedgerForTest();
    automationState.record = null;
    automationState.recordEvent.mockReset();
    automationState.recordEvent.mockResolvedValue({ id: 'loop:loop_abc' });
  });

  it('把归属进程已消失的 running loop 收成 failed，台账标 orphaned，并留下跨重启可取的人话通知', async () => {
    const db = createGhostDb();
    insertAutomation(db, {
      id: 'loop:loop_abc',
      sessionId: 'session-1',
      title: '循环 · 盯构建',
      sourceRefId: 'loop_abc',
      owner: { pid: deadOwnerPid() },
    });
    // 已终态的历史 loop 不许被扫到。
    insertAutomation(db, {
      id: 'loop:loop_old',
      sessionId: 'session-1',
      title: '循环 · 已完成',
      status: 'completed',
    });

    const marked = await markInterruptedLoops(db);

    expect(marked).toBe(1);
    expect(automationStatus(db, 'loop:loop_abc')).toBe('failed');
    expect(automationStatus(db, 'loop:loop_old')).toBe('completed');

    const task = getBackgroundTaskLedger().getTask('loop_abc');
    expect(task?.status).toBe('orphaned');
    expect(task?.kind).toBe('loop');
    expect(task?.sessionId).toBe('session-1');

    // 模拟「进程再起」：全新 ledger + store 挂同一个库，通知仍能 drain 出来
    // （这才证明通知真的落了库，而不是只活在上一进程内存里）。
    const revived = createBackgroundTaskLedger();
    revived.setStore(new SqliteBackgroundTaskStore(db));
    const drained = revived.drainNotifications('session-1');
    expect(drained).toHaveLength(1);
    expect(drained[0]).toMatchObject({
      id: 'loop_abc:lost',
      taskId: 'loop_abc',
      sessionId: 'session-1',
      type: 'task_failed',
      title: '循环 · 盯构建',
    });
    expect(drained[0].message).toContain('应用关闭时中断');
    // 轮次不落库，取不到就不编：通知里不许出现「第 N 轮」。
    expect(drained[0].message).not.toMatch(/第 \d+ 轮/);
  });

  it('幂等：同一批残留重复扫，第二次不重复收口、不重复发通知', async () => {
    const db = createGhostDb();
    insertAutomation(db, {
      id: 'loop:loop_abc',
      sessionId: 'session-1',
      title: '循环 · 盯构建',
      sourceRefId: 'loop_abc',
      owner: { pid: deadOwnerPid() },
    });

    expect(await markInterruptedLoops(db)).toBe(1);
    expect(await markInterruptedLoops(db)).toBe(0);

    const revived = createBackgroundTaskLedger();
    revived.setStore(new SqliteBackgroundTaskStore(db));
    expect(revived.drainNotifications('session-1')).toHaveLength(1);
  });

  it('桌面路径：automation 记录可查时经 recordEvent 收口并回写源会话消息', async () => {
    automationState.record = {
      id: 'loop:loop_abc',
      sourceSessionId: 'session-1',
      type: 'loop',
      status: 'running',
      title: '循环 · 盯构建',
    };
    const db = createGhostDb();
    insertAutomation(db, {
      id: 'loop:loop_abc',
      sessionId: 'session-1',
      title: '循环 · 盯构建',
      sourceRefId: 'loop_abc',
      owner: { pid: deadOwnerPid() },
    });

    const marked = await markInterruptedLoops(db);

    expect(marked).toBe(1);
    expect(automationState.recordEvent).toHaveBeenCalledTimes(1);
    expect(automationState.recordEvent).toHaveBeenCalledWith(expect.objectContaining({
      automationId: 'loop:loop_abc',
      event: 'failed',
      status: 'failed',
      recordStatus: 'failed',
      summary: '应用关闭时中断，未能继续',
    }));
  });

  it('库不可用或没有 session_automations 表时静默跳过，不算错误', async () => {
    expect(await markInterruptedLoops(null)).toBe(0);
    expect(await markInterruptedLoops()).toBe(0);

    const emptyDb = new Database(':memory:');
    expect(await markInterruptedLoops(emptyDb)).toBe(0);
  });

  // -------------------------------------------------------------------------
  // 修复棒 Important 1：归属判活——误杀 = 当着用户面把还在跑的 loop 谎报成失败
  // -------------------------------------------------------------------------

  it('归属进程还活着（如桌面正在跑）时：不收口、不发通知，行保持 running', async () => {
    const db = createGhostDb();
    // 本测试进程就是「还活着的归属进程」——CLI 入口看到的就是这种行。
    const liveOwner = captureLoopOwnerStamp();
    insertAutomation(db, {
      id: 'loop:loop_live',
      sessionId: 'session-1',
      title: '循环 · 桌面在跑',
      sourceRefId: 'loop_live',
      owner: { pid: liveOwner.pid, ...(liveOwner.processIdentity !== undefined ? { processIdentity: liveOwner.processIdentity } : {}) },
    });

    const marked = await markInterruptedLoops(db);

    expect(marked).toBe(0);
    expect(automationStatus(db, 'loop:loop_live')).toBe('running');

    const revived = createBackgroundTaskLedger();
    revived.setStore(new SqliteBackgroundTaskStore(db));
    expect(revived.drainNotifications('session-1')).toHaveLength(0);
  });

  it('无归属戳（旧版本残留行）判不出归属：保持原样不动（宁可漏收，不可误杀）', async () => {
    const db = createGhostDb();
    insertAutomation(db, {
      id: 'loop:loop_legacy',
      sessionId: 'session-1',
      title: '循环 · 无戳',
      sourceRefId: 'loop_legacy',
    });

    expect(await markInterruptedLoops(db)).toBe(0);
    expect(automationStatus(db, 'loop:loop_legacy')).toBe('running');
  });

  it('归属戳不合法（pid 非整数/坏 JSON）同样判不出归属：不动手', async () => {
    const db = createGhostDb();
    insertAutomation(db, {
      id: 'loop:loop_bad1',
      sessionId: 'session-1',
      title: '循环 · 坏戳',
      configJson: '{"ownerProcess":{"pid":"not-a-number"}}',
    });
    insertAutomation(db, {
      id: 'loop:loop_bad2',
      sessionId: 'session-1',
      title: '循环 · 坏 JSON',
      configJson: '{not json',
    });

    expect(await markInterruptedLoops(db)).toBe(0);
    expect(automationStatus(db, 'loop:loop_bad1')).toBe('running');
    expect(automationStatus(db, 'loop:loop_bad2')).toBe('running');
  });

  // -------------------------------------------------------------------------
  // 修复棒 Important 2：三处写入同事务——写失败整体回滚、不计成功、下次启动重试
  // -------------------------------------------------------------------------

  it('台账终态写入抛错 → 整体回滚：行保持 running、返回 0；下次启动重试能补齐', async () => {
    const db = createGhostDb();
    insertAutomation(db, {
      id: 'loop:loop_abc',
      sessionId: 'session-1',
      title: '循环 · 盯构建',
      sourceRefId: 'loop_abc',
      owner: { pid: deadOwnerPid() },
    });

    const upsertSpy = vi
      .spyOn(SqliteBackgroundTaskStore.prototype, 'upsertTask')
      .mockImplementation(() => {
        throw new Error('ledger terminal write exploded');
      });

    // 修复前（三写各自独立提交）：状态已改 failed、函数报成功 1、通知永久丢失。
    const failedMarked = await markInterruptedLoops(db);
    expect(failedMarked).toBe(0);
    expect(automationStatus(db, 'loop:loop_abc')).toBe('running');

    upsertSpy.mockRestore();
    resetBackgroundTaskLedgerForTest();

    // 行还在 running → 下次启动重扫，健康路径补齐全部三处写入。
    expect(await markInterruptedLoops(db)).toBe(1);
    expect(automationStatus(db, 'loop:loop_abc')).toBe('failed');

    const revived = createBackgroundTaskLedger();
    revived.setStore(new SqliteBackgroundTaskStore(db));
    const drained = revived.drainNotifications('session-1');
    expect(drained).toHaveLength(1);
    expect(drained[0]).toMatchObject({ id: 'loop_abc:lost', type: 'task_failed' });
  });

  // -------------------------------------------------------------------------
  // 第三棒 Important 1：并发入口重复收口——running 筛选在事务外，UPDATE 只按
  // id 匹配挡不住第二方；已投递通知的 delivered_at 会被 INSERT OR REPLACE 重置。
  // -------------------------------------------------------------------------

  /** 第二入口的 db 代理：SELECT 残留行返回过期快照（读发生在第一方收口前），其余语句照常透传真库。 */
  function staleSnapshotDb(db: Database.Database, staleRows: unknown[]): Database.Database {
    return new Proxy(db, {
      get(target, prop) {
        if (prop === 'prepare') {
          return (sql: string) => {
            if (sql.includes('FROM session_automations')) {
              return { all: () => staleRows } as unknown as ReturnType<Database.Database['prepare']>;
            }
            return target.prepare(sql);
          };
        }
        const value = Reflect.get(target, prop, target);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    }) as Database.Database;
  }

  it('并发入口收口同一条记录：第二方 changes=0 直接退出，已投递通知不被重置、不重复投递', async () => {
    const db = createGhostDb();
    const configJson = JSON.stringify({ ownerProcess: { pid: deadOwnerPid(), stampedAt: 1_000 } });
    insertAutomation(db, {
      id: 'loop:loop_abc',
      sessionId: 'session-1',
      title: '循环 · 盯构建',
      sourceRefId: 'loop_abc',
      configJson,
    });

    // 第一方（桌面）先行完成收口，通知落库。
    expect(await markInterruptedLoops(db)).toBe(1);

    // 用户已经看到这条通知（delivered_at 已落库，不该再被投递一次）。
    db.prepare(`
      UPDATE background_task_notifications SET delivered_at = 12345 WHERE id = 'loop_abc:lost'
    `).run();
    const updatedAtByFirstParty = (db.prepare(`
      SELECT updated_at FROM session_automations WHERE id = 'loop:loop_abc'
    `).get() as { updated_at: number }).updated_at;

    // 第二方（CLI）的 SELECT 发生在第一方收口之前 → 持有 running+带戳 的过期快照；
    // 它是另一个进程，ledger 单例也是全新的。
    resetBackgroundTaskLedgerForTest();
    const secondEntry = staleSnapshotDb(db, [{
      id: 'loop:loop_abc',
      source_session_id: 'session-1',
      title: '循环 · 盯构建',
      source_ref_id: 'loop_abc',
      config_json: configJson,
      created_at: 1_000,
      last_run_at: null,
    }]);
    expect(await markInterruptedLoops(secondEntry)).toBe(0);

    // 修复前：第二方照样写入（返回 1），INSERT OR REPLACE 把 delivered_at 重置回 NULL。
    const notificationRow = db.prepare(`
      SELECT delivered_at FROM background_task_notifications WHERE id = 'loop_abc:lost'
    `).get() as { delivered_at: number | null };
    expect(notificationRow.delivered_at).toBe(12345);

    // automation 行也没被第二方再碰（updated_at 不变）。
    expect((db.prepare(`
      SELECT updated_at FROM session_automations WHERE id = 'loop:loop_abc'
    `).get() as { updated_at: number }).updated_at).toBe(updatedAtByFirstParty);

    // 新进程视角不会重复投递这条已送达通知。
    const revived = createBackgroundTaskLedger();
    revived.setStore(new SqliteBackgroundTaskStore(db));
    expect(revived.drainNotifications('session-1')).toHaveLength(0);
  });

  it('并发入口的过期快照遇行被新归属重新盖戳：同样 changes=0 退出，不误杀新归属的 loop', async () => {
    const db = createGhostDb();
    const staleConfigJson = JSON.stringify({ ownerProcess: { pid: deadOwnerPid(), stampedAt: 1_000 } });
    insertAutomation(db, {
      id: 'loop:loop_reborn',
      sessionId: 'session-1',
      title: '循环 · 已被新进程接管',
      sourceRefId: 'loop_reborn',
      configJson: staleConfigJson,
    });

    // 行没被收口，而是被一个新归属进程重新盖戳继续跑（当前 config_json ≠ 过期快照）。
    const liveOwner = captureLoopOwnerStamp();
    db.prepare(`
      UPDATE session_automations
      SET config_json = ?
      WHERE id = 'loop:loop_reborn'
    `).run(JSON.stringify({
      ownerProcess: {
        pid: liveOwner.pid,
        ...(liveOwner.processIdentity !== undefined ? { processIdentity: liveOwner.processIdentity } : {}),
        stampedAt: 2_000,
      },
    }));

    const secondEntry = staleSnapshotDb(db, [{
      id: 'loop:loop_reborn',
      source_session_id: 'session-1',
      title: '循环 · 已被新进程接管',
      source_ref_id: 'loop_reborn',
      config_json: staleConfigJson,
      created_at: 1_000,
      last_run_at: null,
    }]);
    expect(await markInterruptedLoops(secondEntry)).toBe(0);
    expect(automationStatus(db, 'loop:loop_reborn')).toBe('running');

    const revived = createBackgroundTaskLedger();
    revived.setStore(new SqliteBackgroundTaskStore(db));
    expect(revived.drainNotifications('session-1')).toHaveLength(0);
  });

  // -------------------------------------------------------------------------
  // 第三棒 Important 2：通知写入失败后内存缓存没回滚——同进程重试命中缓存
  // 跳过入库，却把 failed 终态提交掉，通知永久丢失。
  // -------------------------------------------------------------------------

  it('通知存储抛错 → 回滚并撤缓存：同进程重试（不重置 ledger 单例）把通知真的落库', async () => {
    const db = createGhostDb();
    insertAutomation(db, {
      id: 'loop:loop_abc',
      sessionId: 'session-1',
      title: '循环 · 盯构建',
      sourceRefId: 'loop_abc',
      owner: { pid: deadOwnerPid() },
    });

    // 第一拍：通知存储写入炸（瞬态故障）。整体回滚，行保持 running。
    const queueSpy = vi
      .spyOn(SqliteBackgroundTaskStore.prototype, 'queueNotification')
      .mockImplementationOnce(() => {
        throw new Error('notification store exploded');
      });
    expect(await markInterruptedLoops(db)).toBe(0);
    expect(automationStatus(db, 'loop:loop_abc')).toBe('running');
    queueSpy.mockRestore();

    // 第二拍：同一进程再触发（桌面启动恢复后，dev 路由 initializeCLIServices
    // 再入 markInterruptedLoops）——不重置 ledger 单例，缓存必须已被回滚撤掉，
    // 重试才会真的再走一遍入库。修复前：这里命中缓存跳过入库，行变 failed
    // 而通知从未落库，重启后行不再是 running，通知永久丢失。
    expect(await markInterruptedLoops(db)).toBe(1);
    expect(automationStatus(db, 'loop:loop_abc')).toBe('failed');

    const stored = db.prepare(`
      SELECT delivered_at FROM background_task_notifications WHERE id = 'loop_abc:lost'
    `).get() as { delivered_at: number | null } | undefined;
    expect(stored).toBeDefined();
    expect(stored?.delivered_at).toBeNull();

    // 新进程视角能 drain 到这条通知。
    const revived = createBackgroundTaskLedger();
    revived.setStore(new SqliteBackgroundTaskStore(db));
    expect(revived.drainNotifications('session-1')).toHaveLength(1);
  });
});
