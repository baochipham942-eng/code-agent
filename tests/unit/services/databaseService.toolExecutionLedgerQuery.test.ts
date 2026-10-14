// ============================================================================
// 送达判定查询的"无法判定"必须显式抛错（N-MEDIA-GEN-IDEMPOTENT-RETRY 返修 r2）
// ============================================================================
// imageGenerateReuse 的复用判定把"查无 complete 事件"解读为"未送达 → 复用产物（不再
// 计费）"。因此 getToolExecutionsBySessionAndToolCallId 绝不能把查询失败（库未开 /
// 表损坏 / SQL 抛错）吞成空数组——那会让"无法判定"静默漏进"未送达"支，用户对已送达
// 的图说"再来一张"时拿到旧图冒充新图、还被谎报"没有再计费"。这里用真实 in-memory
// sqlite 钉死服务层契约：失败 = 抛错，空数组只留给"真的没有这个 toolCallId"。

import { describe, expect, it, vi } from 'vitest';

vi.unmock('better-sqlite3');
import Database from 'better-sqlite3';

vi.mock('../../../src/host/services/core/database/nativeLoader', () => ({
  loadBetterSqlite3: () => class MockDatabase {},
}));

import type BetterSqlite3 from 'better-sqlite3';
import { applySchema } from '../../../src/host/services/core/database/schema';
import { DatabaseService } from '../../../src/host/services/core/databaseService';
import { ToolExecutionEventRepository } from '../../../src/host/services/core/repositories/ToolExecutionEventRepository';

function createLogger() {
  return { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

function freshDb() {
  const db = new Database(':memory:');
  applySchema(db, createLogger() as never);
  return db;
}

/** 与 sessionLedger.integration.test.ts 同形：真实 in-memory DB + 真实仓储注入 DatabaseService。 */
function wire(db: BetterSqlite3.Database): DatabaseService {
  const svc = new DatabaseService();
  Object.assign(svc as unknown as Record<string, unknown>, {
    db,
    toolExecutionEventRepo: new ToolExecutionEventRepository(db),
  });
  return svc;
}

describe('DatabaseService.getToolExecutionsBySessionAndToolCallId（失败必须可区分于"查无事件"）', () => {
  it('库未初始化（db/仓储缺件）：抛错，不折成空数组', () => {
    const svc = new DatabaseService(); // 未注入 db / toolExecutionEventRepo
    expect(() => svc.getToolExecutionsBySessionAndToolCallId('s1', 'call-1')).toThrow();
  });

  it('事件表损坏/缺失（SQL 抛错）：异常向上传播，不吞成空数组', () => {
    const db = freshDb();
    try {
      db.prepare('DROP TABLE tool_execution_events').run();
      const svc = wire(db);
      expect(() => svc.getToolExecutionsBySessionAndToolCallId('s1', 'call-1')).toThrow(/no such table/);
    } finally {
      db.close();
    }
  });

  it('健康路径：按 toolCallId 命中 begin 并带回同 executionId 的 complete；查无该 toolCallId 才返回空', () => {
    const db = freshDb();
    try {
      const repo = new ToolExecutionEventRepository(db);
      repo.appendBegin({
        executionId: 'exec-1', sessionId: 's1', toolName: 'image_generate',
        summary: 'corgi', params: {}, origin: 'desktop', toolCallId: 'call-1',
        replaySafety: 'unknown', recordedAt: 1000,
      });
      repo.appendComplete({
        executionId: 'exec-1', sessionId: 's1', toolName: 'image_generate',
        status: 'success', recordedAt: 1100,
      });
      const svc = wire(db);

      const events = svc.getToolExecutionsBySessionAndToolCallId('s1', 'call-1');
      expect(events.map((event) => event.phase)).toEqual(['begin', 'complete']);
      // 空结果只留给"真的没有这个 toolCallId"——与查询失败可区分
      expect(svc.getToolExecutionsBySessionAndToolCallId('s1', 'call-other')).toEqual([]);
    } finally {
      db.close();
    }
  });
});
