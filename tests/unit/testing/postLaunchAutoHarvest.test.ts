// N-EVAL-FAILURE-AUTOHARVEST · 交付①：低分自动入候选。
// 覆盖：开关三态解析（缺省关）/ 按日节流与撞锁 / signalOnly 扫描零 judge 调用且
// 低分行落库后候选视图自动带出 / not-judged 占位行不挡人手真评补评（FB-233）。
// 全程 :memory: 库 + 注入假扫描/假 judge，一个真实服务都不碰，更不碰 ~/.code-agent。
import os from 'node:os';
import path from 'node:path';
import { beforeAll, describe, expect, it, vi } from 'vitest';

process.env.CODE_AGENT_DATA_DIR = path.join(os.tmpdir(), `postlaunch-autoharvest-${process.pid}`);

const systemOneMock = vi.hoisted(() => vi.fn(async () => ({})));
vi.mock('../../../src/host/model/providers/typesafeProvider', () => ({
  systemOne: systemOneMock,
}));

vi.unmock('better-sqlite3');
import Database from 'better-sqlite3';
import { applySchema } from '../../../src/host/services/core/database/schema';
import type { ReplayBlock, ReplayToolCall, StructuredReplay } from '../../../src/shared/contract/evaluationReplay';
import type { FailureCodebook } from '../../../src/host/testing/failureCodes';
import {
  POST_LAUNCH_JUDGE_VERSION,
  resolvePostLaunchAutoHarvestEnabled,
} from '../../../src/shared/contract/postLaunchScore';
import { runPostLaunchScoring, type PostLaunchScorerDeps } from '../../../src/host/testing/postlaunch/postLaunchScorer';
import { listReflowCandidates } from '../../../src/host/testing/postlaunch/postLaunchScoreStore';
import {
  maybeRunPostLaunchAutoHarvest,
  type PostLaunchAutoHarvestDeps,
} from '../../../src/host/testing/postlaunch/postLaunchAutoHarvest';
import { applyTestTelemetrySchema } from '../../utils/telemetrySchema';

const NOW = new Date('2026-09-22T12:00:00+08:00').getTime();
const HOUR = 60 * 60 * 1000;
const LOGGER = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } as never;

const CODEBOOK: FailureCodebook = { version: 1, codes: [] } as unknown as FailureCodebook;

function db(): Database.Database {
  const database = new Database(':memory:');
  applySchema(database, LOGGER);
  applyTestTelemetrySchema(database);
  return database;
}

function insertSession(database: Database.Database, id: string, startTime: number): void {
  database.prepare(`
    INSERT INTO telemetry_sessions (id, title, model_provider, model_name, working_directory, start_time, session_type, origin_kind, agent_version, prompt_version)
    VALUES (?, ?, 'deepseek', 'deepseek-chat', '/ws', ?, 'chat', NULL, '0.33.0', 'p7')
  `).run(id, id, startTime);
}

function insertTurn(database: Database.Database, sessionId: string, turnId: string, startTime: number): void {
  database.prepare(`
    INSERT INTO telemetry_turns (id, session_id, turn_number, start_time, end_time, duration_ms, turn_type, total_input_tokens, total_output_tokens)
    VALUES (?, ?, 1, ?, ?, 1000, 'user', 100, 50)
  `).run(turnId, sessionId, startTime, startTime + 1000);
}

/** 三次同参数连续调用 ⇒ repeat_loop 确定性信号。 */
function repeatLoopReplay(sessionId: string, startTime: number): StructuredReplay {
  const toolCall: ReplayToolCall = { id: 'read-a', name: 'Read', args: { path: 'a.ts' }, success: true, duration: 1, category: 'Read' };
  const blocks: ReplayBlock[] = [
    { type: 'user', content: '帮我看看这个文件', timestamp: startTime },
    ...[1, 2, 3].map((offset) => ({
      type: 'tool_call' as const,
      content: toolCall.name,
      timestamp: startTime + offset,
      toolCall,
    })),
  ];
  return {
    sessionId,
    turns: [{
      turnNumber: 1,
      turnType: 'user',
      blocks,
      inputTokens: 100,
      outputTokens: 50,
      durationMs: 1000,
      startTime,
    }],
    summary: { totalTurns: 1 },
  } as unknown as StructuredReplay;
}

