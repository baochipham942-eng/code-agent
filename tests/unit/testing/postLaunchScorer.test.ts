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
import { POST_LAUNCH_JUDGE_VERSION, clampPostLaunchScoringRequest } from '../../../src/shared/contract/postLaunchScore';
import { estimateJudgeCost } from '../../../src/host/testing/postlaunch/postLaunchCost';
import { resolveModelPrice } from '../../../src/shared/pricing/resolveModelPrice';
import { acquireScoringLock, buildPostLaunchReport, getBudgetState, localDay, releaseScoringLock, renewScoringLock } from '../../../src/host/testing/postlaunch/postLaunchScoreStore';

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
  originKind: string | null = null,
): void {
  database.prepare(`
    INSERT INTO telemetry_sessions (id, title, model_provider, model_name, working_directory, start_time, session_type, origin_kind, agent_version, prompt_version)
    VALUES (?, ?, 'deepseek', 'deepseek-chat', '/ws', ?, ?, ?, '0.33.0', 'p7')
  `).run(id, id, startTime, sessionType, originKind);
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
    estimateJudgeCostUsd: () => ({ usd: 0.1, assumed: false }),
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

describe('IPC 评分请求钳位（花钱的信任边界）', () => {
  it('只认 days 且钳到 1–30；预算、抽样、dry-run 丢弃', () => {
    expect(clampPostLaunchScoringRequest({ days: 365, dailyBudgetUsd: 100000, dailySampleLimit: 100000, dryRun: false })).toEqual({ days: 30 });
    expect(clampPostLaunchScoringRequest({ days: 0 })).toEqual({ days: 1 });
    expect(clampPostLaunchScoringRequest({ days: 7.9 })).toEqual({ days: 7 });
    expect(clampPostLaunchScoringRequest({ days: 'x' })).toEqual({});
    expect(clampPostLaunchScoringRequest(undefined)).toEqual({});
  });
});

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

  it('④预算预留：已花 + 下一次调用的估算越线就停，不再发那一次（K1 是发完才停）', async () => {
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
    // 每次 judge 估 0.1、上限 0.25。判据是「已花 + 这次要花的 ≤ 上限」：
    // 0+0.1 ✓、0.1+0.1 ✓、0.2+0.1=0.3 ✗ ⇒ 第 3 次就不发了，总花费 0.2 不越线。
    // K1 是「已花 < 上限」⇒ 第 3 次照发、花到 0.3 才停，超支整整一次调用（刀 2 验收④）。
    const result = await runPostLaunchScoring(
      deps(database, replays, llmCall),
      { dailyBudgetUsd: 0.25 },
    );

    expect(llmCall).toHaveBeenCalledTimes(2);
    expect(result.costUsd).toBeCloseTo(0.2);
    expect(result.costUsd).toBeLessThanOrEqual(0.25);
    expect(result.budgetStopped).toBe(true);
    expect(result.signalOnlyTurns).toBe(2);
    const rows = scoreRows(database);
    expect(rows).toHaveLength(4);
    // 停评那些轮仍然留了信号行，只是四个语义维没有判决。
    const unjudged = rows.filter((row) => row.dim_goal === null);
    expect(unjudged).toHaveLength(2);
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

  it('--dry-run 的抽样行不占真评的日抽样额度（ai-review #1645 Important②）', async () => {
    for (const n of [1, 2, 3]) {
      insertSession(database, `chat-${n}`, 'chat', NOW - HOUR * n);
      insertTurn(database, `chat-${n}`, `chat-turn-${n}`, 1, NOW - HOUR * n);
    }
    const replays = Object.fromEntries([1, 2, 3].map((n) => [
      `chat-${n}`,
      replay(`chat-${n}`, [{ turnNumber: 1, startTime: NOW - HOUR * n, blocks: [{ type: 'text', content: '好了', timestamp: NOW - HOUR * n }] }]),
    ]));
    const llmCall = vi.fn(async () => ALL_PASS);
    await runPostLaunchScoring(deps(database, replays, llmCall), { dryRun: true, dailySampleLimit: 2 });
    expect(llmCall).not.toHaveBeenCalled();

    const real = await runPostLaunchScoring(deps(database, replays, llmCall), { dailySampleLimit: 2 });

    expect(llmCall).toHaveBeenCalledTimes(2);
    expect(real.sampledTurns).toBe(2);
  });

  it('--dry-run 不覆盖已有真评：真评过的轮 dry-run 跳过，六维原样（ai-review #1645 第二轮①）', async () => {
    insertSession(database, 'chat-1', 'chat', NOW - HOUR);
    insertTurn(database, 'chat-1', 'chat-turn-1', 1, NOW - HOUR);
    const replays = {
      'chat-1': replay('chat-1', [{ turnNumber: 1, startTime: NOW - HOUR, blocks: [{ type: 'text', content: '好了', timestamp: NOW - HOUR }] }]),
    };
    await runPostLaunchScoring(deps(database, replays, async () => ALL_PASS));
    const dry = await runPostLaunchScoring(deps(database, replays, async () => ALL_PASS), { dryRun: true });

    expect(dry.skippedTurns).toBe(1);
    const [row] = scoreRows(database);
    expect(row.judge_version).not.toBe('dry-run');
    expect(row.dim_goal).toBe(1);
  });

  it('互斥：同一个库上已有评分在跑时，第二次一轮不评、一分不扣，结果标 locked（ai-review #1645 第二轮②）', async () => {
    insertSession(database, 'chat-1', 'chat', NOW - HOUR);
    insertTurn(database, 'chat-1', 'chat-turn-1', 1, NOW - HOUR);
    const replays = {
      'chat-1': replay('chat-1', [{ turnNumber: 1, startTime: NOW - HOUR, blocks: [{ type: 'text', content: '好了', timestamp: NOW - HOUR }] }]),
    };
    const llmCall = vi.fn(async () => ALL_PASS);
    expect(acquireScoringLock(database, 'someone-else', NOW)).toBe(true);
    const blocked = await runPostLaunchScoring(deps(database, replays, llmCall));
    expect(blocked.locked).toBe(true);
    expect(llmCall).not.toHaveBeenCalled();
    expect(scoreRows(database)).toHaveLength(0);

    releaseScoringLock(database, 'someone-else');
    const normal = await runPostLaunchScoring(deps(database, replays, llmCall));
    expect(normal.locked).toBe(false);
    expect(llmCall).toHaveBeenCalledTimes(1);
    // 跑完锁已释放：别人能立刻拿到
    expect(acquireScoringLock(database, 'next', NOW + 1)).toBe(true);
  });

  it('互斥：持有者 30 分钟没释放视为崩了，可接管', () => {
    expect(acquireScoringLock(database, 'crashed', NOW)).toBe(true);
    expect(acquireScoringLock(database, 'newcomer', NOW + 5 * 60 * 1000)).toBe(false);
    expect(acquireScoringLock(database, 'newcomer', NOW + 31 * 60 * 1000)).toBe(true);
  });

  it('互斥：持有者续租后不会被按过期接管；续租失败说明锁已易主', () => {
    expect(acquireScoringLock(database, 'holder', NOW)).toBe(true);
    expect(renewScoringLock(database, 'holder', NOW + 25 * 60 * 1000)).toBe(true);
    expect(acquireScoringLock(database, 'newcomer', NOW + 35 * 60 * 1000)).toBe(false);
    expect(acquireScoringLock(database, 'newcomer', NOW + 56 * 60 * 1000)).toBe(true);
    expect(renewScoringLock(database, 'holder', NOW + 57 * 60 * 1000)).toBe(false);
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

  it('①来源标记：headless / 存量 cli_ 前缀的会话不进分母，manual 与普通 id 照评', async () => {
    // 四条都是 session_type='chat'——只有来源标记能把脚本发起的那两条分出来。
    const sessions: Array<[string, string | null]> = [
      ['chat-manual', 'manual'],
      ['chat-headless', 'headless'],
      ['cli_session_1788581520765_10a7e1aa', null], // 存量行：origin 为 NULL，靠 id 前缀兜底
      ['chat-legacy-plain', null],
    ];
    const replays: Record<string, ReturnType<typeof replay>> = {};
    for (const [index, [id, originKind]] of sessions.entries()) {
      insertSession(database, id, 'chat', NOW - HOUR, originKind);
      insertTurn(database, id, `turn-${index}`, 1, NOW - HOUR);
      replays[id] = replay(id, [{ turnNumber: 1, startTime: NOW - HOUR, blocks: [{ type: 'text', content: '好了', timestamp: NOW - HOUR }] }]);
    }

    const result = await runPostLaunchScoring(deps(database, replays, async () => ALL_PASS));

    expect(scoreRows(database).map((row) => row.session_id).sort()).toEqual(['chat-legacy-plain', 'chat-manual']);
    expect(result.excludedTurns).toBe(2);
  });

  it('②未知价模型也能触发预算门：没有刊例时按保守默认价记进预算，但不落 cost_usd', async () => {
    insertSession(database, 'chat-1', 'chat', NOW - HOUR);
    for (let index = 1; index <= 3; index += 1) {
      insertTurn(database, 'chat-1', `chat-turn-${index}`, index, NOW - HOUR + index);
    }
    const replays = {
      'chat-1': replay('chat-1', [1, 2, 3].map((turnNumber) => ({
        turnNumber,
        startTime: NOW - HOUR + turnNumber,
        blocks: [{ type: 'error', content: 'boom', timestamp: NOW - HOUR + turnNumber } as ReplayBlock],
      }))),
    };
    // 真正的估价函数 + 一个价目表里查不到的自定义 provider（K1 时这里恒返 0 ⇒ 预算门永不触发）。
    const unknownJudge = { provider: 'custom-glm-coding', model: 'glm-5.3' };
    expect(resolveModelPrice(unknownJudge.provider, unknownJudge.model).source).toBe('unknown');
    const llmCall = vi.fn(async () => ALL_PASS);
    const result = await runPostLaunchScoring(
      deps(database, replays, llmCall, {
        estimateJudgeCostUsd: (prompt, completion) => estimateJudgeCost(unknownJudge, prompt, completion),
      }),
      { dailyBudgetUsd: 0.002 },
    );

    expect(result.budgetStopped).toBe(true);
    expect(llmCall.mock.calls.length).toBeLessThan(3);
    // 展示与落库仍然守「未知价不编造」：cost_usd 是 0，钱记在 budget_cost_usd 上。
    const judged = scoreRows(database).filter((row) => row.dim_goal !== null);
    expect(judged.length).toBeGreaterThan(0);
    for (const row of judged) {
      expect(row.cost_usd).toBe(0);
      expect(row.budget_cost_usd as number).toBeGreaterThan(0);
    }
    const budget = buildPostLaunchReport(database, { now: NOW }).budget;
    expect(budget.spentUsd).toBeGreaterThan(0);
    expect(budget.assumedUsd).toBeCloseTo(budget.spentUsd);
  });

  it('③窗口按轮：10 天前开的会话，只评落在窗口里的那一轮', async () => {
    const tenDaysAgo = NOW - 10 * 24 * HOUR;
    const yesterday = NOW - 24 * HOUR;
    insertSession(database, 'chat-long', 'chat', tenDaysAgo);
    insertTurn(database, 'chat-long', 'turn-old', 1, tenDaysAgo);
    insertTurn(database, 'chat-long', 'turn-new', 2, yesterday);
    const replays = {
      'chat-long': replay('chat-long', [
        { turnNumber: 1, startTime: tenDaysAgo, blocks: [{ type: 'text', content: '十天前那轮', timestamp: tenDaysAgo }] },
        { turnNumber: 2, startTime: yesterday, blocks: [{ type: 'text', content: '昨天那轮', timestamp: yesterday }] },
      ]),
    };
    const result = await runPostLaunchScoring(deps(database, replays, async () => ALL_PASS), { days: 7 });

    // K1 按 sessions.start_time 切窗口 ⇒ 这条会话整条落在窗口外，一轮都评不到。
    expect(scoreRows(database).map((row) => row.turn_id)).toEqual(['turn-new']);
    expect(result.examinedTurns).toBe(1);
  });

  it('④每轮续租：锁被别人接管后当场停手，不再评也不再写', async () => {
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
    // 第一轮评完就把锁抢走：续租发生在每一轮开头，第二轮应当立刻停（K1 只在每个会话开头续租，
    // 单会话内被接管察觉不到，会一路评到底）。
    const llmCall = vi.fn(async () => {
      acquireScoringLock(database, 'someone-else', NOW + 40 * 60 * 1000);
      return ALL_PASS;
    });
    const result = await runPostLaunchScoring(deps(database, replays, llmCall));

    expect(llmCall).toHaveBeenCalledTimes(1);
    expect(result.locked).toBe(true);
    expect(scoreRows(database)).toHaveLength(1);
  });

  it('⑦judge 不可用与「压根没叫模型」分开记：只有前者算 judgeUnavailableTurns', async () => {
    insertSession(database, 'chat-1', 'chat', NOW - HOUR);
    insertTurn(database, 'chat-1', 'chat-turn-1', 1, NOW - HOUR);
    insertTurn(database, 'chat-1', 'chat-turn-2', 2, NOW - HOUR + 1);
    const replays = {
      'chat-1': replay('chat-1', [1, 2].map((turnNumber) => ({
        turnNumber,
        startTime: NOW - HOUR + turnNumber - 1,
        blocks: [{ type: 'text', content: '好了', timestamp: NOW - HOUR + turnNumber - 1 } as ReplayBlock],
      }))),
    };
    // 抽样额度只给 1：第一轮叫了模型但模型报错，第二轮压根没叫。
    const result = await runPostLaunchScoring(
      deps(database, replays, async () => { throw new Error('打分模型没有返回内容'); }),
      { dailySampleLimit: 1 },
    );

    expect(result.judgeUnavailableTurns).toBe(1);
    const models = scoreRows(database).map((row) => row.judge_model).sort();
    expect(models).toEqual(['not-judged', 'unavailable']);
    const report = buildPostLaunchReport(database, { now: NOW });
    expect(report.judgeUnavailableTurns).toBe(1);
  });

  it('③升级回填：K2 之前落的行，budget_cost_usd 从 cost_usd 补上，今天已花的预算不归零', () => {
    // 造 K2 之前的表：没有 budget_cost_usd 这一列。
    const legacy = new Database(':memory:');
    legacy.exec(`
      CREATE TABLE telemetry_turn_scores (
        turn_id TEXT PRIMARY KEY, session_id TEXT NOT NULL, scored_at INTEGER NOT NULL,
        scored_day TEXT NOT NULL, turn_started_at INTEGER NOT NULL,
        app_version TEXT, prompt_version TEXT, judge_version TEXT NOT NULL, rubric_version TEXT NOT NULL,
        judge_model TEXT, prompt_hash TEXT,
        dim_goal INTEGER, dim_orchestration INTEGER, dim_tools INTEGER,
        dim_permission INTEGER, dim_safety INTEGER, dim_artifact INTEGER,
        failure_class TEXT, reason_redacted TEXT, redacted INTEGER NOT NULL DEFAULT 0,
        signals TEXT NOT NULL DEFAULT '[]', cost_usd REAL NOT NULL DEFAULT 0, sampled_by TEXT NOT NULL
      )
    `);
    const day = localDay(NOW);
    legacy.prepare(`
      INSERT INTO telemetry_turn_scores (turn_id, session_id, scored_at, scored_day, turn_started_at,
        judge_version, rubric_version, cost_usd, sampled_by)
      VALUES ('old-turn', 'chat-1', ?, ?, ?, ?, 'postlaunch-rubric-v1', 0.3, 'sample')
    `).run(NOW, day, NOW - HOUR, POST_LAUNCH_JUDGE_VERSION);

    // 升级
    applyTelemetrySchema(legacy, LOGGER);

    // 预算查询只累计 budget_cost_usd：不回填的话这里是 0，用户当天能把上限再花满一遍。
    const budget = getBudgetState(legacy, day, { limitUsd: 0.5, sampleLimit: 20 });
    expect(budget.spentUsd).toBeCloseTo(0.3);
    // 回填的钱是真刊例，不是兜底估算 ⇒ assumedUsd 仍是 0
    expect(budget.assumedUsd).toBeCloseTo(0);

    // 幂等：再升一次不会把已经对上的行改坏
    applyTelemetrySchema(legacy, LOGGER);
    expect(getBudgetState(legacy, day, { limitUsd: 0.5, sampleLimit: 20 }).spentUsd).toBeCloseTo(0.3);
    legacy.close();
  });

  it('②报告侧也剔分母：升级前已落的 cli_ 探针分数行不进比率，但它花的钱照算（ai-review #1650 第 2 轮②）', () => {
    // 打分器只管新写入；这两行是 K2 之前就躺在表里的（爸真库里那 48 行大半是这批）。
    insertSession(database, 'chat-manual', 'chat', NOW - HOUR, 'manual');
    insertSession(database, 'cli_session_1788581520765_10a7e1aa', 'chat', NOW - HOUR, null);
    const day = localDay(NOW);
    const insertScore = database.prepare(`
      INSERT INTO telemetry_turn_scores (turn_id, session_id, scored_at, scored_day, turn_started_at,
        app_version, prompt_version, judge_version, rubric_version, judge_model,
        dim_goal, dim_safety, dim_artifact, signals, cost_usd, budget_cost_usd, sampled_by)
      VALUES (?, ?, ?, ?, ?, '0.33.0', 'p7', ?, 'postlaunch-rubric-v1', ?, ?, 1, 1, '[]', 0.1, 0.1, 'sample')
    `);
    insertScore.run('t-manual', 'chat-manual', NOW, day, NOW - HOUR, POST_LAUNCH_JUDGE_VERSION, 'deepseek/x', 1);
    insertScore.run('t-probe', 'cli_session_1788581520765_10a7e1aa', NOW, day, NOW - HOUR, POST_LAUNCH_JUDGE_VERSION, 'unavailable', 0);

    const report = buildPostLaunchReport(database, { now: NOW });

    // 比率只算真实用户会话那一行：goal 判了 1 轮、过了 1 轮（探针那行 goal=0 不该把它拉下来）
    expect(report.scoredTurns).toBe(1);
    const [group] = report.groups;
    expect(group.rows.find((row) => row.scope === 'sample')!.dims.goal).toEqual({ judged: 1, passed: 1 });
    expect(group.sessionIds).toEqual(['chat-manual']);
    // 探针那行的 judge_model='unavailable' 也不该拿去吓用户
    expect(report.judgeUnavailableTurns).toBe(0);
    // 但钱是真花了：两行的成本都留在账上，预算也两行都算
    expect(group.costUsd).toBeCloseTo(0.2);
    expect(report.budget.spentUsd).toBeCloseTo(0.2);
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
