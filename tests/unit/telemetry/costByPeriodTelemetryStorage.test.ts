import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.unmock('better-sqlite3');
import Database from 'better-sqlite3';
import { getDatabase } from '../../../src/main/services/core/databaseService';
import { TelemetryStorage } from '../../../src/main/telemetry/telemetryStorage';

const dbState = vi.hoisted(() => ({
  sqlite: null as import('better-sqlite3').Database | null,
}));

// 固定基准：2023-11-14（远离月底，本地时区偏移不会跨月）
const BASE = 1700000000000;
const ONE_MIN = 60 * 1000;
const THREE_DAYS = 3 * 24 * 3600 * 1000;

function insertSession(id: string, startTime: number, cost: number, tokens: number, userId: string | null = null): void {
  dbState.sqlite!
    .prepare(
      `INSERT INTO telemetry_sessions (id, user_id, start_time, estimated_cost, total_tokens) VALUES (?, ?, ?, ?, ?)`,
    )
    .run(id, userId, startTime, cost, tokens);
}

describe('TelemetryStorage.getCostByPeriod 成本日历聚合（#16）', () => {
  let database: ReturnType<typeof getDatabase>;
  let originalGetDb: typeof database.getDb;
  let isReadySpy: ReturnType<typeof vi.spyOn>;
  let storage: TelemetryStorage;

  beforeEach(() => {
    dbState.sqlite = new Database(':memory:');
    dbState.sqlite.exec(`
      CREATE TABLE telemetry_sessions (
        id TEXT PRIMARY KEY,
        user_id TEXT,
        start_time INTEGER NOT NULL,
        estimated_cost REAL DEFAULT 0,
        total_tokens INTEGER DEFAULT 0
      );
      CREATE TABLE sessions (
        id TEXT PRIMARY KEY,
        user_id TEXT
      );
    `);
    database = getDatabase();
    originalGetDb = database.getDb.bind(database);
    isReadySpy = vi.spyOn(database, 'isReady', 'get').mockReturnValue(true);
    database.getDb = () => dbState.sqlite as never;
    storage = new TelemetryStorage();
  });

  afterEach(() => {
    database.getDb = originalGetDb;
    isReadySpy.mockRestore();
    dbState.sqlite?.close();
    dbState.sqlite = null;
  });

  it('按日聚合：同一天的会话合并成本，不同天分桶', () => {
    insertSession('s1', BASE, 0.5, 1000);
    insertSession('s2', BASE + ONE_MIN, 0.3, 500); // 与 s1 同一天
    insertSession('s3', BASE + THREE_DAYS, 0.2, 800); // 3 天后

    const buckets = storage.getCostByPeriod({ granularity: 'day' });

    expect(buckets).toHaveLength(2);
    // 正序（旧→新）
    expect(buckets[0].period <= buckets[1].period).toBe(true);
    const totalSessions = buckets.reduce((s, b) => s + b.sessions, 0);
    expect(totalSessions).toBe(3);
    // 同一天那个桶成本 = 0.5 + 0.3
    const twoSessionBucket = buckets.find((b) => b.sessions === 2);
    expect(twoSessionBucket).toBeDefined();
    expect(twoSessionBucket!.cost).toBeCloseTo(0.8, 6);
    expect(twoSessionBucket!.tokens).toBe(1500);
  });

  it('按月聚合：同月会话归一桶', () => {
    insertSession('s1', BASE, 0.5, 1000);
    insertSession('s2', BASE + ONE_MIN, 0.3, 500);
    insertSession('s3', BASE + THREE_DAYS, 0.2, 800);

    const buckets = storage.getCostByPeriod({ granularity: 'month' });

    expect(buckets).toHaveLength(1);
    expect(buckets[0].sessions).toBe(3);
    expect(buckets[0].cost).toBeCloseTo(1.0, 6);
    expect(buckets[0].tokens).toBe(2300);
  });

  it('按 userId 过滤：只聚合该用户的会话', () => {
    insertSession('s1', BASE, 0.5, 1000, 'alice');
    insertSession('s2', BASE + ONE_MIN, 0.3, 500, 'bob');

    const aliceBuckets = storage.getCostByPeriod({ granularity: 'day', userId: 'alice' });
    const totalSessions = aliceBuckets.reduce((s, b) => s + b.sessions, 0);
    expect(totalSessions).toBe(1);
    expect(aliceBuckets.reduce((s, b) => s + b.cost, 0)).toBeCloseTo(0.5, 6);
  });

  it('limit 截取最近 N 个周期', () => {
    for (let i = 0; i < 5; i++) {
      insertSession(`s${i}`, BASE + i * 24 * 3600 * 1000, 0.1 * (i + 1), 100);
    }
    const buckets = storage.getCostByPeriod({ granularity: 'day', limit: 2 });
    expect(buckets).toHaveLength(2);
    // 取最近 2 天（成本最大的两个），正序返回
    expect(buckets[0].period <= buckets[1].period).toBe(true);
  });

  it('空库返回空数组', () => {
    expect(storage.getCostByPeriod({ granularity: 'day' })).toEqual([]);
  });
});