function scorerDeps(
  database: Database.Database,
  replays: Record<string, StructuredReplay>,
  llmCall: PostLaunchScorerDeps['llmCall'],
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
  };
}

function harvestDeps(database: Database.Database, overrides: Partial<PostLaunchAutoHarvestDeps> = {}): PostLaunchAutoHarvestDeps {
  return {
    db: database,
    isEnabled: () => true,
    runScan: async () => ({
      examinedTurns: 1, excludedTurns: 0, signalTurns: 0, sampledTurns: 0, signalOnlyTurns: 1,
      skippedTurns: 0, costUsd: 0, judgeUnavailableTurns: 0, budgetStopped: false, locked: false, dryRun: false,
    }),
    now: () => NOW,
    ...overrides,
  };
}

beforeAll(() => {
  expect(process.env.CODE_AGENT_DATA_DIR).toContain(os.tmpdir());
});

describe('开关三态解析（默认关）', () => {
  it('缺省（undefined）= 关，内部槽也不自动开（与兄弟开关的刻意偏离）', () => {
    expect(resolvePostLaunchAutoHarvestEnabled(undefined, true)).toBe(false);
    expect(resolvePostLaunchAutoHarvestEnabled(undefined, false)).toBe(false);
  });

  it("'auto' = 仅内部槽；'on'/'off' 显式说了算", () => {
    expect(resolvePostLaunchAutoHarvestEnabled('auto', true)).toBe(true);
    expect(resolvePostLaunchAutoHarvestEnabled('auto', false)).toBe(false);
    expect(resolvePostLaunchAutoHarvestEnabled('on', false)).toBe(true);
    expect(resolvePostLaunchAutoHarvestEnabled('off', true)).toBe(false);
  });
});

describe('maybeRunPostLaunchAutoHarvest（开关闸 + 节流 + 撞锁）', () => {
  it('开关关着 ⇒ disabled，不跑扫描且 warn 留痕', async () => {
    const database = db();
    const runScan = vi.fn();
    const onWarn = vi.fn();
    const outcome = await maybeRunPostLaunchAutoHarvest(harvestDeps(database, {
      isEnabled: () => false,
      runScan,
      onWarn,
    }));
    expect(outcome).toBe('disabled');
    expect(runScan).not.toHaveBeenCalled();
    expect(onWarn).toHaveBeenCalledOnce();
  });

  it('开着的当天首扫 ⇒ scanned 并记本地日；同日再来 ⇒ already-scanned 不再扫', async () => {
    const database = db();
    const runScan = vi.fn(harvestDeps(database).runScan);
    expect(await maybeRunPostLaunchAutoHarvest(harvestDeps(database, { runScan }))).toBe('scanned');
    expect(runScan).toHaveBeenCalledOnce();
    expect(await maybeRunPostLaunchAutoHarvest(harvestDeps(database, { runScan }))).toBe('already-scanned');
    expect(runScan).toHaveBeenCalledOnce();
  });

  it('跨天后可以再扫（节流键是本地日不是次数）', async () => {
    const database = db();
    const runScan = vi.fn(harvestDeps(database).runScan);
    await maybeRunPostLaunchAutoHarvest(harvestDeps(database, { runScan }));
    const nextDay = NOW + 25 * HOUR;
    expect(await maybeRunPostLaunchAutoHarvest(harvestDeps(database, { runScan, now: () => nextDay }))).toBe('scanned');
    expect(runScan).toHaveBeenCalledTimes(2);
  });

  it('扫描撞锁 ⇒ locked，不记扫描日（下次还要再来）', async () => {
    const database = db();
    const outcome = await maybeRunPostLaunchAutoHarvest(harvestDeps(database, {
      runScan: async () => ({
        examinedTurns: 0, excludedTurns: 0, signalTurns: 0, sampledTurns: 0, signalOnlyTurns: 0,
        skippedTurns: 0, costUsd: 0, judgeUnavailableTurns: 0, budgetStopped: false, locked: true, dryRun: false,
      }),
    }));
    expect(outcome).toBe('locked');
    // 撞锁不记扫描日的行为级证明：换个能跑通的 runScan，同日立刻能补扫成功
    expect(await maybeRunPostLaunchAutoHarvest(harvestDeps(database))).toBe('scanned');
  });

  it('扫描抛错 ⇒ failed 且 warn 留痕，不扩散成宿主故障', async () => {
    const database = db();
    const onWarn = vi.fn();
    const outcome = await maybeRunPostLaunchAutoHarvest(harvestDeps(database, {
      runScan: async () => { throw new Error('replay store exploded'); },
      onWarn,
    }));
    expect(outcome).toBe('failed');
    expect(onWarn).toHaveBeenCalledOnce();
  });
});

