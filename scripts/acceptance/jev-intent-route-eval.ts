#!/usr/bin/env npx tsx
// ============================================================================
// Jev 意图路由 A/B 评测 —— 启发式 estimateComplexity vs 开关开的 estimateComplexityWithJev
// ============================================================================
// 输入 tests/fixtures/jev-intent-route-eval-samples.json（>=80 条，四桶），跑三段：
//   ① 仲裁标注：基线模型（解析顺序 deepseek→stepfun→moonshot→longcat，探针 1 token）
//      用一条固定 JSON 输出 prompt 独立标 complexity/high_stakes/needs_vision；
//      最终标签 = 经验规则与仲裁一致即定，不一致取仲裁并标 disputed；
//      high_stakes 取两者之并（规则 OR 仲裁）。
//   ② arm H：启发式 estimateComplexity（同步、零成本）。
//   ③ arm J：CODE_AGENT_JEV_ROUTER=1 + estimateComplexityWithJev，真 systemOne 经
//      spy 包装（捕获 state/问句字符数与答案，用于 Jev $ 与回落分类），
//      每条一个新 AdaptiveRouter 实例（缓存不跨行）。
// 输出四格表（该便宜却走贵 / 该贵却走便宜 / 高风险被降 simple【必须 0】/ 正确）+
// 成本列（主模型 $ 节省 / 返工 $ / 净额，另列 Jev $ 与仲裁 $）+ 只写建议的结论。
// JSON 由单次运行直写 docs/research/assets/2026-09-30-jev-eval/intent-route.json
// （gitHead、JEV_MODEL、逐条标签与档位，不含任何 key）。
//
// fail-loud：JEV_MODEL 不是 jev-1.13.0、DeepSeek 刊例价缺失、判官报错回落 >10%、
// 累计花费 > $1 —— 任一命中非零退出且不写 JSON。--self-check 离线断言四格/成本/
// 标签合并/回落分类/仲裁 JSON 解析，不联网、不需要 key。
//
// 用法：set -a; source ~/.code-agent/.env; set +a   # TYPESAFE_API_KEY + 基线模型 key
//       npx tsx scripts/acceptance/jev-intent-route-eval.ts tests/fixtures/jev-intent-route-eval-samples.json
//       npx tsx scripts/acceptance/jev-intent-route-eval.ts --self-check
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { execSync } from 'node:child_process';
import assert from 'node:assert/strict';

import { AdaptiveRouter } from '../../src/host/model/adaptiveRouter';
import { systemOne } from '../../src/host/model/providers/typesafeProvider';
import { DeepSeekProvider } from '../../src/host/model/providers/deepseekProvider';
import { MoonshotProvider } from '../../src/host/model/providers/moonshotProvider';
import { LongCatProvider } from '../../src/host/model/providers/longcatProvider';
import { resolveProviderApiKey } from '../../src/host/model/providers/providerResolution';
import {
  JEV_MODEL,
  JEV_ROUTER_QUESTIONS,
  JEV_ROUTER_THRESHOLDS,
  estimateJevCallUsd,
  type JevAnswers,
  type JevSystemOneCall,
} from '../../src/shared/constants/jevQuestions';
import { estimateTokens } from '../../src/host/context/tokenEstimator';
import {
  resolveModelPrice,
  estimateTurnCostUsd,
  type ModelPrice,
} from '../../src/shared/pricing/resolveModelPrice';
import type { ModelMessage } from '../../src/host/model/types';

// ----------------------------------------------------------------------------
// 类型与常量
// ----------------------------------------------------------------------------

type Level = 'simple' | 'moderate' | 'complex';
const LEVELS: readonly Level[] = ['simple', 'moderate', 'complex'];

interface RuleLabel {
  complexity: Level;
  highStakes: boolean;
  needsVision: boolean;
}

interface FixtureRow {
  id: string;
  bucket: string;
  visionShape?: string;
  messages: ModelMessage[];
  ruleLabel: RuleLabel;
}

interface ArbiterLabel {
  complexity: Level;
  high_stakes: boolean;
  needs_vision: boolean;
}

interface FinalLabel {
  complexity: Level;
  highStakes: boolean;
  needsVision: boolean;
  /** 规则与仲裁在任一字段不一致（high_stakes 并集差异不算，见 mergeLabels）。 */
  disputed: boolean;
}

/** 成本模型假设（编排 2026-09-30 拍板）：主模型一轮 = (20k 上下文 + prompt token) 入 + 800 出。 */
const MAIN_TURN_CONTEXT_TOKENS = 20_000;
const MAIN_TURN_OUTPUT_TOKENS = 800;
/** 累计花费（Jev 估算 + 仲裁实耗）超过此值即中止，非零退出不写 JSON。 */
const BUDGET_ABORT_USD = 1;
/** 判官报错回落占比超过此值 → 非零退出不写 JSON。 */
const MAX_JUDGE_ERROR_FALLBACK_RATE = 0.1;
/** 与 skill neo-gates 一致：只认 vitest/门汇总段，这里是自己脚本的汇总。 */
const DEFAULT_OUT_JSON = 'docs/research/assets/2026-09-30-jev-eval/intent-route.json';
/** 生产 pin 的 Jev 版本断言值（fail-loud：漂版本直接红）。 */
const EXPECTED_JEV_MODEL = 'jev-1.13.0';

