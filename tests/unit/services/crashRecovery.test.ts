import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

vi.unmock('better-sqlite3');
import Database from 'better-sqlite3';

import { applySchema } from '../../../src/host/services/core/database/schema';
import { ToolExecutionEventRepository } from '../../../src/host/services/core/repositories/ToolExecutionEventRepository';
import { buildRecoverySnapshot, acknowledgeRecovery } from '../../../src/host/services/core/crashRecovery';

function createLogger() {
  return { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

function memRepo() {
  const db = new Database(':memory:');
  applySchema(db, createLogger() as never);
  return new ToolExecutionEventRepository(db);
}

const tmpDirs: string[] = [];
function freshTmpDbPath() {
  const dir = mkdtempSync(join(tmpdir(), 'ledger-phase2-'));
  tmpDirs.push(dir);
  return join(dir, 'code-agent.db');
}
afterEach(() => {
  while (tmpDirs.length) {
    const d = tmpDirs.pop();
    if (d) rmSync(d, { recursive: true, force: true });
  }
});

describe('CrashRecovery（事件账本第二期 · 崩溃重放）', () => {
  it('未闭合执行 → 快照按 session 分组、参数完整重建', () => {
    const repo = memRepo();
    repo.appendBegin({ executionId: 'e1', sessionId: 's1', toolName: 'Bash', summary: 'npm build', params: { command: 'npm build' }, recordedAt: 1000 });
    repo.appendBegin({ executionId: 'e2', sessionId: 's1', toolName: 'Write', summary: 'a.ts', params: { file_path: 'a.ts', content: 'x' }, recordedAt: 1200 });
    repo.appendBegin({ executionId: 'e3', sessionId: 's2', toolName: 'Edit', summary: 'b.ts', params: { file_path: 'b.ts' }, recordedAt: 1300 });

    const snap = buildRecoverySnapshot(repo, 5000);

    expect(snap.totalInFlight).toBe(3);
    expect(snap.recoveredAt).toBe(5000);
    expect(snap.sessions).toHaveLength(2);

    const s1 = snap.sessions.find((s) => s.sessionId === 's1');
    expect(s1?.operations).toHaveLength(2);
    const op = s1?.operations.find((o) => o.executionId === 'e1');
    expect(op?.toolName).toBe('Bash');
    expect(op?.params).toEqual({ command: 'npm build' });
    expect(op?.startedAt).toBe(1000);
    expect(op?.elapsedMs).toBe(4000); // 5000 - 1000

    const s2 = snap.sessions.find((s) => s.sessionId === 's2');
    expect(s2?.operations).toHaveLength(1);
  });

  it('已闭合执行不进快照；无在飞时 totalInFlight=0', () => {
    const repo = memRepo();
    repo.appendBegin({ executionId: 'done', toolName: 'Read', summary: 'r', params: {}, recordedAt: 10 });
    repo.appendComplete({ executionId: 'done', toolName: 'Read', status: 'success', recordedAt: 20 });

    const snap = buildRecoverySnapshot(repo, 100);
    expect(snap.totalInFlight).toBe(0);
    expect(snap.sessions).toHaveLength(0);
  });

  it('强杀进程 → 重启 → 现场被完整恢复（真实文件 DB 重放）', () => {
    const dbPath = freshTmpDbPath();

    // —— 运行中：工具放行后开始执行，落 begin；进程在执行中途被 SIGKILL（绝不落 complete）——
    {
      const db = new Database(dbPath);
      applySchema(db, createLogger() as never);
      const repo = new ToolExecutionEventRepository(db);
      repo.appendBegin({
        executionId: 'crash-exec',
        sessionId: 'live-session',
        toolName: 'Bash',
        summary: 'pnpm run migrate',
        params: { command: 'pnpm run migrate', cwd: '/repo', timeout: 600000 },
        recordedAt: 42_000,
      });
      // 模拟进程死亡：直接关库，没有 complete、没有优雅退出
      db.close();
    }

    // —— 重启：重新打开同一个 DB 文件，从总账重放出"崩溃前正在做的事" ——
    {
      const db = new Database(dbPath);
      applySchema(db, createLogger() as never); // 幂等，模拟重启初始化
      const repo = new ToolExecutionEventRepository(db);

      const snap = buildRecoverySnapshot(repo, 50_000);
      expect(snap.totalInFlight).toBe(1);
      const session = snap.sessions[0];
      expect(session.sessionId).toBe('live-session');
      const op = session.operations[0];
      expect(op.executionId).toBe('crash-exec');
      expect(op.toolName).toBe('Bash');
      expect(op.summary).toBe('pnpm run migrate');
      expect(op.params).toEqual({ command: 'pnpm run migrate', cwd: '/repo', timeout: 600000 });
      expect(op.startedAt).toBe(42_000);
      expect(op.elapsedMs).toBe(8_000); // 50000 - 42000：崩溃前已跑了 8s

      // —— 确认恢复（append-only 闭合），下次重启不再重复浮现 ——
      const acked = acknowledgeRecovery(repo, snap, 50_001);
      expect(acked).toBe(1);
      expect(repo.getOpenExecutions()).toHaveLength(0);
      db.close();
    }

    // —— 二次重启：现场已被确认恢复，幂等不重复 ——
    {
      const db = new Database(dbPath);
      applySchema(db, createLogger() as never);
      const repo = new ToolExecutionEventRepository(db);
      const snap = buildRecoverySnapshot(repo, 60_000);
      expect(snap.totalInFlight).toBe(0);
      db.close();
    }
  });

  it('acknowledgeRecovery 给每条在飞执行 append 一条 recovered 闭合', () => {
    const repo = memRepo();
    repo.appendBegin({ executionId: 'a', toolName: 'Edit', summary: 'a', params: {}, recordedAt: 1 });
    repo.appendBegin({ executionId: 'b', toolName: 'Edit', summary: 'b', params: {}, recordedAt: 2 });

    const snap = buildRecoverySnapshot(repo, 10);
    const acked = acknowledgeRecovery(repo, snap, 11);
    expect(acked).toBe(2);
    expect(repo.getOpenExecutions()).toHaveLength(0);

    const recovered = repo.getRecent(10).filter((r) => r.phase === 'complete' && r.status === 'recovered');
    expect(recovered).toHaveLength(2);
  });
});
