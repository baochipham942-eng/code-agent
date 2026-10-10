// ============================================================================
// decide — 批量判定（N-JEV-DECIDE-TOOL）
//
// 一批同判据的是非/单选/打分题 → 一次 Jev systemOne 调用（q1..qN 命名键，
// criteria 用 o1..oN 命名键，绝不用数组下标——探针实证下标引用会判错）。
// 每条结果带 sure（0-1）；sure < sure_min 或答案被拒收（readJevScoreAnswer 返 null /
// noul 越界 / choice 键不在 criteria 里）的条目进 needs_human，不许自动放行。
// 成功调用后按题数把 estimateJevCallUsd 的估算拆进 turn_cost_estimates
// （provider 'typesafe'，source 'catalog'），落库失败只 warn 不失败工具。
//
// 可用性：无 Jev 路由时本工具不进工具表（见 decideAvailability.ts）；handler
// 仍自查一次，被强行调用时返回清晰错误、零网络请求。
// ============================================================================

import type {
  ToolHandler,
  ToolModule,
  ToolContext,
  CanUseToolFn,
  ToolProgressFn,
  ToolResult,
} from '../../../protocol/tools';
import type { TurnCostEstimateInput } from '../../../../shared/contract/turnCost';
import { NETWORK_TOOL_TIMEOUTS } from '../../../../shared/constants/timeouts';
import {
  estimateJevCallUsd,
  readJevScoreAnswer,
  type JevAnswers,
  type JevQuestionSpec,
} from '../../../../shared/constants/jevQuestions';
import { guardSensitiveText } from '../../../security/sensitiveDataGuard';
import { resolveJevRoute, systemOne } from '../../../model/providers/typesafeProvider';
import { getDatabase } from '../../../services/core/databaseService';
import { createLogger } from '../../../services/infra/logger';
import { decideSchema as schema } from './decide.schema';

const logger = createLogger('DecideTool');

/** 输入上限（与 schema 注释一致；超限在 handler 里显式拦，不发 Jev）。 */
const DECIDE_LIMITS = {
  maxStateChars: 20_000,
  maxItems: 32,
  maxIdChars: 40,
  minChoiceOptions: 2,
  maxChoiceOptions: 8,
  minScoreTiers: 2,
  maxScoreTiers: 6,
  defaultSureMin: 0.7,
} as const;

const NO_ROUTE_ERROR =
  'decide is unavailable: no Jev route is configured. Set the TypeSafe key '
  + '(TYPESAFE_API_KEY or the typesafe service key in Settings) or the OpenRouter key in Settings, then retry.';

type DecideKind = 'yes_no' | 'choice' | 'score';

/** 判别联合：choice/score 必带 options（validateInput 已保证），buildQuestions 免断言收窄。 */
type DecideItem =
  | { id: string; kind: 'yes_no'; question: string }
  | { id: string; kind: 'choice'; question: string; options: string[] }
  | { id: string; kind: 'score'; question: string; options: string[] };

interface DecideItemResult {
  id: string;
  kind: DecideKind;
  answer: boolean | string | number | null;
  sure: number | null;
}

/** 成本落库出口；测试可注入替身（默认写 turn_cost_estimates）。 */
export interface DecideCostSink {
  insert(input: TurnCostEstimateInput): unknown;
}

const defaultCostSink: DecideCostSink = {
  insert(input) {
    getDatabase().getTurnCostRepo().insert(input);
  },
};

let costSink: DecideCostSink = defaultCostSink;