/** 仲裁 system prompt（固定一条，逐行只替换用户消息文本）。 */
const ARBITER_SYSTEM_PROMPT = [
  'You are a strict labeling assistant for a model-routing evaluation.',
  'Read the user request and output exactly one JSON object with three fields:',
  '"complexity": "simple" for trivial chat or one obvious read-only step, "moderate" for a small well-scoped task or a few coordinated steps, "complex" for many dependent steps, broad scope, ambiguity, or high impact;',
  '"high_stakes": true if the request involves deletion, payment or money transfer, public posting or sending content to others, credential changes, or irreversible overwrite;',
  '"needs_vision": true if fulfilling the request requires seeing or understanding an image, screenshot, diagram, or visual layout.',
  'Output only the JSON object. No markdown fences, no commentary.',
].join(' ');

// ----------------------------------------------------------------------------
// 纯函数：标签合并 / 四格 / 成本 / 结论（--self-check 的被测对象，不联网）
// ----------------------------------------------------------------------------

function lastUserText(messages: ModelMessage[]): { text: string; hasImage: boolean } {
  const lastUserMsg = [...messages].reverse().find((m) => m.role === 'user');
  if (!lastUserMsg) return { text: '', hasImage: false };
  if (typeof lastUserMsg.content === 'string') return { text: lastUserMsg.content, hasImage: false };
  if (!Array.isArray(lastUserMsg.content)) return { text: '', hasImage: false };
  const text = lastUserMsg.content.filter((c) => c.type === 'text').map((c) => c.text || '').join(' ');
  return { text, hasImage: lastUserMsg.content.some((c) => c.type === 'image') };
}

/**
 * 最终标签：仲裁缺席（报错）→ 规则标签；三字段全一致 → 不 disputed；
 * 任一不一致 → 取仲裁标签并标 disputed；high_stakes 一律取规则 OR 仲裁（并集），
 * 且并集翻转不算 disputed（安全方向只升不降，规则地板本就独立于判官）。
 */
function mergeLabels(rule: RuleLabel, arbiter: ArbiterLabel | null): FinalLabel {
  if (!arbiter) {
    return { complexity: rule.complexity, highStakes: rule.highStakes, needsVision: rule.needsVision, disputed: false };
  }
  const highStakes = rule.highStakes || arbiter.high_stakes;
  const agree = rule.complexity === arbiter.complexity
    && rule.highStakes === arbiter.high_stakes
    && rule.needsVision === arbiter.needs_vision;
  return {
    complexity: agree ? rule.complexity : arbiter.complexity,
    highStakes,
    needsVision: agree ? rule.needsVision : arbiter.needs_vision,
    disputed: !agree,
  };
}

interface FourCell {
  /** 该便宜却走贵：标签 simple，档位不是 simple。 */
  cheapButExpensive: string[];
  /** 该贵却走便宜：标签不是 simple，档位 simple。 */
  expensiveButCheap: string[];
  /** 高风险被降到 simple（必须 0）：最终标签 high_stakes，档位 simple。 */
  highStakesSimple: string[];
  /** 不属于以上任一错误格的行数。 */
  correct: number;
}

function fourCell(entries: { id: string; label: FinalLabel; level: Level }[]): FourCell {
  const cell = (pred: (e: { id: string; label: FinalLabel; level: Level }) => boolean) =>
    entries.filter(pred).map((e) => e.id);
  const cheapButExpensive = cell((e) => e.label.complexity === 'simple' && e.level !== 'simple');
  const expensiveButCheap = cell((e) => e.label.complexity !== 'simple' && e.level === 'simple');
  const highStakesSimple = cell((e) => e.label.highStakes && e.level === 'simple');
  const errorIds = new Set([...cheapButExpensive, ...expensiveButCheap, ...highStakesSimple]);
  return { cheapButExpensive, expensiveButCheap, highStakesSimple, correct: entries.length - errorIds.size };
}

/** 主模型一轮的刊例成本（list price；simple 路由走免费模型计 $0，不经过本函数）。 */
function mainTurnCostUsd(promptTokens: number, price: ModelPrice): number {
  const usd = estimateTurnCostUsd(price, {
    inputTokens: MAIN_TURN_CONTEXT_TOKENS + Math.max(0, promptTokens),
    outputTokens: MAIN_TURN_OUTPUT_TOKENS,
  });
  return usd ?? 0;
}

interface CostColumns {
  /** 走 simple 的行省下的主模型一轮 $（按行 prompt token 计）。 */
  savedUsd: number;
  /** 该贵却走便宜的每条记一轮返工 $。 */
  reworkUsd: number;
  netUsd: number;
  simpleRoutes: number;
}

function costColumns(
  entries: { label: FinalLabel; level: Level; promptTokens: number }[],
  price: ModelPrice,
): CostColumns {
  let savedUsd = 0;
  let reworkUsd = 0;
  let simpleRoutes = 0;
  for (const e of entries) {
    const turnCost = mainTurnCostUsd(e.promptTokens, price);
    if (e.level === 'simple') {
      simpleRoutes += 1;
      savedUsd += turnCost;
    }
    if (e.label.complexity !== 'simple' && e.level === 'simple') reworkUsd += turnCost;
  }
  return { savedUsd, reworkUsd, netUsd: savedUsd - reworkUsd, simpleRoutes };
}

/** 结论只写建议（不改 src/、不动开关默认）：高风险降档>0 或「该贵却走便宜」比启发式多 → 不接电；
 *  「该便宜却走贵」下降且两项都不变差 → 可接电候选；其余 → 无明确建议。 */
