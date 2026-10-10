// ============================================================================
// decide（批量判定工具）Tests — N-JEV-DECIDE-TOOL
// ----------------------------------------------------------------------------
// 覆盖四块：
//  1. 可用性：无 Jev 路由时工具不在 getDeferredToolDefinitions /
//     getLoadedDeferredToolDefinitions / ToolSearch 结果里；有路由时必须在
//     （防止"缺注册"造成的假绿）；强行调用返回清晰错误、零网络。
//  2. 30 条合成工单一趟判定：每条带 sure、needs_human 精确对账、一次 systemOne。
//  3. 成本：30 行 turn_cost_estimates，usd 总和与 estimateJevCallUsd 对账（1e-12），
//     真 in-memory TurnCostRepository 走 getTodayCost。
//  4. 上限与脱敏：超限/重复 id/选项数错误零调用；state 里的密钥出境前被抹。
// 全程 mock systemOne / resolveJevRoute / 成本出口——零真实网络、零付费调用。
// ============================================================================

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const routeMock = vi.hoisted(() => ({
  resolveJevRoute: vi.fn<() => unknown>(),
  systemOne: vi.fn(),
}));

vi.mock('../../../../../src/host/model/providers/typesafeProvider', () => ({
  resolveJevRoute: routeMock.resolveJevRoute,
  systemOne: routeMock.systemOne,
}));

vi.mock('../../../../../src/host/services/cloud', () => ({
  getCloudConfigService: () => ({ getAllToolMeta: () => ({}) }),
}));

vi.mock('../../../../../src/host/mcp', () => ({
  getMCPClient: () => ({ getToolDefinitions: () => [] }),
}));

