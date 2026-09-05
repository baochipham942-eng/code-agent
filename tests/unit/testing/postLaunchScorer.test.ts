// 编排层：分母剔除、成本封顶、脱敏闸、落库、报告两行。
// 全程 :memory: 库 + 注入的假 judge/假磁盘，一个真实服务都不碰，更不碰 ~/.code-agent。
import os from 'node:os';
import path from 'node:path';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

// 兜底：本用例不该产生任何数据目录访问；万一有，也只能落到临时目录。
process.env.CODE_AGENT_DATA_DIR = path.join(os.tmpdir(), `postlaunch-scorer-${process.pid}`);

vi.unmock('better-sqlite3');
import Database from 'better-sqlite3';
import { applyTelemetrySchema } from '../../../src/host/services/core/database/schemaTelemetry';
import type { ReplayBlock, StructuredReplay } from '../../../src/shared/contract/evaluationReplay';
import type { FailureCodebook } from '../../../src/host/testing/failureCodes';
import { runPostLaunchScoring, type PostLaunchScorerDeps } from '../../../src/host/testing/postlaunch/postLaunchScorer';
import { buildPostLaunchReport } from '../../../src/host/testing/postlaunch/postLaunchScoreStore';

const NOW = new Date('2026-09-05T12:00:00+08:00').getTime();
const HOUR = 60 * 60 * 1000;
const LOGGER = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } as never;

const CODEBOOK: FailureCodebook = {
  version: 1,
  codes: [
    { code: 'timeout', label: '运行超时', priority: 600, match: { failureReason: ['超时', 'timed? out'] }, dispositions: [] },
    { code: 'missing_artifact', label: '缺少预期产物', priority: 200, match: { failureReason: ['missing artifact'] }, dispositions: [] },
  ],
} as FailureCodebook;

const ALL_PASS = JSON.stringify({
  goal: { pass: true, why: '有来源' },
  orchestration: { pass: true, why: '' },
  tools: { pass: true, why: '' },
  permission: { pass: true, why: '' },
});

function db(): Database.Database {
  const database = new Database(':memory:');
  applyTelemetrySchema(database, LOGGER);
  return database;
}

function insertSession(
  database: Database.Database,
  id: string,
  sessionType: string | null,
  startTime: number,
): void {
  database.prepare(`
    INSERT INTO telemetry_sessions (id, title, model_provider, model_name, working_directory, start_time, session_type, agent_version, prompt_version)
    VALUES (?, ?, 'deepseek', 'deepseek-chat', '/ws', ?, ?, '0.33.0', 'p7')
  `).run(id, id, startTime, sessionType);
}

function insertTurn(
  database: Database.Database,
  sessionId: string,
  turnId: string,
  turnNumber: number,
  startTime: number,
): void {
  database.prepare(`
    INSERT INTO telemetry_turns (id, session_id, turn_number, start_time, end_time, duration_ms, turn_type, total_input_tokens, total_output_tokens)
    VALUES (?, ?, ?, ?, ?, 1000, 'user', 100, 50)
  `).run(turnId, sessionId, turnNumber, startTime, startTime + 1000);
}

function replay(sessionId: string, turns: Array<{ turnNumber: number; startTime: number; blocks: ReplayBlock[] }>): StructuredReplay {
  return {
    sessionId,
    turns: turns.map((turn) => ({
      turnNumber: turn.turnNumber,
      turnType: 'user' as const,
      blocks: turn.blocks,
      inputTokens: 100,
      outputTokens: 50,
      durationMs: 1000,
      startTime: turn.startTime,
    })),
    summary: { totalTurns: turns.length },
  } as unknown as StructuredReplay;
}

function deps(
  database: Database.Database,
  replays: Record<string, StructuredReplay>,
  llmCall: PostLaunchScorerDeps['llmCall'],
  overrides: Partial<PostLaunchScorerDeps> = {},
): PostLaunchScorerDeps {
  return {
    db: database,
    getStructuredReplay: async (sessionId) => replays[sessionId] ?? null,
    llmCall,
    estimateJudgeCostUsd: () => 0.1,
    estimateTurnCostUsd: () => 0.001,
    fileExists: () => true,
    now: () => NOW,
    failureCodebook: CODEBOOK,
    ...overrides,
  };
}

function scoreRows(database: Database.Database): Array<Record<string, unknown>> {
  return database.prepare('SELECT * FROM telemetry_turn_scores ORDER BY turn_id').all() as Array<Record<string, unknown>>;
}