function recommend(h: FourCell, j: FourCell): { verdict: string; rationale: string } {
  if (j.highStakesSimple.length > 0) {
    return { verdict: '不接电', rationale: `高风险被降到 simple ${j.highStakesSimple.length} 条（必须 0）：${j.highStakesSimple.join(',')}` };
  }
  if (j.expensiveButCheap.length > h.expensiveButCheap.length) {
    return { verdict: '不接电', rationale: `该贵却走便宜 ${j.expensiveButCheap.length} 条 > 启发式 ${h.expensiveButCheap.length} 条` };
  }
  if (j.cheapButExpensive.length < h.cheapButExpensive.length) {
    return { verdict: '可接电候选', rationale: `该便宜却走贵 ${j.cheapButExpensive.length} 条 < 启发式 ${h.cheapButExpensive.length} 条，且高风险降档为 0、该贵却走便宜未上升` };
  }
  return { verdict: '无明确建议', rationale: '两臂该便宜却走贵相当，其余格均未变差' };
}

// ----------------------------------------------------------------------------
// 纯函数：仲裁 JSON 解析 / Jev 回落分类
// ----------------------------------------------------------------------------

function parseArbiterJson(content: string): ArbiterLabel | null {
  const stripped = content.replace(/```json|```/gi, '').trim();
  const start = stripped.indexOf('{');
  const end = stripped.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(stripped.slice(start, end + 1));
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object') return null;
  const obj = parsed as Record<string, unknown>;
  if (!LEVELS.includes(obj.complexity as Level)) return null;
  if (typeof obj.high_stakes !== 'boolean' || typeof obj.needs_vision !== 'boolean') return null;
  return { complexity: obj.complexity as Level, high_stakes: obj.high_stakes, needs_vision: obj.needs_vision };
}

interface JevCapture {
  stateChars: number;
  questionsChars: number;
  answers?: JevAnswers;
  error?: string;
}

/**
 * arm J 回落分类：结果带 jev_intent:* 信号 → 未回落；否则按 spy 捕获归因——
 * systemOne 抛错 → judge_error；答案缺键/形状坏/choice 不在 criteria → judge_error
 * （malformed/unknown choice 都是判官报错）；形状完好仍无信号 → abstain
 * （complexity confidence < 0.6 的低置信回落，是设计内弃权不是报错）。
 */
function classifyJevFallback(capture: JevCapture | undefined, signals: string[]): 'no_fallback' | 'judge_error' | 'abstain' {
  if (signals.some((s) => s.startsWith('jev_intent:'))) return 'no_fallback';
  if (!capture) return 'judge_error';
  if (capture.error) return 'judge_error';
  const answers = capture.answers;
  if (!answers) return 'judge_error';
  const isNoul = (v: unknown): boolean => {
    if (!v || typeof v !== 'object') return false;
    const n = (v as { noul?: unknown }).noul;
    return typeof n === 'number' && Number.isFinite(n) && n >= 0 && n <= 1;
  };
  const choiceOf = (key: string): { choice: string; confidence: number } | null => {
    const v = answers[key];
    if (!v || typeof v !== 'object') return null;
    const { choice, confidence } = v as { choice?: unknown; confidence?: unknown };
    if (typeof choice !== 'string' || typeof confidence !== 'number') return null;
    if (!Number.isFinite(confidence) || confidence < 0 || confidence > 1) return null;
    return { choice, confidence };
  };
  const intent = choiceOf('intent');
  const complexity = choiceOf('complexity');
  if (!intent || !complexity || !isNoul(answers.needs_clarification) || !isNoul(answers.needs_vision) || !isNoul(answers.high_stakes)) {
    return 'judge_error';
  }
  const intentKeys = Object.keys(JEV_ROUTER_QUESTIONS.intent.criteria ?? {});
  const complexityKeys = Object.keys(JEV_ROUTER_QUESTIONS.complexity.criteria ?? {});
  if (!intentKeys.includes(intent.choice) || !complexityKeys.includes(complexity.choice)) return 'judge_error';
  // 形状完好：只剩低置信一条路会走到无信号回落。
  if (complexity.confidence < JEV_ROUTER_THRESHOLDS.minComplexityConfidence) return 'abstain';
  return 'judge_error';
}

// ----------------------------------------------------------------------------
// 基线（仲裁）模型解析：deepseek → stepfun → moonshot → longcat
// ----------------------------------------------------------------------------

interface ArbiterCallResult {
  content: string;
  inputTokens: number;
  outputTokens: number;
}

interface ArbiterBackend {
  name: string;
  model: string;
  price: ModelPrice;
  priceNote: string;
  call(messages: ModelMessage[], maxTokens: number): Promise<ArbiterCallResult>;
}

function providerBackend(input: {
  name: 'deepseek' | 'moonshot' | 'longcat';
  model: string;
  price: ModelPrice;
  priceNote: string;
  provider: DeepSeekProvider | MoonshotProvider | LongCatProvider;
}): ArbiterBackend {
  return {
    name: input.name,
    model: input.model,
    price: input.price,
    priceNote: input.priceNote,
    call: async (messages, maxTokens) => {
      const apiKey = resolveProviderApiKey({ provider: input.name, model: input.model }, { trustConfigKey: false });
      if (!apiKey) throw new Error(`${input.name} API key 未配置`);
      const response = await input.provider.inference(messages, [], {
        provider: input.name,
        model: input.model,
        apiKey,
        maxTokens,
      });
      return {
        content: response.content ?? '',
        inputTokens: response.usage?.inputTokens ?? 0,
        outputTokens: response.usage?.outputTokens ?? 0,
      };
    },
  };
}

// StepFun 不是注册 Neo provider，按 OpenAI 兼容端点裸调。
// 刊例（platform.stepfun.com/docs/zh/guides/pricing/details，2026-09-30）：
// ¥0.7/M 输入、¥0.14/M 缓存命中、¥2.1/M 输出 ≈ $0.10 / $0.02 / $0.30。
// 只在本评测脚本硬编码，不进 pricing.ts。
const STEPFUN_BASE_URL = 'https://api.stepfun.com/v1';
const STEPFUN_MODEL = 'step-3.5-flash-2603';

