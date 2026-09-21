// N-EVAL-FAILURE-AUTOHARVEST · ai-review PR#2024 Important 2 的钉测试：
// handoff 提案的写入点（handoffProposalService）始终走全局 getDatabase()，
// 采集器 collectHandoffProposals 必须读同一个库——即使 adapter 被注入了另一条
// 隔离数据库线，也要读写入点那个库，否则真发出的提案会被看成不存在。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const dbState = vi.hoisted(() => ({
  sqlite: null as import('better-sqlite3').Database | null,
}));

vi.unmock('better-sqlite3');
import Database from 'better-sqlite3';
import { getDatabase } from '../../../src/host/services/core/databaseService';
import { HandoffProposalService } from '../../../src/host/handoff/handoffProposalService';
import { StandaloneAgentAdapter } from '../../../src/host/testing/agentAdapter';

function makeAdapter(injectedDb?: Database.Database): StandaloneAgentAdapter {
  const adapter = new StandaloneAgentAdapter({
    workingDirectory: '/tmp',
    modelConfig: { provider: 'mock', model: 'fake-model' },
    ...(injectedDb ? { database: { getDb: () => injectedDb } } : {}),
  } as ConstructorParameters<typeof StandaloneAgentAdapter>[0]);
  // currentSessionId 由 sendMessage 落定；这里直接钉上（单测不跑 run）。
  (adapter as unknown as { currentSessionId?: string }).currentSessionId = 'sess-handoff-1';
  return adapter;
}

describe('StandaloneAgentAdapter.collectHandoffProposals', () => {
  let database: ReturnType<typeof getDatabase>;
  let originalGetDb: typeof database.getDb;

  beforeEach(() => {
    dbState.sqlite = new Database(':memory:');
    database = getDatabase();
    originalGetDb = database.getDb.bind(database);
    database.getDb = () => dbState.sqlite;
  });

  afterEach(() => {
    database.getDb = originalGetDb;
    dbState.sqlite?.close();
    dbState.sqlite = null;
  });

  it('读写入点同一个库：提案经全局服务落库后能被采集到（含窗口过滤）', async () => {
    const service = new HandoffProposalService();
    service.create({
      sessionId: 'sess-handoff-1',
      sourceMessageId: 'assistant-1',
      title: '转给设计专家继续',
      prompt: '接着把首页重做',
      createdAt: 1000,
    });
    service.create({
      sessionId: 'sess-handoff-1',
      sourceMessageId: 'assistant-0',
      title: '窗口外的旧提案',
      prompt: '上一轮的事',
      createdAt: 500,
    });
    service.create({
      sessionId: 'sess-other',
      sourceMessageId: 'assistant-9',
      title: '别的会话的提案',
      prompt: '与本题无关',
      createdAt: 1500,
    });

    const adapter = makeAdapter();
    const records = await adapter.collectHandoffProposals(800);

    expect(records).toHaveLength(1);
    expect(records?.[0]).toMatchObject({ title: '转给设计专家继续', source: 'assistant_tail', createdAt: 1000 });
  });

  it('表都没建过 = 从未落过提案 ⇒ 零条是事实（不是没证据）', async () => {
    const adapter = makeAdapter();
    expect(await adapter.collectHandoffProposals(0)).toEqual([]);
  });

  it('库不可用 ⇒ undefined（没有证据源，断言侧 fail-loud）', async () => {
    database.getDb = () => null;
    const adapter = makeAdapter();
    expect(await adapter.collectHandoffProposals(0)).toBeUndefined();
  });

  it('会话 id 未落定（超时发生在 session 建立前）⇒ undefined，不是零提案', async () => {
    const adapter = new StandaloneAgentAdapter({
      workingDirectory: '/tmp',
      modelConfig: { provider: 'mock', model: 'fake-model' },
    } as ConstructorParameters<typeof StandaloneAgentAdapter>[0]);
    expect(await adapter.collectHandoffProposals(0)).toBeUndefined();
  });

  it('反向变异预埋：读注入的隔离库（而非写入点）时，真发出的提案会被漏掉', async () => {
    // 本用例复现 ai-review 指出的错读形状：注入库是另一条线、里面什么都没有。
    const isolated = new Database(':memory:');
    try {
      const service = new HandoffProposalService();
      service.create({
        sessionId: 'sess-handoff-1',
        sourceMessageId: 'assistant-1',
        title: '真发出的提案',
        prompt: '接力',
        createdAt: 1000,
      });
      const rows = isolated.prepare(
        `SELECT COUNT(*) AS count FROM sqlite_master WHERE type = 'table' AND name = 'handoff_proposals'`,
      ).get() as { count: number };
      expect(rows.count).toBe(0);
      // 而采集器仍然读到写入点库里的那条。
      const adapter = makeAdapter(isolated);
      expect(await adapter.collectHandoffProposals(0)).toHaveLength(1);
    } finally {
      isolated.close();
    }
  });
});
