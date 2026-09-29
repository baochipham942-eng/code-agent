// ============================================================================
// DurableRunRepository 写事务 IMMEDIATE + SQLITE_BUSY 重试回归（N-CLI-DURABLE-TERMINAL-LOST ②）
//   - 写锁被短暂占用（50ms busy_timeout < 120ms 持锁）时，commitTerminal 靠
//     BEGIN IMMEDIATE + busy 重试等到锁并落库；旧 deferred 形状单次等待超时直接抛
//     "database is locked"（terminalCLIDurableRun 两次零退避重试全灭 → run 永远非终态，
//     夜巡 night=2026-09-27 exit 0 会话遗留非终态 run 78 条即此形状）。
//   - 锁一直被占时重试耗尽后照常抛出（fail-visible，不静默吞）。
// ============================================================================
import { afterEach, describe, expect, it, vi } from 'vitest';
import { spawn } from 'node:child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

vi.unmock('better-sqlite3');
import Database from 'better-sqlite3';

import { DurableRunKernel } from '../../../src/host/runtime/durableRunKernel';
import { DurableRunRepository } from '../../../src/host/services/core/repositories/DurableRunRepository';

const tempDirs: string[] = [];

function makeTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'neo-durable-busy-'));
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
  const dbPath = path.join(dir, 'busy.db');
  const holder = new Database(dbPath, { timeout: 50 });
  holder.pragma('journal_mode = WAL');
  const holderRepo = new DurableRunRepository(holder);
  holderRepo.migrate();
  const kernel = new DurableRunKernel({
    stores: holderRepo,
    ownerId: 'cli-native-host',
    processInstanceId: 'cli-1-holder',
    leaseDurationMs: 60_000,
  });
  await kernel.createRun({
    runId: 'run-busy', sessionId: 'sess-busy', engine: { kind: 'native' }, now: 1_000,
  });
  const writer = new Database(dbPath, { timeout: 50 });
  writer.pragma('journal_mode = WAL');
  const writerRepo = new DurableRunRepository(writer);
  return { dbPath, holder, writer, writerRepo };
}

function terminalInput(now: number) {
  return {
    runId: 'run-busy',
    attempt: 1,
    expectedOwnerEpoch: 1,
    expectedNextEventSeq: 1,
    status: 'completed' as const,
    reason: 'cli_run_completed',
    event: { type: 'cli_run_completed', payload: {}, recordedAt: now },
    terminalAt: now,
  };
}

describe('DurableRunRepository 写事务 busy 重试', () => {
  it('写锁短暂被占时 commitTerminal 靠 IMMEDIATE+busy 重试等到锁落库（旧 deferred 形状此场景直接抛）', async () => {
    const { dbPath, holder, writer, writerRepo } = await createFixture();
    // 放锁方必须是另一个进程：better-sqlite3 的 busy 等待是同步阻塞，同进程的
    // setTimeout 放锁永远轮不到执行（事件循环被等锁占着），测不出重试桥接。
    const holderChild = spawn(process.execPath, ['-e', `
      const Database = require('better-sqlite3');
      const db = new Database(process.argv[1], { timeout: 1000 });
      db.pragma('journal_mode = WAL');
      db.exec('BEGIN IMMEDIATE');
      console.log('LOCKED');
      setTimeout(() => { db.exec('COMMIT'); db.close(); }, 120);
    `, dbPath], { cwd: process.cwd(), stdio: ['ignore', 'pipe', 'inherit'] });
    const locked = new Promise<void>((resolve) => {
      holderChild.stdout!.on('data', (chunk: Buffer) => {
        if (String(chunk).includes('LOCKED')) resolve();
      });
    });
    try {
      await locked;
      // 写连接 busy_timeout=50ms；锁持有人（独立进程）120ms 后放。
      // 旧 deferred 形状：SELECT 不挡、UPDATE 等满 50ms 超时抛 SQLITE_BUSY（仓储层无重试）→ 终态丢失；
      // 修复后：BEGIN IMMEDIATE 每次等满 50ms 抛、busy 重试共 3 次尝试（等待窗口
      // 0-50/50-100/100-150ms），第 3 个窗口覆盖 120ms 放锁点 → 拿到锁、终态落库。
      await expect(writerRepo.commitTerminal(terminalInput(2_000)))
        .resolves.toMatchObject({ status: 'completed' });
      expect(await writerRepo.get('run-busy')).toMatchObject({
        status: 'completed',
        terminal: { status: 'completed', reason: 'cli_run_completed' },
      });
    } finally {
      holderChild.kill();
      if (holder.inTransaction) holder.exec('ROLLBACK');
      writer.close();
      holder.close();
    }
  }, 20_000);

  it('写锁一直被占时重试耗尽后抛 database is locked（fail-visible，不静默吞）', async () => {
    const { holder, writer, writerRepo } = await createFixture();
    try {
      holder.exec('BEGIN IMMEDIATE');
      await expect(writerRepo.commitTerminal(terminalInput(2_000)))
        .rejects.toThrow(/database is locked/i);
      expect(await writerRepo.get('run-busy')).toMatchObject({ status: 'running' });
    } finally {
      if (holder.inTransaction) holder.exec('ROLLBACK');
      writer.close();
      holder.close();
    }
  });
});