/** 测试注入/还原成本出口。传 null 还原默认 DB 落库。 */
export function setDecideCostSinkForTests(sink: DecideCostSink | null): void {
  costSink = sink ?? defaultCostSink;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function inUnitRange(value: unknown): value is number {
  return isFiniteNumber(value) && value >= 0 && value <= 1;
}

/** noul 答案校验：缺 noul / 非有限数 / 越界 ⇒ 拒收（不静默补默认值）。 */
function readNoulAnswer(value: unknown): number | null {
  if (!value || typeof value !== 'object') return null;
  const noul = (value as { noul?: unknown }).noul;
  return inUnitRange(noul) ? noul : null;
}

/** choice 答案校验：choice 必须是 criteria 里登记过的命名键，confidence 越界按无置信处理。 */
function readChoiceAnswer(value: unknown): { choice: string; confidence: number | null } | null {
  if (!value || typeof value !== 'object') return null;
  const { choice, confidence } = value as { choice?: unknown; confidence?: unknown };
  if (typeof choice !== 'string' || choice.length === 0) return null;
  return { choice, confidence: inUnitRange(confidence) ? confidence : null };
}

/** 输入校验：所有超限/形状错误在此拦下，零 systemOne 调用。 */
function validateInput(args: Record<string, unknown>): { state: string; items: DecideItem[]; sureMin: number } | { error: string } {
  const { state, items, sure_min: sureMinRaw } = args;

  if (typeof state !== 'string') {
    return { error: 'state is required and must be a string' };
  }
  if (state.length > DECIDE_LIMITS.maxStateChars) {
    return { error: `state is ${state.length} chars; the limit is ${DECIDE_LIMITS.maxStateChars}` };
  }
  if (!Array.isArray(items) || items.length === 0) {
    return { error: 'items is required and must be a non-empty array' };
  }
  if (items.length > DECIDE_LIMITS.maxItems) {
    return { error: `items has ${items.length} entries; the limit is ${DECIDE_LIMITS.maxItems} per call` };
  }

  const seenIds = new Set<string>();
  const parsed: DecideItem[] = [];
  for (const [index, raw] of items.entries()) {
    if (!raw || typeof raw !== 'object') {
      return { error: `items[${index}] must be an object` };
    }
    const item = raw as Record<string, unknown>;
    if (typeof item.id !== 'string' || item.id.length === 0) {
      return { error: `items[${index}].id must be a non-empty string` };
    }
    if (item.id.length > DECIDE_LIMITS.maxIdChars) {
      return { error: `items[${index}].id is ${item.id.length} chars; the limit is ${DECIDE_LIMITS.maxIdChars}` };
    }
    if (seenIds.has(item.id)) {
      return { error: `duplicate item id "${item.id}"; ids must be unique within one call` };
    }
    seenIds.add(item.id);
    if (item.kind !== 'yes_no' && item.kind !== 'choice' && item.kind !== 'score') {
      return { error: `items[${index}].kind must be one of: yes_no, choice, score` };
    }
    if (typeof item.question !== 'string' || item.question.length === 0) {
      return { error: `items[${index}].question must be a non-empty string` };
    }
    const options = item.options;
    if (item.kind === 'yes_no') {
      parsed.push({ id: item.id, kind: item.kind, question: item.question });
      continue;
    }
    if (!Array.isArray(options) || options.some((option) => typeof option !== 'string')) {
      return { error: `items[${index}] (${item.kind}) requires options as an array of strings` };
    }
    const min = item.kind === 'choice' ? DECIDE_LIMITS.minChoiceOptions : DECIDE_LIMITS.minScoreTiers;
    const max = item.kind === 'choice' ? DECIDE_LIMITS.maxChoiceOptions : DECIDE_LIMITS.maxScoreTiers;
    if (options.length < min || options.length > max) {
      return { error: `items[${index}] (${item.kind}) requires ${min}-${max} options, got ${options.length}` };
    }
    parsed.push({ id: item.id, kind: item.kind, question: item.question, options: options as string[] });
  }

  const sureMin = sureMinRaw === undefined ? DECIDE_LIMITS.defaultSureMin : sureMinRaw;
  if (!inUnitRange(sureMin)) {
    return { error: 'sure_min must be a number between 0 and 1' };
  }

  return { state, items: parsed, sureMin };
}

/** q<i> → 判题规格。choice criteria 用 o1..oN 命名键（禁止数组下标）。 */
function buildQuestions(
  items: readonly DecideItem[],
  guard: (value: string) => string,
): Record<string, JevQuestionSpec> {
  const questions: Record<string, JevQuestionSpec> = {};
  for (const [index, item] of items.entries()) {
    const key = `q${index + 1}`;
    const instructions = guard(item.question);
    if (item.kind === 'yes_no') {
      questions[key] = { type: 'noul', instructions };
    } else if (item.kind === 'choice') {
      const criteria: Record<string, string> = {};
      for (const [optionIndex, option] of item.options.entries()) {
        criteria[`o${optionIndex + 1}`] = guard(option);
      }
      questions[key] = { type: 'choice', instructions, criteria };
    } else {
      questions[key] = { type: 'score', instructions, criteria: item.options.map(guard) };
    }
  }
  return questions;
}

/** answers → 每条目的 answer/sure；拒收一律 sure: null（进 needs_human）。 */
function mapAnswers(
  items: readonly DecideItem[],
  questions: Record<string, JevQuestionSpec>,
  answers: JevAnswers,
): DecideItemResult[] {
  return items.map((item, index) => {
    const key = `q${index + 1}`;
    const answer = answers[key];
    if (item.kind === 'yes_no') {
      const noul = readNoulAnswer(answer);
      if (noul === null) return { id: item.id, kind: item.kind, answer: null, sure: null };
      return { id: item.id, kind: item.kind, answer: noul >= 0.5, sure: Math.max(noul, 1 - noul) };
    }
    if (item.kind === 'choice') {
      const choice = readChoiceAnswer(answer);
      if (!choice) return { id: item.id, kind: item.kind, answer: null, sure: null };
      const optionIndex = choice.choice.startsWith('o')
        ? Number.parseInt(choice.choice.slice(1), 10) - 1
        : Number.NaN;
      const optionText = item.options?.[optionIndex];
      if (!Number.isInteger(optionIndex) || optionText === undefined) {
        return { id: item.id, kind: item.kind, answer: null, sure: null };
      }
      return { id: item.id, kind: item.kind, answer: optionText, sure: choice.confidence };
    }
    const score = readJevScoreAnswer(answer, questions[key]);
    if (!score) return { id: item.id, kind: item.kind, answer: null, sure: null };
    return { id: item.id, kind: item.kind, answer: score.score, sure: score.confidence };
  });
}

/** 按题数拆成本：总额均匀拆到每题，token 余数落第一行，总和恰等于整趟估算。 */
function buildCostRows(
  sessionId: string,
  modelId: string,
  stateChars: number,
  questionsChars: number,
  itemCount: number,
): { rows: TurnCostEstimateInput[]; totalUsd: number } {
  const totalUsd = estimateJevCallUsd(stateChars, questionsChars);
  const totalTokens = Math.ceil((stateChars + questionsChars) / 4);
  const perRowTokens = Math.floor(totalTokens / itemCount);
  const firstRowTokens = totalTokens - perRowTokens * (itemCount - 1);
  const perRowUsd = totalUsd / itemCount;
  const rows = Array.from({ length: itemCount }, (_, index): TurnCostEstimateInput => ({
    sessionId,
    provider: 'typesafe',
    modelId,
    inputTokens: index === 0 ? firstRowTokens : perRowTokens,
    outputTokens: 0,
    usd: perRowUsd,
    source: 'catalog',
  }));
  return { rows, totalUsd };
}

function persistCostRows(rows: readonly TurnCostEstimateInput[]): void {
  for (const row of rows) {
    try {
      costSink.insert(row);
    } catch (error) {
      // 与 turnCostPersistence 同口径：成本落库失败绝不失败工具本身。
      logger.warn('[decide] failed to persist item cost row (ignored)', {
        sessionId: row.sessionId,
        modelId: row.modelId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
}

export async function executeDecide(
  args: Record<string, unknown>,
  ctx: ToolContext,
  canUseTool: CanUseToolFn,
  onProgress?: ToolProgressFn,
): Promise<ToolResult<string>> {
  const permit = await canUseTool(schema.name, args);
  if (!permit.allow) {
    return { ok: false, error: `permission denied: ${permit.reason}`, code: 'PERMISSION_DENIED' };
  }
  if (ctx.abortSignal.aborted) {
    return { ok: false, error: 'aborted', code: 'ABORTED' };
  }

  const validated = validateInput(args);
  if ('error' in validated) {
    return { ok: false, error: validated.error, code: 'INVALID_ARGS' };
  }

  // 路由自查（枚举处已按 isDecideToolAvailable 收敛，这里兜强行调用）：无路由零网络请求。
  const route = (() => {
    try {
      return resolveJevRoute();
    } catch {
      return null;
    }
  })();
  if (!route) {
    return { ok: false, error: NO_ROUTE_ERROR, code: 'TOOL_UNAVAILABLE' };
  }

  onProgress?.({ stage: 'starting', detail: `${schema.name}: ${validated.items.length} items` });

  // state 与每条 question（含选项/档位文本）出境前全部过脱敏守卫，与 permissionClassifierJev.buildJevState 同口径。
  const guard = (value: string) => guardSensitiveText(value, { surface: 'telemetry', mode: 'model-context' });
  const statePayload = { state: guard(validated.state) };
  const questions = buildQuestions(validated.items, guard);

  let answers: JevAnswers;
  try {
    answers = await systemOne(statePayload, questions, {
      signal: ctx.abortSignal,
      timeoutMs: NETWORK_TOOL_TIMEOUTS.DECIDE_JEV,
    });
  } catch (error) {
    const code = (error as { code?: unknown }).code;
    const codeText = typeof code === 'string' && code.length > 0 ? code : 'UNKNOWN';
    const message = error instanceof Error ? error.message : String(error);
    logger.warn('[decide] Jev systemOne call failed', { code: codeText, error: message });
    return {
      ok: false,
      error: `decide Jev call failed (Jev error code: ${codeText}): ${message}`,
      code: 'UPSTREAM_ERROR',
    };
  }

  const results = mapAnswers(validated.items, questions, answers);
  const needsHuman = results
    .filter((result) => result.sure === null || result.sure < validated.sureMin)
    .map((result) => result.id);

  const stateChars = JSON.stringify(statePayload).length;
  const questionsChars = JSON.stringify(questions).length;
  const { rows, totalUsd } = buildCostRows(
    ctx.sessionId,
    route.model,
    stateChars,
    questionsChars,
    validated.items.length,
  );
  persistCostRows(rows);

  onProgress?.({ stage: 'completing', percent: 100 });

  const payload = {
    results,
    needs_human: needsHuman,
    sure_min: validated.sureMin,
    items: validated.items.length,
    cost_usd_est: totalUsd,
  };

  return {
    ok: true,
    output: JSON.stringify(payload, null, 2),
    meta: {
      itemCount: validated.items.length,
      needsHumanCount: needsHuman.length,
      costUsdEst: totalUsd,
    },
  };
}

class DecideHandler implements ToolHandler<Record<string, unknown>, string> {
  readonly schema = schema;
  execute(
    args: Record<string, unknown>,
    ctx: ToolContext,
    canUseTool: CanUseToolFn,
    onProgress?: ToolProgressFn,
  ): Promise<ToolResult<string>> {
    return executeDecide(args, ctx, canUseTool, onProgress);
  }
}

export const decideModule: ToolModule<Record<string, unknown>, string> = {
  schema,
  createHandler() {
    return new DecideHandler();
  },
};