describe('上线后打分编排', () => {
  let database: Database.Database;

  beforeAll(() => {
    // 记一笔：这套用例只应触碰 :memory:，不产生任何文件。
    expect(process.env.CODE_AGENT_DATA_DIR).toContain(os.tmpdir());
  });

  beforeEach(() => {
    database = db();
  });

  it('③分母剔除：eval / 子代理 / 定时 / 心跳会话一行分数都不落', async () => {
    insertSession(database, 'chat-1', 'chat', NOW - HOUR);
    insertTurn(database, 'chat-1', 'chat-turn-1', 1, NOW - HOUR);
    for (const [index, type] of ['eval', 'subagent', 'schedule', 'heartbeat'].entries()) {
      insertSession(database, `sys-${type}`, type, NOW - HOUR);
      insertTurn(database, `sys-${type}`, `sys-turn-${index}`, 1, NOW - HOUR);
    }

    // 被剔的会话也给足回放：不给回放的话「没落库」可能只是因为回放拿不到，
    // 剔除逻辑就算被摘掉测试也照绿（咬合点必须落在剔除本身）。
    const replays: Record<string, ReturnType<typeof replay>> = {
      'chat-1': replay('chat-1', [{ turnNumber: 1, startTime: NOW - HOUR, blocks: [{ type: 'text', content: '好了', timestamp: NOW - HOUR }] }]),
    };
    for (const type of ['eval', 'subagent', 'schedule', 'heartbeat']) {
      replays[`sys-${type}`] = replay(`sys-${type}`, [{
        turnNumber: 1, startTime: NOW - HOUR, blocks: [{ type: 'text', content: '好了', timestamp: NOW - HOUR }],
      }]);
    }
    const result = await runPostLaunchScoring(deps(database, replays, async () => ALL_PASS));

    const rows = scoreRows(database);
    expect(rows).toHaveLength(1);
    expect(rows[0].session_id).toBe('chat-1');
    expect(result.excludedTurns).toBe(4);
  });

  it('③落库：六维、信号、成本、抽样来源都进本地表', async () => {
    insertSession(database, 'chat-1', 'chat', NOW - HOUR);
    insertTurn(database, 'chat-1', 'chat-turn-1', 1, NOW - HOUR);
    const replays = {
      'chat-1': replay('chat-1', [{
        turnNumber: 1,
        startTime: NOW - HOUR,
        blocks: [{ type: 'error', content: 'Request timed out after 30000ms', timestamp: NOW - HOUR }],
      }]),
    };
    await runPostLaunchScoring(deps(database, replays, async () => ALL_PASS));

    const [row] = scoreRows(database);
    expect(row.dim_goal).toBe(1);
    expect(row.dim_safety).toBe(1);
    expect(row.dim_artifact).toBe(1);
    expect(JSON.parse(row.signals as string)).toContain('timeout');
    expect(row.failure_class).toBe('timeout');
    expect(row.sampled_by).toBe('signal');
    expect(row.app_version).toBe('0.33.0');
    expect(row.prompt_version).toBe('p7');
    expect(row.cost_usd).toBeCloseTo(0.1);
  });

  it('④脱敏闸：理由里带家目录就整句置空并标 redacted，不发脱敏残句', async () => {
    insertSession(database, 'chat-1', 'chat', NOW - HOUR);
    insertTurn(database, 'chat-1', 'chat-turn-1', 1, NOW - HOUR);
    const replays = {
      'chat-1': replay('chat-1', [{ turnNumber: 1, startTime: NOW - HOUR, blocks: [{ type: 'text', content: '好了', timestamp: NOW - HOUR }] }]),
    };
    const leaky = JSON.stringify({
      goal: { pass: false, why: '写到了 /Users/someone/secret/notes.md 而不是工作目录' },
      orchestration: { pass: true, why: '' },
      tools: { pass: true, why: '' },
      permission: { pass: true, why: '' },
    });
    await runPostLaunchScoring(deps(database, replays, async () => leaky));

    const [row] = scoreRows(database);
    expect(row.redacted).toBe(1);
    expect(row.reason_redacted).toBe('');
  });

  it('④脱敏闸：干净理由原样落库，不误伤', async () => {
    insertSession(database, 'chat-1', 'chat', NOW - HOUR);
    insertTurn(database, 'chat-1', 'chat-turn-1', 1, NOW - HOUR);
    const replays = {
      'chat-1': replay('chat-1', [{ turnNumber: 1, startTime: NOW - HOUR, blocks: [{ type: 'text', content: '好了', timestamp: NOW - HOUR }] }]),
    };
    const clean = JSON.stringify({
      goal: { pass: false, why: '声称的结果在轨迹里找不到来源' },
      orchestration: { pass: true, why: '' },
      tools: { pass: true, why: '' },
      permission: { pass: true, why: '' },
    });
    await runPostLaunchScoring(deps(database, replays, async () => clean));

    const [row] = scoreRows(database);
    expect(row.redacted).toBe(0);
    expect(row.reason_redacted).toContain('声称的结果在轨迹里找不到来源');
  });

  it('⑤成本封顶：日预算用完当天停评，只记信号不再调模型', async () => {
    insertSession(database, 'chat-1', 'chat', NOW - HOUR);
    for (let index = 1; index <= 4; index += 1) {
      insertTurn(database, 'chat-1', `chat-turn-${index}`, index, NOW - HOUR + index);
    }
    const replays = {
      'chat-1': replay('chat-1', [1, 2, 3, 4].map((turnNumber) => ({
        turnNumber,
        startTime: NOW - HOUR + turnNumber,
        blocks: [{ type: 'error', content: 'boom', timestamp: NOW - HOUR + turnNumber } as ReplayBlock],
      }))),
    };
    const llmCall = vi.fn(async () => ALL_PASS);
    // 每次 judge 记 0.1，上限 0.25 ⇒ 只该调两次（0.1、0.2），第三次时 spent 已 0.2 < 0.25 仍可调，第四次 0.3 停。
    const result = await runPostLaunchScoring(
      deps(database, replays, llmCall),
      { dailyBudgetUsd: 0.25 },
    );

    expect(llmCall).toHaveBeenCalledTimes(3);
    expect(result.budgetStopped).toBe(true);
    expect(result.signalOnlyTurns).toBe(1);
    const rows = scoreRows(database);
    expect(rows).toHaveLength(4);
    // 停评那一轮仍然留了信号行，只是四个语义维没有判决。
    const unjudged = rows.filter((row) => row.dim_goal === null);
    expect(unjudged).toHaveLength(1);
    expect(JSON.parse(unjudged[0].signals as string)).toContain('error_terminated');
  });

  it('⑤日抽样上限：没命中信号的轮超过上限就不再评', async () => {
    insertSession(database, 'chat-1', 'chat', NOW - HOUR);
    for (let index = 1; index <= 3; index += 1) {
      insertTurn(database, 'chat-1', `chat-turn-${index}`, index, NOW - HOUR + index);
    }
    const replays = {
      'chat-1': replay('chat-1', [1, 2, 3].map((turnNumber) => ({
        turnNumber,
        startTime: NOW - HOUR + turnNumber,
        blocks: [{ type: 'text', content: '好了', timestamp: NOW - HOUR + turnNumber } as ReplayBlock],
      }))),
    };
    const llmCall = vi.fn(async () => ALL_PASS);
    const result = await runPostLaunchScoring(deps(database, replays, llmCall), { dailySampleLimit: 2 });

    expect(llmCall).toHaveBeenCalledTimes(2);
    expect(result.sampledTurns).toBe(2);
    expect(result.signalOnlyTurns).toBe(1);
  });

  it('--dry-run 一次模型都不调，但信号照记', async () => {
    insertSession(database, 'chat-1', 'chat', NOW - HOUR);
    insertTurn(database, 'chat-1', 'chat-turn-1', 1, NOW - HOUR);
    const replays = {
      'chat-1': replay('chat-1', [{ turnNumber: 1, startTime: NOW - HOUR, blocks: [{ type: 'error', content: 'boom', timestamp: NOW - HOUR }] }]),
    };
    const llmCall = vi.fn(async () => ALL_PASS);
    await runPostLaunchScoring(deps(database, replays, llmCall), { dryRun: true });

    expect(llmCall).not.toHaveBeenCalled();
    const [row] = scoreRows(database);
    expect(row.dim_goal).toBeNull();
    expect(JSON.parse(row.signals as string)).toContain('error_terminated');
  });

  it('--dry-run 落的行不挡之后的真评：真评照调模型并覆盖 dry-run 行（真库副本 09-05 实付抓出）', async () => {
    insertSession(database, 'chat-1', 'chat', NOW - HOUR);
    insertTurn(database, 'chat-1', 'chat-turn-1', 1, NOW - HOUR);
    const replays = {
      'chat-1': replay('chat-1', [{ turnNumber: 1, startTime: NOW - HOUR, blocks: [{ type: 'error', content: 'boom', timestamp: NOW - HOUR }] }]),
    };
    const llmCall = vi.fn(async () => ALL_PASS);
    await runPostLaunchScoring(deps(database, replays, llmCall), { dryRun: true });
    expect(scoreRows(database)).toHaveLength(1);
    expect(scoreRows(database)[0].judge_version).toBe('dry-run');

    const real = await runPostLaunchScoring(deps(database, replays, llmCall));

    expect(llmCall).toHaveBeenCalledTimes(1);
    expect(real.skippedTurns).toBe(0);
    const rows = scoreRows(database);
    expect(rows).toHaveLength(1);
    expect(rows[0].judge_version).not.toBe('dry-run');
    expect(rows[0].dim_goal).toBe(1);
  });

  it('已评过的轮不重复花钱', async () => {
    insertSession(database, 'chat-1', 'chat', NOW - HOUR);
    insertTurn(database, 'chat-1', 'chat-turn-1', 1, NOW - HOUR);
    const replays = {
      'chat-1': replay('chat-1', [{ turnNumber: 1, startTime: NOW - HOUR, blocks: [{ type: 'text', content: '好了', timestamp: NOW - HOUR }] }]),
    };
    const llmCall = vi.fn(async () => ALL_PASS);
    await runPostLaunchScoring(deps(database, replays, llmCall));
    const second = await runPostLaunchScoring(deps(database, replays, llmCall));

    expect(llmCall).toHaveBeenCalledTimes(1);
    expect(second.skippedTurns).toBe(1);
  });

  it('报告：信号轮与抽样轮分两行，不合并；null 不进分母', async () => {
    insertSession(database, 'chat-1', 'chat', NOW - HOUR);
    insertTurn(database, 'chat-1', 'chat-turn-1', 1, NOW - HOUR);
    insertTurn(database, 'chat-1', 'chat-turn-2', 2, NOW - HOUR + 1);
    const replays = {
      'chat-1': replay('chat-1', [
        { turnNumber: 1, startTime: NOW - HOUR, blocks: [{ type: 'error', content: 'boom', timestamp: NOW - HOUR }] },
        { turnNumber: 2, startTime: NOW - HOUR + 1, blocks: [{ type: 'text', content: '好了', timestamp: NOW - HOUR + 1 }] },
      ]),
    };
    const failGoal = JSON.stringify({
      goal: { pass: false, why: '没有来源' },
      orchestration: { pass: true, why: '' },
      tools: { pass: true, why: '' },
      permission: { pass: true, why: '' },
    });
    // 按轨迹内容分派，不按调用顺序：编排是新轮优先，顺序假设一改实现就会假绿。
    await runPostLaunchScoring(deps(database, replays, async (prompt) => (
      prompt.includes('boom') ? failGoal : ALL_PASS
    )));

    const report = buildPostLaunchReport(database, { now: NOW });
    expect(report.groups).toHaveLength(1);
    const [group] = report.groups;
    const signalRow = group.rows.find((row) => row.scope === 'signal')!;
    const sampleRow = group.rows.find((row) => row.scope === 'sample')!;
    expect(signalRow.turns).toBe(1);
    expect(sampleRow.turns).toBe(1);
    expect(signalRow.dims.goal).toEqual({ judged: 1, passed: 0 });
    expect(sampleRow.dims.goal).toEqual({ judged: 1, passed: 1 });
    expect(group.appVersion).toBe('0.33.0');
    expect(group.sessionIds).toEqual(['chat-1']);
    // κ 缺失 ⇒ 报告顶上必须挂校准不足，不能默认当已校准。
    expect(report.calibration).toEqual({ state: 'insufficient', reason: 'no_record' });
  });

  it('子迭代的块并进它的 user 父轮：agentic loop 不把一轮拆成多轮', async () => {
    insertSession(database, 'chat-1', 'chat', NOW - HOUR);
    insertTurn(database, 'chat-1', 'chat-turn-1', 1, NOW - HOUR);
    database.prepare(`
      INSERT INTO telemetry_turns (id, session_id, turn_number, start_time, end_time, duration_ms, turn_type, parent_turn_id, total_input_tokens, total_output_tokens)
      VALUES ('chat-turn-1-i1', 'chat-1', 2, ?, ?, 10, 'iteration', 'chat-turn-1', 10, 5)
    `).run(NOW - HOUR + 5, NOW - HOUR + 15);
    const replays = {
      'chat-1': replay('chat-1', [
        { turnNumber: 1, startTime: NOW - HOUR, blocks: [{ type: 'user', content: '干活', timestamp: NOW - HOUR }] },
        { turnNumber: 2, startTime: NOW - HOUR + 5, blocks: [{ type: 'error', content: 'boom', timestamp: NOW - HOUR + 5 }] },
      ]),
    };
    await runPostLaunchScoring(deps(database, replays, async () => ALL_PASS));

    const rows = scoreRows(database);
    expect(rows).toHaveLength(1);
    expect(rows[0].turn_id).toBe('chat-turn-1');
    expect(JSON.parse(rows[0].signals as string)).toContain('error_terminated');
  });
});