describe('signalOnly 扫描 → 低分自动入候选（候选视图零改动带出）', () => {
  it('永不调 judge、落真版本低分行、候选自动入池；not-judged 行不挡人手真评补评', async () => {
    const database = db();
    const startTime = NOW - HOUR;
    insertSession(database, 'chat-auto', startTime);
    insertTurn(database, 'chat-auto', 'chat-auto-turn-1', startTime);
    const replays = { 'chat-auto': repeatLoopReplay('chat-auto', startTime) };
    const llmCall = vi.fn<PostLaunchScorerDeps['llmCall']>(async () => {
      throw new Error('signalOnly 扫描不许调 judge');
    });

    const result = await runPostLaunchScoring(scorerDeps(database, replays, llmCall), { signalOnly: true });

    expect(llmCall).not.toHaveBeenCalled();
    expect(result.signalOnlyTurns).toBe(1);
    expect(result.costUsd).toBe(0);
    const row = database.prepare(`SELECT * FROM telemetry_turn_scores WHERE turn_id = 'chat-auto-turn-1'`).get() as Record<string, unknown>;
    expect(row.judge_version).toBe(POST_LAUNCH_JUDGE_VERSION);
    expect(row.judge_model).toBe('not-judged');
    expect(JSON.parse(row.signals as string)).toContain('repeat_loop');

    // 低分行落库 ⇒ 候选视图自动带出（这就是「低分自动入候选」的咬合点）
    const candidates = listReflowCandidates(database);
    expect(candidates.map((candidate) => candidate.sessionId)).toContain('chat-auto');
    expect(candidates.find((candidate) => candidate.sessionId === 'chat-auto')?.signals).toContain('repeat_loop');

    // FB-233：not-judged 占位行不算已评，人手真评能补评（judge 被真叫到）
    const ALL_PASS = JSON.stringify({
      goal: { pass: true, why: '有来源' },
      orchestration: { pass: true, why: '' },
      tools: { pass: true, why: '' },
      permission: { pass: true, why: '' },
    });
    const realJudge = vi.fn<PostLaunchScorerDeps['llmCall']>(async () => ALL_PASS);
    const rescore = await runPostLaunchScoring(scorerDeps(database, replays, realJudge), {});
    expect(realJudge).toHaveBeenCalled();
    expect(rescore.signalTurns).toBe(1);
  });

  it('无信号的正常轮一行都不落（不进报告分母、不进遥测）——ai-review PR#2024 Important 1', async () => {
    const database = db();
    const startTime = NOW - HOUR;
    insertSession(database, 'chat-clean', startTime);
    insertTurn(database, 'chat-clean', 'chat-clean-turn-1', startTime);
    const cleanReplay: StructuredReplay = {
      sessionId: 'chat-clean',
      turns: [{
        turnNumber: 1,
        turnType: 'user',
        blocks: [
          { type: 'user', content: '帮我润色这段文案', timestamp: startTime },
          { type: 'text', content: '润色好了', timestamp: startTime + 1 },
        ],
        inputTokens: 100,
        outputTokens: 50,
        durationMs: 1000,
        startTime,
      }],
      summary: { totalTurns: 1 },
    } as unknown as StructuredReplay;
    const llmCall = vi.fn<PostLaunchScorerDeps['llmCall']>();

    const result = await runPostLaunchScoring(
      scorerDeps(database, { 'chat-clean': cleanReplay }, llmCall),
      { signalOnly: true },
    );

    expect(llmCall).not.toHaveBeenCalled();
    expect(result.signalOnlyTurns).toBe(0);
    expect(database.prepare(`SELECT COUNT(*) AS count FROM telemetry_turn_scores`).get()).toEqual({ count: 0 });
    expect(listReflowCandidates(database)).toEqual([]);
  });

  it('signalOnly 撞上 unavailable / not-judged 行也跳过不覆盖（保成本与重试证据）——ai-review PR#2024 R2 Important 2', async () => {
    const database = db();
    const startTime = NOW - HOUR;
    insertSession(database, 'chat-auto', startTime);
    insertTurn(database, 'chat-auto', 'chat-auto-turn-1', startTime);
    const replays = { 'chat-auto': repeatLoopReplay('chat-auto', startTime) };
    // 先真评一趟：judge 调用炸掉 ⇒ unavailable 行（带成本与不可用证据）。
    const explodingJudge = vi.fn<PostLaunchScorerDeps['llmCall']>(async () => { throw new Error('judge down'); });
    await runPostLaunchScoring(scorerDeps(database, replays, explodingJudge), {});
    const before = database.prepare(`SELECT judge_model, cost_usd FROM telemetry_turn_scores WHERE turn_id = 'chat-auto-turn-1'`).get() as Record<string, unknown>;
    expect(before.judge_model).toBe('unavailable');

    const llmCall = vi.fn<PostLaunchScorerDeps['llmCall']>();
    const again = await runPostLaunchScoring(scorerDeps(database, replays, llmCall), { signalOnly: true });
    expect(llmCall).not.toHaveBeenCalled();
    expect(again.skippedTurns).toBe(1);
    const after = database.prepare(`SELECT judge_model, cost_usd FROM telemetry_turn_scores WHERE turn_id = 'chat-auto-turn-1'`).get() as Record<string, unknown>;
    expect(after).toEqual(before);

    // 第一趟 signalOnly 落行后，第二趟 signalOnly 幂等跳过（自己的占位行也不覆盖）
    const fresh = db();
    insertSession(fresh, 'chat-auto', startTime);
    insertTurn(fresh, 'chat-auto', 'chat-auto-turn-1', startTime);
    await runPostLaunchScoring(scorerDeps(fresh, replays, llmCall), { signalOnly: true });
    const second = await runPostLaunchScoring(scorerDeps(fresh, replays, llmCall), { signalOnly: true });
    expect(second.skippedTurns).toBe(1);
    expect(second.signalOnlyTurns).toBe(0);
  });

  it('signalOnly 撞上已有真评行 ⇒ 跳过不覆盖（skippedTurns）', async () => {
    const database = db();
    const startTime = NOW - HOUR;
    insertSession(database, 'chat-auto', startTime);
    insertTurn(database, 'chat-auto', 'chat-auto-turn-1', startTime);
    const replays = { 'chat-auto': repeatLoopReplay('chat-auto', startTime) };
    const ALL_PASS = JSON.stringify({
      goal: { pass: true, why: '有来源' },
      orchestration: { pass: true, why: '' },
      tools: { pass: true, why: '' },
      permission: { pass: true, why: '' },
    });
    await runPostLaunchScoring(scorerDeps(database, replays, async () => ALL_PASS), {});
    const judgedModel = (database.prepare(`SELECT judge_model FROM telemetry_turn_scores WHERE turn_id = 'chat-auto-turn-1'`).get() as Record<string, unknown>).judge_model;

    const llmCall = vi.fn<PostLaunchScorerDeps['llmCall']>();
    const again = await runPostLaunchScoring(scorerDeps(database, replays, llmCall), { signalOnly: true });
    expect(llmCall).not.toHaveBeenCalled();
    expect(again.skippedTurns).toBe(1);
    const after = database.prepare(`SELECT judge_model FROM telemetry_turn_scores WHERE turn_id = 'chat-auto-turn-1'`).get() as Record<string, unknown>;
    expect(after.judge_model).toBe(judgedModel);
  });
});