function stepfunBackend(apiKey: string): ArbiterBackend {
  return {
    name: 'stepfun',
    model: STEPFUN_MODEL,
    price: { modelId: STEPFUN_MODEL, source: 'user', inputPerMTok: 0.1, outputPerMTok: 0.3 },
    priceNote: '硬编码刊例 ¥0.7/¥2.1 per 1M tokens ≈ $0.10/$0.30（platform.stepfun.com 2026-09-30）',
    call: async (messages, maxTokens) => {
      const wire = messages.map((m) => ({
        role: m.role,
        content: typeof m.content === 'string' ? m.content : lastUserText([m]).text,
      }));
      const response = await fetch(`${STEPFUN_BASE_URL}/chat/completions`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: STEPFUN_MODEL, messages: wire, max_tokens: maxTokens, temperature: 0 }),
      });
      if (!response.ok) {
        const body = await response.text().catch(() => '');
        throw new Error(`stepfun HTTP ${response.status}${body ? `: ${body.slice(0, 160)}` : ''}`);
      }
      const json = await response.json() as {
        choices?: Array<{ message?: { content?: string } }>;
        usage?: { prompt_tokens?: number; completion_tokens?: number };
      };
      return {
        content: json.choices?.[0]?.message?.content ?? '',
        inputTokens: json.usage?.prompt_tokens ?? 0,
        outputTokens: json.usage?.completion_tokens ?? 0,
      };
    },
  };
}

/** 解析顺序（编排 2026-09-30 15:40 覆盖）：deepseek 探针成功 → stepfun → moonshot → longcat。 */
async function resolveArbiterBackend(): Promise<{ backend: ArbiterBackend; attempts: string[] }> {
  const attempts: string[] = [];

  const deepseekModel = 'deepseek-v4-flash';
  const deepseekKey = resolveProviderApiKey({ provider: 'deepseek', model: deepseekModel }, { trustConfigKey: false });
  if (deepseekKey) {
    const price = resolveModelPrice('deepseek', deepseekModel);
    const backend = providerBackend({
      name: 'deepseek',
      model: deepseekModel,
      price,
      priceNote: `resolveModelPrice catalog ${price.inputPerMTok}/${price.outputPerMTok} USD per Mtok`,
      provider: new DeepSeekProvider(),
    });
    try {
      await backend.call([{ role: 'user', content: 'ping' }], 1);
      attempts.push(`deepseek/${deepseekModel}: 探针成功`);
      return { backend, attempts };
    } catch (error) {
      attempts.push(`deepseek/${deepseekModel}: 探针失败 ${String(error instanceof Error ? error.message : error).slice(0, 120)}`);
    }
  } else {
    attempts.push('deepseek: DEEPSEEK_API_KEY 未配置');
  }

  const stepfunKey = process.env.STEPFUN_API_KEY;
  if (stepfunKey) {
    const backend = stepfunBackend(stepfunKey);
    try {
      await backend.call([{ role: 'user', content: 'ping' }], 1);
      attempts.push(`stepfun/${STEPFUN_MODEL}: 探针成功`);
      return { backend, attempts };
    } catch (error) {
      attempts.push(`stepfun/${STEPFUN_MODEL}: 探针失败 ${String(error instanceof Error ? error.message : error).slice(0, 120)}`);
    }
  } else {
    attempts.push('stepfun: STEPFUN_API_KEY 未配置');
  }

  const moonshotModel = 'kimi-k2.6';
  const moonshotKey = resolveProviderApiKey({ provider: 'moonshot', model: moonshotModel }, { trustConfigKey: false });
  if (moonshotKey) {
    const backend = providerBackend({
      name: 'moonshot',
      model: moonshotModel,
      price: { modelId: moonshotModel, source: 'user', inputPerMTok: 0.6, outputPerMTok: 2.5 },
      priceNote: '硬编码刊例 $0.60/$2.50 per Mtok（任务书 2026-09-30）',
      provider: new MoonshotProvider(),
    });
    try {
      await backend.call([{ role: 'user', content: 'ping' }], 1);
      attempts.push(`moonshot/${moonshotModel}: 探针成功`);
      return { backend, attempts };
    } catch (error) {
      attempts.push(`moonshot/${moonshotModel}: 探针失败 ${String(error instanceof Error ? error.message : error).slice(0, 120)}`);
    }
  } else {
    attempts.push('moonshot: MOONSHOT_API_KEY 未配置');
  }

  const longcatModel = 'LongCat-2.0';
  const longcatKey = resolveProviderApiKey({ provider: 'longcat', model: longcatModel }, { trustConfigKey: false });
  if (longcatKey) {
    const backend = providerBackend({
      name: 'longcat',
      model: longcatModel,
      price: resolveModelPrice('longcat', longcatModel),
      priceNote: 'resolveModelPrice catalog（免费额度，价 0，token 照计）',
      provider: new LongCatProvider(),
    });
    try {
      await backend.call([{ role: 'user', content: 'ping' }], 1);
      attempts.push(`longcat/${longcatModel}: 探针成功`);
      return { backend, attempts };
    } catch (error) {
      attempts.push(`longcat/${longcatModel}: 探针失败 ${String(error instanceof Error ? error.message : error).slice(0, 120)}`);
    }
  } else {
    attempts.push('longcat: LONGCAT_API_KEY 未配置');
  }

  console.error(attempts.join('\n'));
  console.error('FAIL: 没有可用的基线（仲裁）模型：deepseek 探针失败且 stepfun/moonshot/longcat 均不可用');
  process.exit(1);
}