vi.mock('../../../../../src/host/services/infra/logger', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
  createLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

vi.unmock('better-sqlite3');
import Database from 'better-sqlite3';
import type BetterSqlite3 from 'better-sqlite3';

import {
  executeDecide,
  setDecideCostSinkForTests,
  type DecideCostSink,
} from '../../../../../src/host/tools/modules/network/decide';
import {
  getDeferredToolDefinitions,
  getLoadedDeferredToolDefinitions,
} from '../../../../../src/host/tools/dispatch/toolDefinitions';
import {
  getToolSearchService,
  resetToolSearchService,
} from '../../../../../src/host/services/toolSearch/toolSearchService';
import { resetProtocolRegistry } from '../../../../../src/host/tools/protocolRegistry';
import {
  estimateJevCallUsd,
  type JevAnswers,
  type JevQuestionSpec,
} from '../../../../../src/shared/constants/jevQuestions';
import { NETWORK_TOOL_TIMEOUTS } from '../../../../../src/shared/constants/timeouts';
import type { TurnCostEstimateInput } from '../../../../../src/shared/contract/turnCost';
import type {
  CanUseToolFn,
  Logger,
  ToolContext,
} from '../../../../../src/host/protocol/tools';
import { applySchema } from '../../../../../src/host/services/core/database/schema';
import { TurnCostRepository } from '../../../../../src/host/services/core/repositories/TurnCostRepository';

const AVAILABLE_ROUTE = {
  kind: 'official',
  endpoint: 'https://api.typesafe.ai/v1/decisions',
  model: 'jev-1.13.0',
  apiKey: 'test-key',
} as const;

function makeLogger(): Logger {
  return { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

function makeCtx(overrides: Partial<ToolContext> = {}): ToolContext {
  const ctrl = new AbortController();
  return {
    sessionId: 'decide-test-session',
    workingDir: '/tmp/work',
    abortSignal: ctrl.signal,
    logger: makeLogger(),
    emit: () => void 0,
    ...overrides,
  } as unknown as ToolContext;
}

const allowAll: CanUseToolFn = async () => ({ allow: true });

// ----------------------------------------------------------------------------
// 30 条合成工单 fixture：n = 条目序号（1 基），规则定死，期望值与 mock 答案同源。
// kind 按 n % 3 轮换；sure 落在 0.7 两侧。
// ----------------------------------------------------------------------------

type FixtureKind = 'yes_no' | 'choice' | 'score';

function fixtureKind(n: number): FixtureKind {
  return n % 3 === 0 ? 'yes_no' : n % 3 === 1 ? 'choice' : 'score';
}

/** mock 侧：第 n 条该回什么原始答案。 */
function fixtureRawAnswer(n: number, kind: FixtureKind): Record<string, unknown> {
  if (kind === 'yes_no') {
    return { noul: n % 4 === 0 ? 0.96 : 0.62 };
  }
  if (kind === 'choice') {
    return { choice: 'o2', confidence: n % 5 === 0 ? 0.55 : 0.9 };
  }
  return { score: n % 5 === 0 ? 0.4 : 1.2, confidence: n % 5 === 0 ? 0.5 : 0.85 };
}

/** 期望侧：第 n 条的 sure（与工具侧映射规则一致；null = 拒收）。 */
function fixtureSure(n: number, kind: FixtureKind): number | null {
  if (kind === 'yes_no') {
    const noul = n % 4 === 0 ? 0.96 : 0.62;
    return Math.max(noul, 1 - noul);
  }
  return kind === 'choice' ? (n % 5 === 0 ? 0.55 : 0.9) : n % 5 === 0 ? 0.5 : 0.85;
}

function buildThirtyItems() {
  return Array.from({ length: 30 }, (_, index) => {
    const n = index + 1;
    const id = `T${String(n).padStart(2, '0')}`;
    const kind = fixtureKind(n);
    if (kind === 'yes_no') {
      return { id, kind, question: `工单 ${id} 是否属于账单争议？` };
    }
    if (kind === 'choice') {
      return {
        id,
        kind,
        question: `工单 ${id} 应转给哪个组处理？`,
        options: ['账务组', '技术组', '通用组'],
      };
    }
    return {
      id,
      kind,
      question: `工单 ${id} 的处理优先级打几分？`,
      options: ['低：一周内', '中：两天内', '高：当天'],
    };
  });
}

/** mock systemOne：按收到的 questions 逐 key 生成确定性答案，并捕获入参。 */
function installDeterministicSystemOne(): {
  capturedState: () => Record<string, unknown>;
  capturedQuestions: () => Record<string, JevQuestionSpec>;
} {
  let capturedState: Record<string, unknown> = {};
  let capturedQuestions: Record<string, JevQuestionSpec> = {};
  routeMock.systemOne.mockImplementation(async (
    state: Record<string, unknown>,
    questions: Record<string, JevQuestionSpec>,
  ) => {
    capturedState = state;
    capturedQuestions = questions;
    const answers: JevAnswers = {};
    for (const [key, spec] of Object.entries(questions)) {
      const n = Number.parseInt(key.slice(1), 10);
      answers[key] = fixtureRawAnswer(n, spec.type === 'noul' ? 'yes_no' : spec.type) as unknown as JevAnswers[string];
    }
    return answers;
  });
  return {
    capturedState: () => capturedState,
    capturedQuestions: () => capturedQuestions,
  };
}

describe('decide availability (route gating)', () => {
  beforeEach(() => {
    resetProtocolRegistry();
    resetToolSearchService();
    routeMock.resolveJevRoute.mockReset().mockReturnValue(null);
    routeMock.systemOne.mockReset();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('is absent from deferred definitions, loaded definitions and ToolSearch when no Jev route resolves', async () => {
    expect(getDeferredToolDefinitions().map((definition) => definition.name)).not.toContain('decide');

    const search = await getToolSearchService().searchTools('decide', { maxResults: 10 });
    expect(search.tools.map((tool) => tool.name)).not.toContain('decide');

    getToolSearchService().selectTool('decide');
    expect(getLoadedDeferredToolDefinitions().map((definition) => definition.name)).not.toContain('decide');
  });

  it('is listed and searchable once a route resolves (guards against a vacuous absent test)', async () => {
    routeMock.resolveJevRoute.mockReturnValue(AVAILABLE_ROUTE);

    expect(getDeferredToolDefinitions().map((definition) => definition.name)).toContain('decide');

    const search = await getToolSearchService().searchTools('decide', { maxResults: 10 });
    expect(search.tools.map((tool) => tool.name)).toContain('decide');

    getToolSearchService().selectTool('decide');
    expect(getLoadedDeferredToolDefinitions().map((definition) => definition.name)).toContain('decide');
  });

  it('forced execution without a route returns a clear error naming both key sources, with zero fetch and zero systemOne', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response(JSON.stringify({ answers: {} })));

    const result = await executeDecide(
      { state: '判据', items: [{ id: 'T01', kind: 'yes_no', question: 'a?' }] },
      makeCtx(),
      allowAll,
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('no Jev route is configured');
      expect(result.error).toContain('TypeSafe');
      expect(result.error).toContain('OpenRouter');
      expect(result.code).toBe('TOOL_UNAVAILABLE');
    }
    expect(routeMock.systemOne).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe('decide 30-item synthetic batch', () => {
  let rows: TurnCostEstimateInput[] = [];
  const sink: DecideCostSink = { insert: (input) => { rows.push(input); } };

  beforeEach(() => {
    routeMock.resolveJevRoute.mockReset().mockReturnValue(AVAILABLE_ROUTE);
    routeMock.systemOne.mockReset();
    installDeterministicSystemOne();
    rows = [];
    setDecideCostSinkForTests(sink);
  });
  afterEach(() => {
    setDecideCostSinkForTests(null);
  });

  it('judges 30 mixed items in one systemOne call; every result carries sure; needs_human matches sure_min exactly', async () => {
    const items = buildThirtyItems();
    const result = await executeDecide({ state: '判据：账单争议指……', items }, makeCtx(), allowAll);

    expect(result.ok).toBe(true);
    expect(routeMock.systemOne).toHaveBeenCalledTimes(1);

    const [stateArg, questionsArg, optionsArg] = routeMock.systemOne.mock.calls[0] as [
      Record<string, unknown>,
      Record<string, JevQuestionSpec>,
      { timeoutMs?: number } | undefined,
    ];
    expect(Object.keys(questionsArg)).toEqual(Array.from({ length: 30 }, (_, i) => `q${i + 1}`));
    expect(optionsArg?.timeoutMs).toBe(NETWORK_TOOL_TIMEOUTS.DECIDE_JEV);

    if (!result.ok) throw new Error('unreachable');
    const payload = JSON.parse(result.output) as {
      results: Array<{ id: string; kind: FixtureKind; answer: unknown; sure: number | null }>;
      needs_human: string[];
      sure_min: number;
      items: number;
      cost_usd_est: number;
    };

    expect(payload.items).toBe(30);
    expect(payload.sure_min).toBe(0.7);
    expect(payload.results).toHaveLength(30);
    for (const item of payload.results) {
      expect(item.sure).not.toBeNull();
    }

    const expectedNeedsHuman = items
      .filter((item) => (fixtureSure(Number(item.id.slice(1)), item.kind) ?? 0) < 0.7)
      .map((item) => item.id);
    expect(expectedNeedsHuman.length).toBeGreaterThan(0);
    expect(payload.needs_human).toEqual(expectedNeedsHuman);

    // choice 答案映射回选项文本；yes_no 映射成布尔；score 是归一化 0-1 数。
    const choiceResult = payload.results.find((r) => r.kind === 'choice')!;
    expect(choiceResult.answer).toBe('技术组');
    const yesNoResult = payload.results.find((r) => r.kind === 'yes_no')!;
    expect(typeof yesNoResult.answer).toBe('boolean');
    const scoreResult = payload.results.find((r) => r.kind === 'score')!;
    expect(typeof scoreResult.answer).toBe('number');
    expect(scoreResult.answer).toBeGreaterThanOrEqual(0);
    expect(scoreResult.answer).toBeLessThanOrEqual(1);

    // 成本：30 行，usd 总和与 estimateJevCallUsd 对账（1e-12），token 总和守恒。
    const stateChars = JSON.stringify(stateArg).length;
    const questionsChars = JSON.stringify(questionsArg).length;
    const totalUsd = estimateJevCallUsd(stateChars, questionsChars);
    expect(rows).toHaveLength(30);
    expect(rows.reduce((sum, row) => sum + (row.usd ?? 0), 0)).toBeCloseTo(totalUsd, 12);
    expect(payload.cost_usd_est).toBe(totalUsd);
    const totalTokens = Math.ceil((stateChars + questionsChars) / 4);
    expect(rows.reduce((sum, row) => sum + row.inputTokens, 0)).toBe(totalTokens);
    expect(rows[0].inputTokens).toBe(totalTokens - Math.floor(totalTokens / 30) * 29);
    expect(new Set(rows.map((row) => `${row.provider}/${row.modelId}/${row.source}/${row.outputTokens}`)))
      .toEqual(new Set(['typesafe/jev-1.13.0/catalog/0']));
  });

  it('honours a custom sure_min', async () => {
    const items = buildThirtyItems();
    const result = await executeDecide({ state: '判据', items, sure_min: 0.95 }, makeCtx(), allowAll);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('unreachable');
    const payload = JSON.parse(result.output) as {
      results: Array<{ id: string; kind: FixtureKind }>;
      needs_human: string[];
      sure_min: number;
    };
    expect(payload.sure_min).toBe(0.95);
    const expected = items
      .filter((item) => (fixtureSure(Number(item.id.slice(1)), item.kind) ?? 0) < 0.95)
      .map((item) => item.id);
    expect(payload.needs_human).toEqual(expected);
  });

  it('splits rejected answers into needs_human with sure null', async () => {
    routeMock.systemOne.mockResolvedValueOnce({
      q1: { noul: 1.5 }, // 越界 → 拒收
      q2: { choice: 'o7', confidence: 0.9 }, // 键不在 criteria → 拒收
      q3: { score: 99, confidence: 0.9 }, // readJevScoreAnswer 拒收
    });
    const result = await executeDecide(
      {
        state: '判据',
        items: [
          { id: 'A1', kind: 'yes_no', question: 'a?' },
          { id: 'A2', kind: 'choice', question: 'b?', options: ['x', 'y'] },
          { id: 'A3', kind: 'score', question: 'c?', options: ['低', '高'] },
        ],
      },
      makeCtx(),
      allowAll,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('unreachable');
    const payload = JSON.parse(result.output) as {
      results: Array<{ id: string; answer: unknown; sure: number | null }>;
      needs_human: string[];
    };
    expect(payload.results.every((r) => r.answer === null && r.sure === null)).toBe(true);
    expect(payload.needs_human).toEqual(['A1', 'A2', 'A3']);
  });
});

describe('decide limits and masking', () => {
  beforeEach(() => {
    routeMock.resolveJevRoute.mockReset().mockReturnValue(AVAILABLE_ROUTE);
    routeMock.systemOne.mockReset();
    setDecideCostSinkForTests({ insert: () => undefined });
  });
  afterEach(() => {
    setDecideCostSinkForTests(null);
  });

  it.each([
    ['33 items over the cap', {
      state: '判据',
      items: Array.from({ length: 33 }, (_, i) => ({ id: `T${i + 1}`, kind: 'yes_no' as const, question: 'q?' })),
    }, /33 entries.*32/],
    ['state of 20001 chars', {
      state: 'a'.repeat(20_001),
      items: [{ id: 'T01', kind: 'yes_no' as const, question: 'q?' }],
    }, /20001 chars.*20000/],
    ['duplicate ids', {
      state: '判据',
      items: [
        { id: 'dup', kind: 'yes_no' as const, question: 'q1?' },
        { id: 'dup', kind: 'yes_no' as const, question: 'q2?' },
      ],
    }, /duplicate item id "dup"/],
    ['choice with a single option', {
      state: '判据',
      items: [{ id: 'T01', kind: 'choice' as const, question: 'q?', options: ['唯一'] }],
    }, /choice.*requires 2-8 options.*got 1/],
    ['out-of-range sure_min', {
      state: '判据',
      items: [{ id: 'T01', kind: 'yes_no' as const, question: 'q?' }],
      sure_min: 1.5,
    }, /sure_min must be a number between 0 and 1/],
  ])('rejects %s without calling Jev', async (_name, args, pattern) => {
    const result = await executeDecide(args as Record<string, unknown>, makeCtx(), allowAll);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('INVALID_ARGS');
      expect(result.error).toMatch(pattern);
    }
    expect(routeMock.systemOne).not.toHaveBeenCalled();
  });

  it('masks a secret in state before it reaches systemOne', async () => {
    const secret = 'sk-AbCdEf1234567890GhIjKl4242MnOpQrStUvWxYz0987654321';
    let seenState = '';
    routeMock.systemOne.mockImplementationOnce(async (state: Record<string, unknown>) => {
      seenState = JSON.stringify(state);
      return { q1: { noul: 0.9 } };
    });
    const result = await executeDecide(
      { state: `判据示例，凭据 ${secret} 仅供参考`, items: [{ id: 'T01', kind: 'yes_no', question: 'q?' }] },
      makeCtx(),
      allowAll,
    );
    expect(result.ok).toBe(true);
    expect(seenState).not.toContain(secret);
    expect(seenState).toContain('sk-A');
  });

  it('returns a tool error naming the Jev error code when the whole call fails', async () => {
    const failure = new Error('systemOne HTTP 503: upstream down') as Error & { code: string };
    failure.code = 'TYPESAFE_HTTP_ERROR';
    routeMock.systemOne.mockRejectedValueOnce(failure);

    const result = await executeDecide(
      { state: '判据', items: [{ id: 'T01', kind: 'yes_no', question: 'q?' }] },
      makeCtx(),
      allowAll,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('UPSTREAM_ERROR');
      expect(result.error).toContain('TYPESAFE_HTTP_ERROR');
      expect(result.error).toContain('systemOne HTTP 503');
    }
  });

  it('keeps the tool green when cost persistence throws', async () => {
    routeMock.systemOne.mockResolvedValueOnce({ q1: { noul: 0.9 } });
    setDecideCostSinkForTests({
      insert: () => {
        throw new Error('db locked');
      },
    });
    const result = await executeDecide(
      { state: '判据', items: [{ id: 'T01', kind: 'yes_no', question: 'q?' }] },
      makeCtx(),
      allowAll,
    );
    expect(result.ok).toBe(true);
  });
});

describe('decide cost rows land in a real TurnCostRepository', () => {
  let db: BetterSqlite3.Database;
  let repo: TurnCostRepository;

  beforeEach(() => {
    routeMock.resolveJevRoute.mockReset().mockReturnValue(AVAILABLE_ROUTE);
    routeMock.systemOne.mockReset();
    installDeterministicSystemOne();
    db = new Database(':memory:');
    applySchema(db, {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    } as never);
    repo = new TurnCostRepository(db);
    setDecideCostSinkForTests({ insert: (input) => { repo.insert(input); } });
  });
  afterEach(() => {
    setDecideCostSinkForTests(null);
    db.close();
  });

  it('per-item rows are visible to getTodayCost', async () => {
    const items = buildThirtyItems().slice(0, 7);
    const result = await executeDecide({ state: '判据：账单争议……', items }, makeCtx(), allowAll);
    expect(result.ok).toBe(true);

    const [stateArg, questionsArg] = routeMock.systemOne.mock.calls[0] as [
      Record<string, unknown>,
      Record<string, JevQuestionSpec>,
    ];
    const expectedUsd = estimateJevCallUsd(
      JSON.stringify(stateArg).length,
      JSON.stringify(questionsArg).length,
    );

    const listed = repo.listBySession('decide-test-session');
    expect(listed).toHaveLength(7);
    expect(listed.every((row) => row.provider === 'typesafe' && row.modelId === 'jev-1.13.0')).toBe(true);
    const today = repo.getTodayCost();
    expect(today.usd).toBeCloseTo(expectedUsd, 12);
    expect(today.unknownTurns).toBe(0);
  });
});
