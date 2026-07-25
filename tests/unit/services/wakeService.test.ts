// ============================================================================
// self-wake：挂起台账 + 到点续跑 + 配额 + 重启存活（D-1）
// ============================================================================

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// 全局 setup 把 better-sqlite3 mock 掉了；这里要真库跑真 SQL
vi.unmock('better-sqlite3');

import Database from 'better-sqlite3';
import type { Database as SQLiteDatabase } from 'better-sqlite3';
import { AgentWakeRepository } from '../../../src/host/services/core/repositories/AgentWakeRepository';
import { WakeService } from '../../../src/host/services/wake/wakeService';
import { AGENT_WAKE } from '../../../src/shared/constants/agent';
import { buildWakeResumePrompt, type AgentWakeRecord } from '../../../src/shared/contract/agentWake';

/** 与 schema.ts 的 agent_wakes 建表语句同形；schema 漂了这里会先红。 */
function createSchema(db: SQLiteDatabase): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS agent_wakes (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      kind TEXT NOT NULL,
      due_at INTEGER,
      job_id TEXT,
      event_name TEXT,
      reason TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'pending',
      created_at INTEGER NOT NULL,
      fired_at INTEGER
    )
  `);
}

let db: SQLiteDatabase;
let repo: AgentWakeRepository;
let delivered: AgentWakeRecord[];
let clock = 1_000_000;

function makeService(): WakeService {
  return new WakeService(repo, {
    now: () => clock,
    deliver: async (record) => {
      delivered.push(record);
    },
  });
}

beforeEach(() => {
  db = new Database(':memory:');
  createSchema(db);
  repo = new AgentWakeRepository(db);
  delivered = [];
  clock = 1_000_000;
});

afterEach(() => {
  db.close();
});

describe('park + tick', () => {
  it('没到点不投递，到点了才续跑', async () => {
    const service = makeService();
    service.park({ sessionId: 's1', kind: 'time', dueAt: clock + 60_000, reason: '等导出跑完' });

    expect(await service.tick()).toBe(0);
    expect(delivered).toHaveLength(0);

    clock += 60_000;
    expect(await service.tick()).toBe(1);
    expect(delivered.map((r) => r.reason)).toEqual(['等导出跑完']);
  });

  it('同一条只投递一次（tick 反复跑不会把同一句话说两遍）', async () => {
    const service = makeService();
    service.park({ sessionId: 's1', kind: 'time', dueAt: clock, reason: 'r' });

    await service.tick();
    await service.tick();
    expect(delivered).toHaveLength(1);
  });

  it('两个 tick 撞在一起也只投递一次（markFired 抢占裁决）', async () => {
    const service = makeService();
    service.park({ sessionId: 's1', kind: 'time', dueAt: clock, reason: 'r' });

    // 两个 tick 都在各自 markFired 之前就查到了这条 pending
    await Promise.all([service.tick(), service.tick()]);

    expect(delivered).toHaveLength(1);
  });

  it('投递失败不吞掉其它条', async () => {
    let calls = 0;
    const service = new WakeService(repo, {
      now: () => clock,
      deliver: async (record) => {
        calls += 1;
        if (calls === 1) throw new Error('orchestrator gone');
        delivered.push(record);
      },
    });
    service.park({ sessionId: 's1', kind: 'time', dueAt: clock, reason: 'first' });
    service.park({ sessionId: 's2', kind: 'time', dueAt: clock, reason: 'second' });

    expect(await service.tick()).toBe(1);
    expect(delivered.map((r) => r.reason)).toEqual(['second']);
  });
});

describe('重启存活', () => {
  it('进程重启后，上次留下的 pending 醒来仍会触发（迟到也送）', async () => {
    const before = makeService();
    before.park({ sessionId: 's1', kind: 'time', dueAt: clock + 60_000, reason: '三小时后回来看' });
    before.stop();

    // 模拟重启：同一个库、全新的 service 实例，内存里什么都没留下
    delivered = [];
    clock += 10 * 60_000; // 关机期间早就过了点
    const afterRestart = makeService();

    expect(await afterRestart.tick()).toBe(1);
    expect(delivered.map((r) => r.reason)).toEqual(['三小时后回来看']);
    expect(repo.listPending()).toHaveLength(0);
  });
});

describe('每会话配额', () => {
  it('挂满配额后拒绝再挂，并把用量说清楚', () => {
    const service = makeService();
    for (let i = 0; i < AGENT_WAKE.MAX_PER_SESSION; i += 1) {
      clock += 1;
      expect(service.park({ sessionId: 's1', kind: 'time', dueAt: clock + 1000, reason: `r${i}` }).ok).toBe(true);
    }
    const rejected = service.park({ sessionId: 's1', kind: 'time', dueAt: clock + 1000, reason: 'once more' });
    expect(rejected).toMatchObject({ ok: false, reason: 'quota_exceeded', limit: AGENT_WAKE.MAX_PER_SESSION });
  });

  it('配额按会话算，别的会话不受连累', () => {
    const service = makeService();
    for (let i = 0; i < AGENT_WAKE.MAX_PER_SESSION; i += 1) {
      clock += 1;
      service.park({ sessionId: 's1', kind: 'time', dueAt: clock + 1000, reason: `r${i}` });
    }
    expect(service.park({ sessionId: 's2', kind: 'time', dueAt: clock + 1000, reason: 'fresh' }).ok).toBe(true);
  });

  it('已 fire 的也算进配额——防「醒来→又挂起」的重试风暴', async () => {
    const service = makeService();
    service.park({ sessionId: 's1', kind: 'time', dueAt: clock, reason: 'r' });
    await service.tick();
    expect(repo.countBySession('s1')).toBe(1);
  });
});

describe('条件型醒来', () => {
  it('等的自动化跑完就醒，不相干的任务跑完不醒', async () => {
    const service = makeService();
    service.park({ sessionId: 's1', kind: 'job', jobId: 'job-a', reason: '等导出' });

    expect(await service.onJobCompleted('job-b')).toBe(0);
    expect(await service.onJobCompleted('job-a')).toBe(1);
    expect(delivered.map((r) => r.reason)).toEqual(['等导出']);
  });

  it('等的事件发生就醒', async () => {
    const service = makeService();
    service.park({ sessionId: 's1', kind: 'event', eventName: '库存告警', reason: '有货就下单' });

    expect(await service.onEvent('别的事')).toBe(0);
    expect(await service.onEvent('库存告警')).toBe(1);
  });

  it('会话作废时把它挂着的醒来一起撤掉', async () => {
    const service = makeService();
    service.park({ sessionId: 's1', kind: 'event', eventName: 'e', reason: 'r' });

    expect(service.cancelForSession('s1')).toBe(1);
    expect(await service.onEvent('e')).toBe(0);
  });
});

describe('buildWakeResumePrompt', () => {
  it('把当初挂起的理由原样带回去', () => {
    const prompt = buildWakeResumePrompt({ kind: 'time', reason: '等季度报表生成完再汇总' });
    expect(prompt).toContain('等季度报表生成完再汇总');
  });

  it('三种触发说的是不同的话', () => {
    const kinds = (['time', 'job', 'event'] as const).map((kind) => buildWakeResumePrompt({ kind, reason: 'r' }));
    expect(new Set(kinds).size).toBe(3);
  });
});