// ----------------------------------------------------------------------------
// 夹具校验 / 并发工具
// ----------------------------------------------------------------------------

function loadFixture(file: string): FixtureRow[] {
  const rows = JSON.parse(fs.readFileSync(file, 'utf8')) as FixtureRow[];
  const bucketOf = (name: string) => rows.filter((r) => r.bucket === name).length;
  const visionImage = rows.filter((r) => lastUserText(r.messages).hasImage).length;
  const visionText = rows.filter((r) => r.bucket === 'vision' && !lastUserText(r.messages).hasImage).length;
  const highStakes = rows.filter((r) => r.ruleLabel.highStakes).length;
  const problems: string[] = [];
  if (rows.length < 80) problems.push(`总行数 ${rows.length} < 80`);
  for (const bucket of ['chitchat', 'refactor', 'vision', 'writedisk']) {
    if (bucketOf(bucket) < 20) problems.push(`桶 ${bucket} 只有 ${bucketOf(bucket)} 行 < 20`);
  }
  if (visionImage < 10) problems.push(`带图行 ${visionImage} < 10`);
  if (visionText < 10) problems.push(`纯文字视觉行 ${visionText} < 10`);
  if (highStakes < 12) problems.push(`高风险行 ${highStakes} < 12`);
  for (const row of rows) {
    if (!LEVELS.includes(row.ruleLabel.complexity)) problems.push(`${row.id} complexity 非法`);
    if (!lastUserText(row.messages).text && !lastUserText(row.messages).hasImage) problems.push(`${row.id} 无用户消息`);
  }
  if (new Set(rows.map((r) => r.id)).size !== rows.length) problems.push('id 重复');
  if (problems.length > 0) {
    console.error(`FAIL: 夹具不达标：\n  ${problems.join('\n  ')}`);
    process.exit(1);
  }
  return rows;
}

async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      results[index] = await fn(items[index], index);
    }
  });
  await Promise.all(workers);
  return results;
}

// ----------------------------------------------------------------------------
// --self-check（离线，不联网、不需要 key）
// ----------------------------------------------------------------------------

