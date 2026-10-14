// ============================================================================
// DurableRunRepository.listActiveRunRoster 单测（ADR-083 ② 的名册源）：
// `neo daemon status` 直读 durable_runs 的活跃 run 名册——非终态全集入册、终态
// 出册、ownerId 带出属主；且这条路可以挂在只读连接上跑（CLI 的真实用法）。
// ============================================================================

import { afterEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

vi.unmock('better-sqlite3');
import Database from 'better-sqlite3';

import { DurableRunKernel } from '../../../src/host/runtime/durableRunKernel';
import { DurableRunRepository } from '../../../src/host/services/core/repositories/DurableRunRepository';

const tempDirs: string[] = [];

function makeTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'neo-daemon-roster-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    fs.rmSync(tempDirs.pop()!, { recursive: true, force: true });
  }
});

async function createFixture() {
  const dir = makeTempDir();
  const dbPath = path.join(dir, 'code-agent.db');
  const db = new Database(dbPath);
  const repo = new DurableRunRepository(db);
  repo.migrate();
  const kernel = new DurableRunKernel({
    stores: repo,
    ownerId: 'daemon-test-owner',
    processInstanceId: 'pi-1',
    leaseDurationMs: 60_000,
  });
  return { dir, dbPath, db, repo, kernel };
}

describe('listActiveRunRoster', () => {
  it('列出非终态 run（id/status/owner），终态 run 出册（ADR-083 ② 名册源）', async () => {
    const { db, repo, kernel } = await createFixture();
    try {
      await kernel.createRun({ runId: 'run-live', sessionId: 'sess-a', engine: { kind: 'native' }, now: 1_000 });
      await kernel.createRun({ runId: 'run-done', sessionId: 'sess-b', engine: { kind: 'native' }, now: 1_100 });
      await repo.commitTerminal({
        runId: 'run-done', attempt: 1, expectedOwnerEpoch: 1, expectedNextEventSeq: 1,
        status: 'completed', reason: 'cli_run_completed',
        event: { type: 'cli_run_completed', payload: {}, recordedAt: 2_000 },
        terminalAt: 2_000,
      });

      const roster = await repo.listActiveRunRoster();
      expect(roster).toHaveLength(1);
      expect(roster[0]).toEqual({
        runId: 'run-live',
        sessionId: 'sess-a',
        status: 'running',
        ownerId: 'daemon-test-owner',
      });

      await repo.commitTerminal({
        runId: 'run-live', attempt: 1, expectedOwnerEpoch: 1, expectedNextEventSeq: 1,
        status: 'cancelled', reason: 'cli_run_cancelled',
        event: { type: 'cli_run_cancelled', payload: {}, recordedAt: 3_000 },
        terminalAt: 3_000,
      });
      expect(await repo.listActiveRunRoster()).toEqual([]);
    } finally {
      db.close();
    }
  });

  it('名册可挂在只读连接上读（`neo daemon status` 的真实用法：query_only 也走得通）', async () => {
    const { db, dbPath, kernel } = await createFixture();
    await kernel.createRun({ runId: 'run-ro', sessionId: 'sess-ro', engine: { kind: 'native' }, now: 1_000 });
    db.close(); // 关写连接，checkpoint WAL，模拟 app 关闭后 CLI 来读
    const ro = new Database(dbPath, { readonly: true, fileMustExist: true });
    ro.pragma('query_only = ON');
    try {
      const roster = await new DurableRunRepository(ro).listActiveRunRoster();
      expect(roster.map((r) => r.runId)).toEqual(['run-ro']);
    } finally {
      ro.close();
    }
  });
});