function runSelfCheck(): void {
  assert.equal(JEV_MODEL, EXPECTED_JEV_MODEL, 'fail-loud 前置：JEV_MODEL 必须 pin 在 jev-1.13.0');
  const deepseekPrice = resolveModelPrice('deepseek', 'deepseek-v4-flash');
  assert.notEqual(deepseekPrice.inputPerMTok, undefined, 'DeepSeek 刊例输入价缺失');
  assert.notEqual(deepseekPrice.outputPerMTok, undefined, 'DeepSeek 刊例输出价缺失');

  // mergeLabels：一致 / 不一致取仲裁 + disputed / high_stakes 并集 / 仲裁缺席回规则。
  const rule: RuleLabel = { complexity: 'simple', highStakes: false, needsVision: false };
  assert.deepEqual(
    mergeLabels(rule, { complexity: 'simple', high_stakes: false, needs_vision: false }),
    { complexity: 'simple', highStakes: false, needsVision: false, disputed: false },
  );
  const disagreed = mergeLabels(rule, { complexity: 'complex', high_stakes: true, needs_vision: false });
  assert.equal(disagreed.complexity, 'complex');
  assert.equal(disagreed.disputed, true);
  assert.equal(disagreed.highStakes, true, 'high_stakes 取并集');
  const unionOnly = mergeLabels(rule, { complexity: 'simple', high_stakes: true, needs_vision: false });
  assert.deepEqual(
    { hs: unionOnly.highStakes, d: unionOnly.disputed },
    { hs: true, d: true },
    '并集翻转也随 disputed（复杂度一致但 high_stakes 不一致）',
  );
  assert.deepEqual(mergeLabels(rule, null).complexity, 'simple', '仲裁缺席回规则标签');

  // fourCell：四类各一 + cell2/cell3 重叠 + correct 排除错误行。
  const label = (c: Level, hs: boolean): FinalLabel => ({ complexity: c, highStakes: hs, needsVision: false, disputed: false });
  const cell = fourCell([
    { id: 'ok-cheap', label: label('simple', false), level: 'simple' },
    { id: 'ok-rich', label: label('complex', false), level: 'complex' },
    { id: 'c1', label: label('simple', false), level: 'moderate' },
    { id: 'c2', label: label('moderate', false), level: 'simple' },
    { id: 'c3', label: label('moderate', true), level: 'simple' },
    { id: 'c3-only', label: label('simple', true), level: 'simple' },
  ]);
  assert.deepEqual(cell.cheapButExpensive, ['c1']);
  assert.deepEqual(cell.expensiveButCheap, ['c2', 'c3']);
  assert.deepEqual(cell.highStakesSimple, ['c3', 'c3-only'], 'c3 同时落 cell2/cell3');
  assert.equal(cell.correct, 2);

  // 成本：手算对照 estimateTurnCostUsd；列汇总覆盖省/返工/净额。
  const price: ModelPrice = { modelId: 'x', source: 'user', inputPerMTok: 0.3, outputPerMTok: 1.2 };
  const one = mainTurnCostUsd(100, price);
  assert.ok(Math.abs(one - ((20_100 / 1e6) * 0.3 + (800 / 1e6) * 1.2)) < 1e-12, '主模型一轮成本公式');
  const costs = costColumns(
    [
      { label: label('simple', false), level: 'simple', promptTokens: 100 },
      { label: label('complex', false), level: 'complex', promptTokens: 100 },
      { label: label('moderate', false), level: 'simple', promptTokens: 300 },
    ],
    price,
  );
  assert.equal(costs.simpleRoutes, 2);
  assert.ok(Math.abs(costs.savedUsd - (one + mainTurnCostUsd(300, price))) < 1e-12);
  assert.ok(Math.abs(costs.reworkUsd - mainTurnCostUsd(300, price)) < 1e-12, '只有该贵却走便宜记返工');
  assert.ok(Math.abs(costs.netUsd - (costs.savedUsd - costs.reworkUsd)) < 1e-12);

  // recommend 四分支。
  const fc = (a: number, b: number, c: number): FourCell => ({
    cheapButExpensive: Array.from({ length: a }, (_, i) => `x${i}`),
    expensiveButCheap: Array.from({ length: b }, (_, i) => `x${i}`),
    highStakesSimple: Array.from({ length: c }, (_, i) => `x${i}`),
    correct: 10,
  });
  assert.equal(recommend(fc(5, 1, 0), fc(3, 1, 0)).verdict, '可接电候选');
  assert.equal(recommend(fc(5, 1, 0), fc(3, 1, 1)).verdict, '不接电');
  assert.equal(recommend(fc(5, 1, 0), fc(5, 2, 0)).verdict, '不接电');
  assert.equal(recommend(fc(5, 1, 0), fc(5, 1, 0)).verdict, '无明确建议');

  // 仲裁 JSON 解析：净 JSON / 带围栏 / 前后噪声 / 坏形状。
  assert.deepEqual(
    parseArbiterJson('{"complexity":"moderate","high_stakes":false,"needs_vision":true}'),
    { complexity: 'moderate', high_stakes: false, needs_vision: true },
  );
  assert.deepEqual(
    parseArbiterJson('```json\n{"complexity":"simple","high_stakes":true,"needs_vision":false}\n```'),
    { complexity: 'simple', high_stakes: true, needs_vision: false },
  );
  assert.equal(parseArbiterJson('标签如下 {"complexity":"simple"} 缺字段'), null);
  assert.equal(parseArbiterJson('不是 JSON'), null);
  assert.equal(parseArbiterJson('{"complexity":"banana","high_stakes":false,"needs_vision":false}'), null);

  // classifyJevFallback：未回落 / 报错 / 坏形状 / 弃权。
  assert.equal(classifyJevFallback(undefined, ['jev_intent:chat']), 'no_fallback');
  assert.equal(classifyJevFallback({ stateChars: 1, questionsChars: 1, error: 'boom' }, []), 'judge_error');
  assert.equal(classifyJevFallback({ stateChars: 1, questionsChars: 1 }, []), 'judge_error', '无答案即坏形状');
  const goodAnswers: JevAnswers = {
    intent: { choice: 'chat', confidence: 0.9 },
    complexity: { choice: 'simple', confidence: 0.5 },
    needs_clarification: { noul: 0.1 },
    needs_vision: { noul: 0.1 },
    high_stakes: { noul: 0.1 },
  };
  assert.equal(classifyJevFallback({ stateChars: 1, questionsChars: 1, answers: goodAnswers }, []), 'abstain');
  const badChoice: JevAnswers = { ...goodAnswers, intent: { choice: 'не-в-списке', confidence: 0.9 } };
  assert.equal(classifyJevFallback({ stateChars: 1, questionsChars: 1, answers: badChoice }, []), 'judge_error');

  console.log('self-check OK：标签合并 / 四格 / 成本 / 结论 / 仲裁解析 / 回落分类 全部断言通过（离线）');
}

// ----------------------------------------------------------------------------
// 主流程
// ----------------------------------------------------------------------------

function parseCliArgs(argv: string[]): { selfCheck: boolean; fixture?: string; out: string } {
  const rest = argv.filter((a) => !a.startsWith('--'));
  const outArg = argv.find((a) => a.startsWith('--out='));
  return {
    selfCheck: argv.includes('--self-check'),
    fixture: rest[0],
    out: outArg ? outArg.slice('--out='.length) : DEFAULT_OUT_JSON,
  };
}

function gitHead(): string {
  try {
    return execSync('git rev-parse HEAD', { encoding: 'utf8' }).trim();
  } catch {
    return 'unknown';
  }
}

function failLoud(message: string): never {
  console.error(`FAIL: ${message}（非零退出，不写 JSON）`);
  process.exit(1);
}

async function main(): Promise<void> {
  const args = parseCliArgs(process.argv.slice(2));
  if (args.selfCheck) {
    runSelfCheck();
    return;
  }
  if (!args.fixture) {
    console.error('用法：npx tsx scripts/acceptance/jev-intent-route-eval.ts <fixture.json> [--self-check] [--out=<path>]');
    process.exit(1);
  }

  // fail-loud 前置：版本 pin + 刊例价在。
  if (JEV_MODEL !== EXPECTED_JEV_MODEL) failLoud(`JEV_MODEL=${JEV_MODEL} 不是 ${EXPECTED_JEV_MODEL}`);
  const deepseekPrice = resolveModelPrice('deepseek', 'deepseek-v4-flash');
  if (deepseekPrice.inputPerMTok === undefined || deepseekPrice.outputPerMTok === undefined) {
    failLoud('DeepSeek deepseek-v4-flash 刊例价缺失（pricing.ts）');
  }

  const rows = loadFixture(args.fixture);
  const { backend, attempts } = await resolveArbiterBackend();
  console.log(`仲裁模型：${backend.name}/${backend.model}（${backend.priceNote}）`);
  for (const line of attempts) console.log(`  探针：${line}`);

  // ---- arm H：启发式（零成本，先跑）----
  const heuristicResults = rows.map((row) => {
    const result = new AdaptiveRouter().estimateComplexity(row.messages);
    return { id: row.id, level: result.level, score: result.score, signals: result.signals };
  });

  // ---- arm J：开关开 + 真 systemOne 经 spy，每行新路由器（缓存不跨行）----
  const captures = new Map<string, JevCapture>();
  const spyFor = (rowId: string): JevSystemOneCall => async (state, questions, options) => {
    const capture: JevCapture = {
      stateChars: JSON.stringify(state).length,
      questionsChars: JSON.stringify(questions).length,
    };
    captures.set(rowId, capture);
    try {
      const answers = await systemOne(state, questions, options);
      capture.answers = answers;
      return answers;
    } catch (error) {
      capture.error = String(error).slice(0, 160);
      throw error;
    }
  };
  const previousFlag = process.env.CODE_AGENT_JEV_ROUTER;
  process.env.CODE_AGENT_JEV_ROUTER = '1';
  let jevResults: { id: string; level: Level; score: number; signals: string[] }[];
  try {
    jevResults = await mapLimit(rows, 4, async (row) => {
      const result = await new AdaptiveRouter().estimateComplexityWithJev(row.messages, spyFor(row.id));
      return { id: row.id, level: result.level, score: result.score, signals: result.signals };
    });
  } finally {
    if (previousFlag === undefined) delete process.env.CODE_AGENT_JEV_ROUTER;
    else process.env.CODE_AGENT_JEV_ROUTER = previousFlag;
  }

  // ---- fail-loud：判官报错回落率（在写任何 JSON / 花仲裁 $ 之前）----
  const fallbackClass = jevResults.map((r) => ({
    id: r.id,
    cls: classifyJevFallback(captures.get(r.id), r.signals),
  }));
  const judgeErrors = fallbackClass.filter((f) => f.cls === 'judge_error');
  const abstains = fallbackClass.filter((f) => f.cls === 'abstain');
  const judgeErrorRate = judgeErrors.length / rows.length;
  console.log(`arm J 回落：judge_error=${judgeErrors.length} abstain=${abstains.length} / ${rows.length}`);
  if (judgeErrorRate > MAX_JUDGE_ERROR_FALLBACK_RATE) {
    failLoud(`判官报错回落 ${judgeErrors.length}/${rows.length} = ${(judgeErrorRate * 100).toFixed(1)}% > 10%`);
  }

  // ---- Jev $（刊例估算；missingKey 未发请求不计费）----
  let jevUsd = 0;
  for (const capture of captures.values()) {
    if (capture.error && capture.error.includes('TYPESAFE_API_KEY 未配置')) continue;
    jevUsd += estimateJevCallUsd(capture.stateChars, capture.questionsChars);
  }
  if (jevUsd > BUDGET_ABORT_USD) failLoud(`Jev 估算累计 $${jevUsd.toFixed(4)} 超预算 $${BUDGET_ABORT_USD}`);

  // ---- 仲裁标注：固定 prompt，逐行独立 ----
  const arbiterResults = await mapLimit(rows, 4, async (row) => {
    const { text, hasImage } = lastUserText(row.messages);
    const userContent = `Label this request.\n${text}${hasImage ? '\n[an image is attached to this message]' : ''}`;
    const messages: ModelMessage[] = [
      { role: 'system', content: ARBITER_SYSTEM_PROMPT },
      { role: 'user', content: userContent },
    ];
    try {
      const result = await backend.call(messages, 512);
      return { id: row.id, label: parseArbiterJson(result.content), inputTokens: result.inputTokens, outputTokens: result.outputTokens, raw: result.content };
    } catch (error) {
      return { id: row.id, label: null, inputTokens: 0, outputTokens: 0, raw: `ERROR ${String(error).slice(0, 120)}` };
    }
  });
  let arbiterUsd = 0;
  for (const result of arbiterResults) {
    arbiterUsd += estimateTurnCostUsd(backend.price, {
      inputTokens: result.inputTokens,
      outputTokens: result.outputTokens,
    }) ?? 0;
  }
  if (jevUsd + arbiterUsd > BUDGET_ABORT_USD) {
    failLoud(`累计花费 $${(jevUsd + arbiterUsd).toFixed(4)} 超预算 $${BUDGET_ABORT_USD}（Jev $${jevUsd.toFixed(4)} + 仲裁 $${arbiterUsd.toFixed(4)}）`);
  }

  // ---- 标签合并 + 四格 + 成本 + 结论 ----
  const arbiterById = new Map(arbiterResults.map((r) => [r.id, r]));
  const labeled = rows.map((row) => ({
    row,
    arbiter: arbiterById.get(row.id)?.label ?? null,
    final: mergeLabels(row.ruleLabel, arbiterById.get(row.id)?.label ?? null),
    promptTokens: estimateTokens(lastUserText(row.messages).text),
  }));
  const agreed = labeled.filter((e) => !e.final.disputed && e.arbiter !== null).length;
  const arbiterErrors = labeled.filter((e) => e.arbiter === null).length;

  const heuristicById = new Map(heuristicResults.map((r) => [r.id, r]));
  const jevById = new Map(jevResults.map((r) => [r.id, r]));
  const cellEntries = (levelOf: (id: string) => Level) => labeled.map((e) => ({
    id: e.row.id,
    label: e.final,
    level: levelOf(e.row.id),
  }));
  const hCell = fourCell(cellEntries((id) => heuristicById.get(id)?.level ?? 'moderate'));
  const jCell = fourCell(cellEntries((id) => jevById.get(id)?.level ?? 'moderate'));
  const costEntries = (levelOf: (id: string) => Level) => labeled.map((e) => ({
    label: e.final,
    level: levelOf(e.row.id),
    promptTokens: e.promptTokens,
  }));
  const hCost = costColumns(costEntries((id) => heuristicById.get(id)?.level ?? 'moderate'), backend.price);
  const jCost = costColumns(costEntries((id) => jevById.get(id)?.level ?? 'moderate'), backend.price);
  const verdict = recommend(hCell, jCell);

  // ---- 汇总输出 + JSON ----
  const fmt = (ids: string[]) => `${ids.length}${ids.length ? ` (${ids.slice(0, 8).join(',')}${ids.length > 8 ? ',…' : ''})` : ''}`;
  console.log(`\nn=${rows.length} 仲裁=${backend.name}/${backend.model} 标签一致=${agreed}/${rows.length} disputed=${labeled.filter((e) => e.final.disputed).length} 仲裁错误=${arbiterErrors}`);
  console.log(`四格 arm H（启发式）: 该便宜却走贵=${fmt(hCell.cheapButExpensive)} 该贵却走便宜=${fmt(hCell.expensiveButCheap)} 高风险被降simple(必须0)=${fmt(hCell.highStakesSimple)} 正确=${hCell.correct}`);
  console.log(`四格 arm J（Jev）: 该便宜却走贵=${fmt(jCell.cheapButExpensive)} 该贵却走便宜=${fmt(jCell.expensiveButCheap)} 高风险被降simple(必须0)=${fmt(jCell.highStakesSimple)} 正确=${jCell.correct}`);
  console.log(`成本（${backend.name} 刊例 ${backend.price.inputPerMTok}/${backend.price.outputPerMTok} USD/Mtok，主模型一轮=(${MAIN_TURN_CONTEXT_TOKENS}+promptTok)入+${MAIN_TURN_OUTPUT_TOKENS}出，simple 走免费模型 $0）:`);
  console.log(`  arm H: 节省=$${hCost.savedUsd.toFixed(4)} 返工=$${hCost.reworkUsd.toFixed(4)} 净额=$${hCost.netUsd.toFixed(4)} simple路由=${hCost.simpleRoutes}/${rows.length}`);
  console.log(`  arm J: 节省=$${jCost.savedUsd.toFixed(4)} 返工=$${jCost.reworkUsd.toFixed(4)} 净额=$${jCost.netUsd.toFixed(4)} simple路由=${jCost.simpleRoutes}/${rows.length}`);
  console.log(`  Jev $（arm J，estimateJevCallUsd 刊例）=$${jevUsd.toFixed(4)}；仲裁 $（实耗 usage×刊例）=$${arbiterUsd.toFixed(4)}；累计=$${(jevUsd + arbiterUsd).toFixed(4)}（预算上限 $${BUDGET_ABORT_USD}）`);
  console.log(`结论（只写建议）：${verdict.verdict} —— ${verdict.rationale}`);

  const report = {
    generatedAt: new Date().toISOString(),
    gitHead: gitHead(),
    jevModel: JEV_MODEL,
    fixture: {
      path: path.normalize(args.fixture),
      rows: rows.length,
      buckets: Object.fromEntries(['chitchat', 'refactor', 'vision', 'writedisk'].map((b) => [b, rows.filter((r) => r.bucket === b).length])),
      visionImage: rows.filter((r) => lastUserText(r.messages).hasImage).length,
      visionText: rows.filter((r) => r.bucket === 'vision' && !lastUserText(r.messages).hasImage).length,
      highStakes: rows.filter((r) => r.ruleLabel.highStakes).length,
    },
    arbiter: {
      backend: backend.name,
      model: backend.model,
      price: { inputPerMTok: backend.price.inputPerMTok, outputPerMTok: backend.price.outputPerMTok, source: backend.price.source },
      priceNote: backend.priceNote,
      probeAttempts: attempts,
      systemPrompt: ARBITER_SYSTEM_PROMPT,
      agreed,
      disputed: labeled.filter((e) => e.final.disputed).length,
      errors: arbiterErrors,
      usd: arbiterUsd,
    },
    jev: {
      calls: captures.size,
      judgeErrorFallbacks: judgeErrors.length,
      abstainFallbacks: abstains.length,
      usdEstimate: jevUsd,
      budgetAbortUsd: BUDGET_ABORT_USD,
    },
    costModel: {
      mainTurnContextTokens: MAIN_TURN_CONTEXT_TOKENS,
      mainTurnOutputTokens: MAIN_TURN_OUTPUT_TOKENS,
      simpleRouteCostUsd: 0,
      reworkRule: '该贵却走便宜每条记一轮返工',
    },
    labels: labeled.map((e) => ({
      id: e.row.id,
      bucket: e.row.bucket,
      ruleLabel: e.row.ruleLabel,
      arbiterLabel: e.arbiter,
      finalLabel: e.final,
      arbiterRaw: arbiterById.get(e.row.id)?.raw?.slice(0, 200),
    })),
    arms: {
      heuristic: {
        rows: heuristicResults,
        fourCell: hCell,
        costs: hCost,
      },
      jev: {
        rows: jevResults.map((r) => ({
          ...r,
          fallbackClass: fallbackClass.find((f) => f.id === r.id)?.cls,
        })),
        fourCell: jCell,
        costs: jCost,
      },
    },
    recommendation: verdict,
  };
  const outPath = path.resolve(args.out);
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(report, null, 2));
  console.log(`\njson=${outPath}`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exit(1);
});
