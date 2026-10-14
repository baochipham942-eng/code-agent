#!/usr/bin/env npx tsx
// ============================================================================
// delegate-routing-ab — N-DELEGATE-SESSION-K1-AB（ADR-072 D4/Q4 的施工 A/B）
// ============================================================================
// 主模型 vs 快速档做「要不要委托、委托给谁」的决策对比，数据 + 脚本，不改
// 任何产品默认。K2 用这份结果拍默认档位与是否给「路由专用模型」设置入口。
//
// 输入 tests/fixtures/delegate-routing-ab-samples.json（>=30 条，六类结果）。
// 每条样本 × 每个 arm 恰好一次 OpenAI 兼容 chat/completions 调用：真实工具
// schema（从 src 的 schema 文件 import）+ 按真实 list_session_candidates 输出
// 形状渲染的候选列表，tool_choice=auto、temperature=0。只看第一个 tool call
// （或其缺席）：action 与 candidateRef 都对才算对；delegate_existing 打错
// 候选 = harmful error，与其他 miss 分开报。
//
// Arm（订阅席，flat：token 照计，参考价按公开刊例，同 _jev-real-sites-lib）：
//   main = glm-5.3 @ 智谱 Coding Plan（ZHIPU_CODING_API_KEY）
//   fast = DEFAULT_MODELS.quick 同端点同 key（1-token 探针成功才用）；探针失败
//          回落 step-3.5-flash @ StepFun step plan（STEPFUN_API_KEY），并在输出
//          里记录「快速档换了模型家族」这一 confound。
//
// fail-loud：夹具不达标（<30 条 / 缺结果类 / delegate_existing|create_new|
// no_delegation 任一 <4 条 / 歧义样本 <4）、key 未配置、快速档两个选项都探针
// 失败、任一 arm 传输错误 >10% —— 非零退出且不写 JSON。
//
// --self-check 离线跑（无 key、不联网），断言打分器 / 百分位 / 夹具校验 / 汇总。
//
// 用法：set -a; source ~/.code-agent/.env; set +a   # ZHIPU_CODING_API_KEY (+ STEPFUN_API_KEY)
//       npx tsx scripts/acceptance/delegate-routing-ab.ts [fixture.json] [--out <path>]
//       npx tsx scripts/acceptance/delegate-routing-ab.ts --self-check
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { execSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import assert from 'node:assert/strict';

import { delegateSessionSchema } from '../../src/host/tools/modules/delegation/delegateSession.schema';
import { listSessionCandidatesSchema } from '../../src/host/tools/modules/delegation/listSessionCandidates.schema';
import { DEFAULT_MODELS } from '../../src/shared/constants/models';
import { ZHIPU_CODING_TIER, STEPFUN_TIER, referencePriceCost } from './_jev-real-sites-lib';
import { resolveStepfunBaseUrl } from './stepfunEndpoint';

// ----------------------------------------------------------------------------
// 类型与实验常量（script-local，非业务常量——同 jev-browser-step-real-sites 的口径）
// ----------------------------------------------------------------------------

export type DelegateRoutingAction =
  | 'delegate_existing'
  | 'create_new'
  | 'no_delegation'
  | 'stop'
  | 'resume'
  | 'correct';

export const DELEGATE_ROUTING_ACTIONS: readonly DelegateRoutingAction[] = [
  'delegate_existing', 'create_new', 'no_delegation', 'stop', 'resume', 'correct',
];

export interface DelegateRoutingCandidate {
  candidateRef: string;
  shortName: string;
  workspaceName: string;
  status: 'running' | 'idle';
  freshness: '1h' | '1d' | '7d' | 'older';
}

export interface DelegateRoutingDelegation {
  delegationId: string;
  targetShortName: string;
  status: 'active' | 'stopped';
}

export interface DelegateRoutingExpected {
  action: DelegateRoutingAction;
  /** 仅 delegate_existing：期望命中的精确 candidateRef。 */
  candidateRef?: string;
}

export interface DelegateRoutingSample {
  id: string;
  message: string;
  candidates: DelegateRoutingCandidate[];
  activeDelegations?: DelegateRoutingDelegation[];
  expected: DelegateRoutingExpected;
  ambiguous?: boolean;
}

/** 模型侧的预测：第一个 tool call（含解析出的参数），或没有任何 tool call。 */
export type DelegateRoutingPrediction =
  | { kind: 'no_tool_call' }
  | {
      kind: 'tool_call';
      tool: string;
      action?: string;
      candidateRef?: string;
      delegationId?: string;
      /** tool call 的 arguments 不是可解析对象时为 false。 */
      argsOk: boolean;
    };

export type DelegateRoutingOutcome = 'correct' | 'harmful_wrong_candidate' | 'miss';

export interface DelegateRoutingArmRow {
  id: string;
  outcome: DelegateRoutingOutcome;
  latencyMs: number | null;
  tokensIn: number;
  tokensOut: number;
  transportError: boolean;
}

export interface DelegateRoutingArmSummary {
  samples: number;
  correct: number;
  harmfulWrongCandidate: number;
  misses: number;
  accuracy: number;
  harmfulErrorRate: number;
  p50Ms: number;
  p95Ms: number;
  avgTokensIn: number;
  avgTokensOut: number;
  transportErrors: number;
  transportErrorRate: number;
}

const MIN_SAMPLES = 30;
const MIN_PER_REQUIRED_CLASS = 4;
const MIN_AMBIGUOUS = 4;
const MAX_TRANSPORT_ERROR_RATE = 0.1;
const MAX_OUTPUT_TOKENS = 2048;
const CALL_TIMEOUT_MS = 60_000;
const CONCURRENCY = 4;
const CANDIDATE_REF_PATTERN = /^[A-Za-z0-9_-]{16}$/;
const DEFAULT_FIXTURE = 'tests/fixtures/delegate-routing-ab-samples.json';
const DEFAULT_OUT_JSON = 'docs/research/assets/2026-10-delegate-routing-ab/results.json';

// ----------------------------------------------------------------------------
// 纯打分器（--self-check 与单测的被测对象；不联网）
// ----------------------------------------------------------------------------

/** 从 OpenAI 兼容 chat/completions 响应体取第一个 tool call（或其缺席）。 */
export function parseFirstToolCall(payload: unknown): DelegateRoutingPrediction {
  if (!payload || typeof payload !== 'object') return { kind: 'no_tool_call' };
  const choices = (payload as { choices?: unknown }).choices;
  if (!Array.isArray(choices) || choices.length === 0) return { kind: 'no_tool_call' };
  const message = (choices[0] as { message?: unknown })?.message;
  if (!message || typeof message !== 'object') return { kind: 'no_tool_call' };
  const toolCalls = (message as { tool_calls?: unknown }).tool_calls;
  if (!Array.isArray(toolCalls) || toolCalls.length === 0) return { kind: 'no_tool_call' };
  const first = toolCalls[0] as { function?: { name?: unknown; arguments?: unknown } };
  const fn = first?.function;
  if (!fn || typeof fn.name !== 'string' || fn.name === '') return { kind: 'no_tool_call' };

  let args: Record<string, unknown> | null = null;
  if (typeof fn.arguments === 'string' && fn.arguments.trim() !== '') {
    try {
      const parsed: unknown = JSON.parse(fn.arguments);
      args = parsed && typeof parsed === 'object' && !Array.isArray(parsed)
        ? parsed as Record<string, unknown>
        : null;
    } catch {
      args = null;
    }
  } else if (fn.arguments && typeof fn.arguments === 'object' && !Array.isArray(fn.arguments)) {
    args = fn.arguments as Record<string, unknown>;
  }

  const strField = (key: string): string | undefined => {
    const value = args?.[key];
    return typeof value === 'string' && value !== '' ? value : undefined;
  };
  return {
    kind: 'tool_call',
    tool: fn.name,
    action: strField('action'),
    candidateRef: strField('candidateRef'),
    delegationId: strField('delegationId'),
    argsOk: args !== null,
  };
}

/**
 * 打分：correct = action 与 candidateRef 都命中 expected；harmful_wrong_candidate =
 * 模型发出了 delegate_existing 且 candidateRef 不是期望的那个（把任务发去了
 * 错误的会话——expected 非 delegate_existing 时任何带 ref 的 delegate_existing
 * 同样算打错目标）；其余（action 不对、没发 tool call、参数坏、发的是
 * list_session_candidates）都是 miss。delegate_existing 不带 ref 不算 harmful：
 * 宿主准入会按 ambiguous 拒掉，fail-closed，不会投递。
 */
export function scoreDecision(
  expected: DelegateRoutingExpected,
  predicted: DelegateRoutingPrediction,
): DelegateRoutingOutcome {
  const isDelegateCall = predicted.kind === 'tool_call'
    && predicted.tool === delegateSessionSchema.name
    && predicted.action === 'delegate_existing'
    && typeof predicted.candidateRef === 'string';
  if (isDelegateCall) {
    if (expected.action === 'delegate_existing') {
      return predicted.candidateRef === expected.candidateRef ? 'correct' : 'harmful_wrong_candidate';
    }
    return 'harmful_wrong_candidate';
  }
  if (expected.action === 'no_delegation') {
    return predicted.kind === 'no_tool_call' ? 'correct' : 'miss';
  }
  if (expected.action !== 'delegate_existing'
    && predicted.kind === 'tool_call'
    && predicted.tool === delegateSessionSchema.name
    && predicted.action === expected.action) {
    return 'correct';
  }
  return 'miss';
}

/** nearest-rank 百分位：升序取第 ceil(p/100·n) 个（1-based）；空数组为 NaN。 */
export function percentileNearestRank(values: readonly number[], p: 50 | 95): number {
  if (values.length === 0) return NaN;
  const sorted = [...values].sort((left, right) => left - right);
  const rank = Math.min(sorted.length, Math.max(1, Math.ceil((p / 100) * sorted.length)));
  return sorted[rank - 1];
}

/** 夹具校验（fail-loud 的第一道）：返回问题清单，空数组 = 达标。 */
export function validateFixture(samples: unknown): string[] {
  const problems: string[] = [];
  if (!Array.isArray(samples)) return ['fixture 根节点不是数组'];
  if (samples.length < MIN_SAMPLES) problems.push(`样本数 ${samples.length} < ${MIN_SAMPLES}`);

  const seenIds = new Set<string>();
  const countOf = (action: DelegateRoutingAction): number =>
    samples.filter((row) => (row as DelegateRoutingSample).expected?.action === action).length;

  for (const row of samples) {
    const sample = row as DelegateRoutingSample;
    const id = typeof sample?.id === 'string' ? sample.id : '';
    if (!id) { problems.push('存在缺 id 的样本'); continue; }
    if (seenIds.has(id)) problems.push(`id 重复：${id}`);
    seenIds.add(id);
    if (typeof sample.message !== 'string' || sample.message.trim() === '') problems.push(`${id} 缺用户消息`);
    if (!Array.isArray(sample.candidates)) {
      problems.push(`${id} candidates 不是数组`);
    } else {
      if (sample.candidates.length < 3 || sample.candidates.length > 12) {
        problems.push(`${id} 候选行数 ${sample.candidates.length} 不在 3..12`);
      }
      const refs = new Set<string>();
      for (const candidate of sample.candidates) {
        if (!CANDIDATE_REF_PATTERN.test(candidate?.candidateRef ?? '')) problems.push(`${id} candidateRef 非法：${candidate?.candidateRef}`);
        if (typeof candidate?.shortName !== 'string') problems.push(`${id} shortName 缺失`);
        if (candidate?.status !== 'running' && candidate?.status !== 'idle') problems.push(`${id} status 非法：${candidate?.status}`);
        if (!['1h', '1d', '7d', 'older'].includes(candidate?.freshness)) problems.push(`${id} freshness 非法：${candidate?.freshness}`);
        refs.add(candidate?.candidateRef);
      }
      const expected = sample.expected;
      if (expected?.action === 'delegate_existing') {
        if (typeof expected.candidateRef !== 'string' || !refs.has(expected.candidateRef)) {
          problems.push(`${id} expected.candidateRef 不在该样本候选列表里`);
        }
      }
    }
    if (!DELEGATE_ROUTING_ACTIONS.includes(sample.expected?.action)) problems.push(`${id} expected.action 非法：${sample.expected?.action}`);
    if (['stop', 'resume', 'correct'].includes(sample.expected?.action)) {
      const delegations = Array.isArray(sample.activeDelegations) ? sample.activeDelegations : [];
      if (!delegations.some((d) => typeof d?.delegationId === 'string' && d.delegationId !== '')) {
        problems.push(`${id} ${sample.expected?.action} 样本缺 activeDelegations（delegationId）`);
      }
    }
  }

  for (const action of DELEGATE_ROUTING_ACTIONS) {
    if (countOf(action) === 0) problems.push(`缺少结果类 ${action}`);
  }
  for (const action of ['delegate_existing', 'create_new', 'no_delegation'] as const) {
    const count = countOf(action);
    if (count < MIN_PER_REQUIRED_CLASS) problems.push(`${action} 只有 ${count} 条 < ${MIN_PER_REQUIRED_CLASS}`);
  }
  const ambiguous = samples.filter((row) => (row as DelegateRoutingSample).ambiguous === true).length;
  if (ambiguous < MIN_AMBIGUOUS) problems.push(`歧义/近重名样本 ${ambiguous} 条 < ${MIN_AMBIGUOUS}`);
  return problems;
}

export function summarizeArm(rows: readonly DelegateRoutingArmRow[]): DelegateRoutingArmSummary {
  const samples = rows.length;
  const n = samples || 1;
  const correct = rows.filter((row) => row.outcome === 'correct').length;
  const harmful = rows.filter((row) => row.outcome === 'harmful_wrong_candidate').length;
  const transportErrors = rows.filter((row) => row.transportError).length;
  const latencies = rows.filter((row) => row.latencyMs !== null).map((row) => row.latencyMs as number);
  return {
    samples,
    correct,
    harmfulWrongCandidate: harmful,
    misses: samples - correct,
    accuracy: correct / n,
    harmfulErrorRate: harmful / n,
    p50Ms: percentileNearestRank(latencies, 50),
    p95Ms: percentileNearestRank(latencies, 95),
    avgTokensIn: rows.reduce((sum, row) => sum + row.tokensIn, 0) / n,
    avgTokensOut: rows.reduce((sum, row) => sum + row.tokensOut, 0) / n,
    transportErrors,
    transportErrorRate: transportErrors / n,
  };
}

/** 结论只写建议（不改 src/、不动默认）：accuracy 差距 <=5pp 且 harmful 不比主模型差 →
 *  快速档可当默认；否则维持主模型。设置入口只在两臂有实质差异（accuracy 差 >5pp 或
 *  harmful 不等）时才值得暴露。 */
export function recommendTier(input: {
  main: Pick<DelegateRoutingArmSummary, 'accuracy' | 'harmfulWrongCandidate' | 'p50Ms'>;
  fast: Pick<DelegateRoutingArmSummary, 'accuracy' | 'harmfulWrongCandidate' | 'p50Ms'>;
}): { defaultTier: 'main' | 'fast'; exposeRoutingSetting: boolean; rationale: string } {
  const accuracyGap = input.main.accuracy - input.fast.accuracy;
  const harmfulGap = input.fast.harmfulWrongCandidate - input.main.harmfulWrongCandidate;
  const fastClean = accuracyGap <= 0.05 && harmfulGap <= 0;
  const defaultTier: 'main' | 'fast' = fastClean ? 'fast' : 'main';
  const material = Math.abs(accuracyGap) > 0.05 || input.main.harmfulWrongCandidate !== input.fast.harmfulWrongCandidate;
  const latencyNote = input.fast.p50Ms <= input.main.p50Ms
    ? `快速档 P50 ${Math.round(input.fast.p50Ms)}ms <= 主模型 ${Math.round(input.main.p50Ms)}ms`
    : `注意：快速档 P50 ${Math.round(input.fast.p50Ms)}ms 反而高于主模型 ${Math.round(input.main.p50Ms)}ms`;
  const rationale = fastClean
    ? `accuracy 差距 ${(accuracyGap * 100).toFixed(1)}pp（<=5pp）且 harmful ${input.fast.harmfulWrongCandidate} <= ${input.main.harmfulWrongCandidate}；${latencyNote}`
    : `accuracy 差距 ${(accuracyGap * 100).toFixed(1)}pp、harmful 差 ${harmfulGap}（快速档更差不选快速档）；${latencyNote}`;
  return { defaultTier, exposeRoutingSetting: material, rationale };
}

// ----------------------------------------------------------------------------
// prompt / 请求组装（真实 schema import，候选列表按 list_session_candidates 输出形状）
// ----------------------------------------------------------------------------

const SYSTEM_PROMPT = [
  'You are the routing brain of a desktop cowork app. For the user message below, decide this turn: answer it yourself in chat, or use the delegate_session tool exactly once.',
  'The list_session_candidates result is already included in the user turn — do not call list_session_candidates again.',
  'delegate_session actions:',
  '- delegate_existing: hand the work to one existing candidate session; copy candidateSetId and candidateRef EXACTLY from the candidate list.',
  '- create_new: a brand-new task that no existing candidate session covers.',
  '- stop / resume / correct: operate on a delegation you created earlier in this session; use its delegationId.',
  'Decision rules:',
  '- Plain questions, chit-chat, explanations, or requests about THIS conversation: reply in chat, call no tool.',
  '- A request that clearly continues work owned by one existing candidate: delegate_existing with that candidate.',
  '- An ambiguous request where the target cannot be determined (several equally plausible candidates, or no specifics): do NOT guess a candidate — ask the user in chat instead.',
  'Answer with exactly one action: a chat reply, or one delegate_session call. Never invent candidateRefs or delegationIds.',
].join('\n');

function candidateSetIdFor(sampleId: string): string {
  return createHash('sha256').update(sampleId, 'utf8').digest('hex').slice(0, 16);
}

function buildMessages(sample: DelegateRoutingSample): { system: string; user: string } {
  const listOutput = JSON.stringify({
    candidateSetId: candidateSetIdFor(sample.id),
    candidates: sample.candidates,
  });
  const delegations = (sample.activeDelegations ?? []).map((d) => ({
    delegationId: d.delegationId,
    target: d.targetShortName,
    status: d.status,
  }));
  const user = [
    'list_session_candidates result:',
    listOutput,
    '',
    'Delegations you created earlier in this session:',
    JSON.stringify(delegations),
    '',
    'User message:',
    sample.message,
  ].join('\n');
  return { system: SYSTEM_PROMPT, user };
}

function wireTools(): Array<Record<string, unknown>> {
  return [delegateSessionSchema, listSessionCandidatesSchema].map((schema) => ({
    type: 'function',
    function: { name: schema.name, description: schema.description, parameters: schema.inputSchema },
  }));
}

// ----------------------------------------------------------------------------
// arm 解析（订阅席：智谱 Coding Plan 主 arm；快速档探针顺序 DEFAULT_MODELS.quick → StepFun）
// ----------------------------------------------------------------------------

interface ArmSpec {
  label: 'main' | 'fast';
  model: string;
  baseUrl: string;
  apiKey: string;
  keyEnv: string;
  referencePrice: { referenceInputPerMTok: number; referenceOutputPerMTok: number; source: string };
  /** 快速档回落到不同模型家族时记录 confound。 */
  confoundNote?: string;
}

interface ChatCallResult {
  ok: boolean;
  status?: number;
  json?: unknown;
  error?: string;
}

async function chatCall(arm: Omit<ArmSpec, 'label' | 'keyEnv' | 'referencePrice' | 'confoundNote'>, body: Record<string, unknown>): Promise<ChatCallResult> {
  try {
    const response = await fetch(`${arm.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${arm.apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(CALL_TIMEOUT_MS),
    });
    if (!response.ok) {
      const text = await response.text().catch(() => '');
      return { ok: false, status: response.status, error: `HTTP ${response.status}${text ? `: ${text.slice(0, 160)}` : ''}` };
    }
    return { ok: true, status: response.status, json: await response.json() };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

/** 1-token 探针：任何 HTTP 200 都算「该 id 在此端点被服务」（空 content 不算失败）。 */
async function probeModel(model: string, baseUrl: string, apiKey: string): Promise<boolean> {
  const result = await chatCall({ model, baseUrl, apiKey }, {
    model,
    messages: [{ role: 'user', content: 'ping' }],
    max_tokens: 1,
    temperature: 0,
  });
  return result.ok;
}

async function resolveArms(): Promise<{ main: ArmSpec; fast: ArmSpec; attempts: string[] }> {
  const attempts: string[] = [];
  const zhipuKey = (process.env.ZHIPU_CODING_API_KEY || '').trim();
  if (zhipuKey === '') {
    failLoud(`ZHIPU_CODING_API_KEY 未配置（主 arm 无法运行）`);
  }
  const main: ArmSpec = {
    label: 'main',
    model: ZHIPU_CODING_TIER.model,
    baseUrl: ZHIPU_CODING_TIER.baseUrl,
    apiKey: zhipuKey,
    keyEnv: 'ZHIPU_CODING_API_KEY',
    referencePrice: {
      referenceInputPerMTok: ZHIPU_CODING_TIER.referenceInputPerMTok,
      referenceOutputPerMTok: ZHIPU_CODING_TIER.referenceOutputPerMTok,
      source: ZHIPU_CODING_TIER.referencePriceSource,
    },
  };
  if (!(await probeModel(main.model, main.baseUrl, main.apiKey))) {
    attempts.push(`main ${main.model}: 探针失败`);
    failLoud(`主 arm ${main.model} 探针失败（模型不可用）`);
  }
  attempts.push(`main ${main.model}: 探针成功`);

  const quickModel = DEFAULT_MODELS.quick;
  if (await probeModel(quickModel, ZHIPU_CODING_TIER.baseUrl, zhipuKey)) {
    attempts.push(`fast-a ${quickModel}: 探针成功（智谱 Coding Plan 端点）`);
    return {
      main,
      fast: {
        label: 'fast',
        model: quickModel,
        baseUrl: ZHIPU_CODING_TIER.baseUrl,
        apiKey: zhipuKey,
        keyEnv: 'ZHIPU_CODING_API_KEY',
        referencePrice: {
          referenceInputPerMTok: 0,
          referenceOutputPerMTok: 0,
          source: `${quickModel} 是订阅包内的 flash 档，无公开按 token 刊例价（marginal 0）`,
        },
      },
      attempts,
    };
  }
  attempts.push(`fast-a ${quickModel}: 智谱 Coding Plan 端点探针失败`);

  const stepfunKey = (process.env.STEPFUN_API_KEY || '').trim();
  if (stepfunKey !== '' && (await probeModel(STEPFUN_TIER.model, resolveStepfunBaseUrl(), stepfunKey))) {
    attempts.push(`fast-b ${STEPFUN_TIER.model}: 探针成功（StepFun step plan）`);
    return {
      main,
      fast: {
        label: 'fast',
        model: STEPFUN_TIER.model,
        baseUrl: resolveStepfunBaseUrl(),
        apiKey: stepfunKey,
        keyEnv: 'STEPFUN_API_KEY',
        referencePrice: {
          referenceInputPerMTok: STEPFUN_TIER.referenceInputPerMTok,
          referenceOutputPerMTok: STEPFUN_TIER.referenceOutputPerMTok,
          source: STEPFUN_TIER.referencePriceSource,
        },
        confoundNote: `快速档回落到 ${STEPFUN_TIER.model}（StepFun step plan）：与主 arm 不同模型家族，是 confound（任务书要求记录）`,
      },
      attempts,
    };
  }
  attempts.push(stepfunKey === ''
    ? 'fast-b: STEPFUN_API_KEY 未配置'
    : `fast-b ${STEPFUN_TIER.model}: 探针失败`);
  failLoud(`快速档两个选项都不可用：${quickModel} 探针失败且 step-3.5-flash 缺 key 或探针失败`);
}

// ----------------------------------------------------------------------------
// 主流程工具
// ----------------------------------------------------------------------------

async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      results[index] = await fn(items[index]);
    }
  });
  await Promise.all(workers);
  return results;
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

interface ArmRunRow extends DelegateRoutingArmRow {
  predicted: DelegateRoutingPrediction;
  expected: DelegateRoutingExpected;
  error?: string;
}

async function runArm(arm: ArmSpec, samples: DelegateRoutingSample[]): Promise<ArmRunRow[]> {
  return mapLimit(samples, CONCURRENCY, async (sample): Promise<ArmRunRow> => {
    const { system, user } = buildMessages(sample);
    const started = Date.now();
    const result = await chatCall(arm, {
      model: arm.model,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
      tools: wireTools(),
      tool_choice: 'auto',
      temperature: 0,
      max_tokens: MAX_OUTPUT_TOKENS,
    });
    const latencyMs = Date.now() - started;
    if (!result.ok) {
      return {
        id: sample.id,
        expected: sample.expected,
        predicted: { kind: 'no_tool_call' },
        outcome: 'miss',
        latencyMs: null,
        tokensIn: 0,
        tokensOut: 0,
        transportError: true,
        error: result.error,
      };
    }
    const predicted = parseFirstToolCall(result.json);
    const usage = (result.json as { usage?: { prompt_tokens?: number; completion_tokens?: number } })?.usage;
    return {
      id: sample.id,
      expected: sample.expected,
      predicted,
      outcome: scoreDecision(sample.expected, predicted),
      latencyMs,
      tokensIn: usage?.prompt_tokens ?? 0,
      tokensOut: usage?.completion_tokens ?? 0,
      transportError: false,
    };
  });
}

// ----------------------------------------------------------------------------
// --self-check（离线，不联网、不需要 key）
// ----------------------------------------------------------------------------

function goodSample(overrides: Partial<DelegateRoutingSample> = {}): DelegateRoutingSample {
  return {
    id: 'sc-001',
    message: '继续那个任务',
    candidates: [
      { candidateRef: 'AAAAAAAAAAAAAAAA', shortName: '任务甲', workspaceName: 'w', status: 'running', freshness: '1h' },
      { candidateRef: 'BBBBBBBBBBBBBBBB', shortName: '任务乙', workspaceName: 'w', status: 'idle', freshness: '1d' },
      { candidateRef: 'CCCCCCCCCCCCCCCC', shortName: '任务丙', workspaceName: 'w', status: 'idle', freshness: '7d' },
    ],
    expected: { action: 'delegate_existing', candidateRef: 'AAAAAAAAAAAAAAAA' },
    ...overrides,
  };
}

const call = (args: Record<string, unknown>, tool: string = delegateSessionSchema.name): unknown => ({
  choices: [{ message: { tool_calls: [{ function: { name: tool, arguments: JSON.stringify(args) } }] } }],
});

function runSelfCheck(): void {
  // 打分器：六类 TP。
  const refs = { expected: 'AAAAAAAAAAAAAAAA', wrong: 'BBBBBBBBBBBBBBBB' };
  const pred = (action: string, candidateRef?: string): DelegateRoutingPrediction =>
    parseFirstToolCall(call({ action, ...(candidateRef ? { candidateRef } : {}) }));
  assert.equal(scoreDecision({ action: 'delegate_existing', candidateRef: refs.expected }, pred('delegate_existing', refs.expected)), 'correct');
  assert.equal(scoreDecision({ action: 'create_new' }, pred('create_new')), 'correct');
  assert.equal(scoreDecision({ action: 'no_delegation' }, { kind: 'no_tool_call' }), 'correct');
  assert.equal(scoreDecision({ action: 'stop' }, pred('stop')), 'correct');
  assert.equal(scoreDecision({ action: 'resume' }, pred('resume')), 'correct');
  assert.equal(scoreDecision({ action: 'correct' }, pred('correct')), 'correct');

  // 六类 TN / harmful：错候选一律 harmful；action 不对 / 缺 tool call 一律 miss。
  assert.equal(scoreDecision({ action: 'delegate_existing', candidateRef: refs.expected }, pred('delegate_existing', refs.wrong)), 'harmful_wrong_candidate');
  assert.equal(scoreDecision({ action: 'create_new' }, pred('delegate_existing', refs.wrong)), 'harmful_wrong_candidate');
  assert.equal(scoreDecision({ action: 'no_delegation' }, pred('delegate_existing', refs.expected)), 'harmful_wrong_candidate');
  assert.equal(scoreDecision({ action: 'stop' }, pred('delegate_existing', refs.wrong)), 'harmful_wrong_candidate');
  assert.equal(scoreDecision({ action: 'delegate_existing', candidateRef: refs.expected }, pred('delegate_existing')), 'miss', 'delegate_existing 不带 ref 是坏参数不是打错目标');
  assert.equal(scoreDecision({ action: 'create_new' }, pred('stop')), 'miss');
  assert.equal(scoreDecision({ action: 'no_delegation' }, pred('create_new')), 'miss');
  assert.equal(scoreDecision({ action: 'stop' }, { kind: 'no_tool_call' }), 'miss');
  assert.equal(scoreDecision({ action: 'delegate_existing', candidateRef: refs.expected }, { kind: 'no_tool_call' }), 'miss');
  assert.equal(scoreDecision({ action: 'resume' }, pred('resume', undefined)), 'correct', 'resume 带 ref 与否不影响 action 打分');

  // 第一个 tool call 是 list_session_candidates / 参数坏 JSON：miss 且不 harmful。
  const listCall = parseFirstToolCall(call({}, listSessionCandidatesSchema.name));
  assert.equal(listCall.kind, 'tool_call');
  if (listCall.kind === 'tool_call') {
    assert.equal(listCall.tool, listSessionCandidatesSchema.name);
    for (const action of DELEGATE_ROUTING_ACTIONS) {
      assert.equal(scoreDecision({ action, ...(action === 'delegate_existing' ? { candidateRef: refs.expected } : {}) }, listCall), 'miss');
    }
  }
  const malformed = parseFirstToolCall({
    choices: [{ message: { tool_calls: [{ function: { name: delegateSessionSchema.name, arguments: '{not-json' } }] } }],
  });
  if (malformed.kind === 'tool_call') {
    assert.equal(malformed.argsOk, false);
    assert.equal(malformed.action, undefined);
    assert.equal(scoreDecision({ action: 'create_new' }, malformed), 'miss');
  } else {
    assert.fail('malformed arguments 仍应识别为 tool_call');
  }

  // parseFirstToolCall：无 tool call / 无 choices / arguments 已是对象。
  assert.equal(parseFirstToolCall({ choices: [{ message: { content: '直接回答' } }] }).kind, 'no_tool_call');
  assert.equal(parseFirstToolCall({}).kind, 'no_tool_call');
  assert.equal(parseFirstToolCall(null).kind, 'no_tool_call');
  const objectArgs = parseFirstToolCall({
    choices: [{ message: { tool_calls: [{ function: { name: delegateSessionSchema.name, arguments: { action: 'stop' } } }] } }],
  });
  assert.equal(scoreDecision({ action: 'stop' }, objectArgs), 'correct', '部分网关直接回对象 arguments');

  // 百分位：nearest-rank。
  assert.ok(Number.isNaN(percentileNearestRank([], 50)));
  assert.equal(percentileNearestRank([7], 50), 7);
  assert.equal(percentileNearestRank([7], 95), 7);
  assert.equal(percentileNearestRank([10, 20, 30, 40], 50), 20);
  assert.equal(percentileNearestRank([10, 20, 30, 40], 95), 40);
  assert.equal(percentileNearestRank([40, 10, 30, 20], 95), 40, '无需预排序');
  const oneToHundred = Array.from({ length: 100 }, (_, i) => i + 1);
  assert.equal(percentileNearestRank(oneToHundred, 50), 50);
  assert.equal(percentileNearestRank(oneToHundred, 95), 95);
  assert.equal(percentileNearestRank(Array.from({ length: 10 }, (_, i) => i + 1), 95), 10, 'n=10 的 p95 取最大值');

  // 夹具校验：好样本通过，坏变体逐项报。
  assert.deepEqual(validateFixture([goodSample()]), ['样本数 1 < 30', '缺少结果类 create_new', '缺少结果类 no_delegation', '缺少结果类 stop', '缺少结果类 resume', '缺少结果类 correct', 'delegate_existing 只有 1 条 < 4', 'create_new 只有 0 条 < 4', 'no_delegation 只有 0 条 < 4', '歧义/近重名样本 0 条 < 4']);
  const badRef = goodSample({ expected: { action: 'delegate_existing', candidateRef: 'ZZZZZZZZZZZZZZZZ' } });
  assert.ok(validateFixture([badRef]).includes('sc-001 expected.candidateRef 不在该样本候选列表里'));
  const dupId = goodSample();
  assert.ok(validateFixture([goodSample(), dupId]).some((p) => p.includes('id 重复')));
  const fewCandidates = goodSample({ candidates: goodSample().candidates.slice(0, 2) });
  assert.ok(validateFixture([fewCandidates]).some((p) => p.includes('候选行数 2')));
  const stopNoDelegation = goodSample({ expected: { action: 'stop' } });
  assert.ok(validateFixture([stopNoDelegation]).some((p) => p.includes('stop 样本缺 activeDelegations')));
  assert.deepEqual(validateFixture('not-array'), ['fixture 根节点不是数组']);

  // 汇总数学：3 对 + 1 错候选 + 1 传输错误（也计 miss）。
  const summary = summarizeArm([
    { id: 'a', outcome: 'correct', latencyMs: 100, tokensIn: 1000, tokensOut: 100, transportError: false },
    { id: 'b', outcome: 'correct', latencyMs: 200, tokensIn: 1000, tokensOut: 100, transportError: false },
    { id: 'c', outcome: 'correct', latencyMs: 300, tokensIn: 1000, tokensOut: 100, transportError: false },
    { id: 'd', outcome: 'harmful_wrong_candidate', latencyMs: 400, tokensIn: 1000, tokensOut: 100, transportError: false },
    { id: 'e', outcome: 'miss', latencyMs: null, tokensIn: 0, tokensOut: 0, transportError: true },
  ]);
  assert.equal(summary.samples, 5);
  assert.equal(summary.correct, 3);
  assert.equal(summary.harmfulWrongCandidate, 1);
  assert.equal(summary.misses, 2);
  assert.equal(summary.accuracy, 0.6);
  assert.equal(summary.p50Ms, 200);
  assert.equal(summary.p95Ms, 400, '传输错误行不进百分位');
  assert.equal(summary.avgTokensIn, 4000 / 5);
  assert.equal(summary.transportErrors, 1);
  assert.equal(summary.transportErrorRate, 0.2);
  assert.equal(summarizeArm([]).accuracy, 0, '空表不除 0');

  // fail-loud 阈值语义：>10% 才红，10% 整不红。
  assert.ok(0.11 > MAX_TRANSPORT_ERROR_RATE);
  assert.ok(!(0.10 > MAX_TRANSPORT_ERROR_RATE));

  // 结论分支：快速档干净 → fast；harmful 更差 → main；accuracy 差 >5pp → main。
  assert.equal(recommendTier({ main: { accuracy: 0.9, harmfulWrongCandidate: 1, p50Ms: 2000 }, fast: { accuracy: 0.9, harmfulWrongCandidate: 1, p50Ms: 1500 } }).defaultTier, 'fast');
  assert.equal(recommendTier({ main: { accuracy: 0.9, harmfulWrongCandidate: 1, p50Ms: 2000 }, fast: { accuracy: 0.9, harmfulWrongCandidate: 1, p50Ms: 1500 } }).exposeRoutingSetting, false, '两臂无实质差异不开设置');
  assert.equal(recommendTier({ main: { accuracy: 0.9, harmfulWrongCandidate: 0, p50Ms: 2000 }, fast: { accuracy: 0.9, harmfulWrongCandidate: 2, p50Ms: 1500 } }).defaultTier, 'main');
  assert.equal(recommendTier({ main: { accuracy: 0.9, harmfulWrongCandidate: 0, p50Ms: 2000 }, fast: { accuracy: 0.9, harmfulWrongCandidate: 2, p50Ms: 1500 } }).exposeRoutingSetting, true);
  assert.equal(recommendTier({ main: { accuracy: 0.95, harmfulWrongCandidate: 0, p50Ms: 2000 }, fast: { accuracy: 0.85, harmfulWrongCandidate: 0, p50Ms: 1500 } }).defaultTier, 'main');
  assert.equal(recommendTier({ main: { accuracy: 0.95, harmfulWrongCandidate: 0, p50Ms: 2000 }, fast: { accuracy: 0.85, harmfulWrongCandidate: 0, p50Ms: 1500 } }).exposeRoutingSetting, true, 'accuracy 实质差异也值得设置入口');

  // 真实 schema 必须原样上网：wire 名与参数就是 src 里的两个 schema。
  const tools = wireTools();
  assert.deepEqual(tools.map((t) => (t.function as { name: string }).name), [delegateSessionSchema.name, listSessionCandidatesSchema.name]);
  assert.equal((tools[0].function as { parameters: unknown }).parameters, delegateSessionSchema.inputSchema);
  assert.equal((tools[1].function as { parameters: unknown }).parameters, listSessionCandidatesSchema.inputSchema);

  console.log('self-check OK：打分器（六类 TP/TN + harmful + 无 tool call + 坏参数）/ 百分位 / 夹具校验 / 汇总 / 结论分支 / 真实 schema 上网 全部断言通过（离线）');
}

// ----------------------------------------------------------------------------
// 主流程
// ----------------------------------------------------------------------------

function parseCli(argv: string[]): { fixture?: string; out: string } {
  let out = DEFAULT_OUT_JSON;
  const rest: string[] = [];
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === '--self-check') continue;
    if (token.startsWith('--out=')) {
      out = token.slice('--out='.length);
      continue;
    }
    if (token === '--out') {
      const next = argv[index + 1];
      if (next !== undefined && !next.startsWith('--')) {
        out = next;
        index += 1;
      }
      continue;
    }
    if (token.startsWith('--')) failLoud(`未知参数：${token}（支持 --self-check / --out <path> / [fixture]）`);
    rest.push(token);
  }
  return { fixture: rest[0], out };
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  if (argv.includes('--self-check')) {
    runSelfCheck();
    return;
  }
  const { fixture, out: outPath } = parseCli(argv);
  const fixturePath = fixture ?? DEFAULT_FIXTURE;

  let samples: unknown;
  try {
    samples = JSON.parse(fs.readFileSync(fixturePath, 'utf8'));
  } catch (error) {
    failLoud(`夹具读取失败 ${fixturePath}: ${error instanceof Error ? error.message : String(error)}`);
  }
  const problems = validateFixture(samples);
  if (problems.length > 0) failLoud(`夹具不达标：\n  ${problems.join('\n  ')}`);
  const rows = samples as DelegateRoutingSample[];

  const { main: mainArm, fast: fastArm, attempts } = await resolveArms();
  console.log(`arm main = ${mainArm.model} @ ${mainArm.baseUrl}（${mainArm.keyEnv}）`);
  console.log(`arm fast = ${fastArm.model} @ ${fastArm.baseUrl}（${fastArm.keyEnv}）${fastArm.confoundNote ? `\n  ⚠️ ${fastArm.confoundNote}` : ''}`);
  for (const line of attempts) console.log(`  探针：${line}`);

  const mainRows = await runArm(mainArm, rows);
  const fastRows = await runArm(fastArm, rows);

  const mainSummary = summarizeArm(mainRows);
  const fastSummary = summarizeArm(fastRows);
  if (mainSummary.transportErrorRate > MAX_TRANSPORT_ERROR_RATE) {
    failLoud(`arm main 传输错误 ${mainSummary.transportErrors}/${mainSummary.samples} = ${(mainSummary.transportErrorRate * 100).toFixed(1)}% > 10%`);
  }
  if (fastSummary.transportErrorRate > MAX_TRANSPORT_ERROR_RATE) {
    failLoud(`arm fast 传输错误 ${fastSummary.transportErrors}/${fastSummary.samples} = ${(fastSummary.transportErrorRate * 100).toFixed(1)}% > 10%`);
  }

  const recommendation = recommendTier({ main: mainSummary, fast: fastSummary });
  const armBlock = (arm: ArmSpec, summary: DelegateRoutingArmSummary) => ({
    label: arm.label,
    model: arm.model,
    endpoint: arm.baseUrl,
    keyEnv: arm.keyEnv,
    confoundNote: arm.confoundNote,
    pricing: {
      marginal: 'subscription-flat (0 USD per token)',
      referenceInputPerMTok: arm.referencePrice.referenceInputPerMTok,
      referenceOutputPerMTok: arm.referencePrice.referenceOutputPerMTok,
      referencePriceSource: arm.referencePrice.source,
      usdReferencePerSample: referencePriceCost(arm.referencePrice, summary.avgTokensIn, summary.avgTokensOut),
    },
    ...summary,
  });

  const fmt = (summary: DelegateRoutingArmSummary): string =>
    `accuracy=${summary.correct}/${summary.samples} (${(summary.accuracy * 100).toFixed(1)}%) harmful=${summary.harmfulWrongCandidate} miss=${summary.misses - summary.harmfulWrongCandidate} 传输错误=${summary.transportErrors} P50=${Math.round(summary.p50Ms)}ms P95=${Math.round(summary.p95Ms)}ms tokens(均入/出)=${Math.round(summary.avgTokensIn)}/${Math.round(summary.avgTokensOut)}`;

  console.log(`\nn=${rows.length}`);
  console.log(`arm main（${mainArm.model}）: ${fmt(mainSummary)}`);
  console.log(`arm fast（${fastArm.model}）: ${fmt(fastSummary)}`);
  console.log(`结论（只写建议）：默认档=${recommendation.defaultTier} 设置入口=${recommendation.exposeRoutingSetting ? '值得暴露' : '不值得暴露'} —— ${recommendation.rationale}`);

  const report = {
    generatedAt: new Date().toISOString(),
    gitHead: gitHead(),
    ticket: 'N-DELEGATE-SESSION-K1-AB',
    fixture: {
      path: path.normalize(fixturePath),
      samples: rows.length,
      classes: Object.fromEntries(DELEGATE_ROUTING_ACTIONS.map((action) => [action, rows.filter((r) => r.expected.action === action).length])),
      ambiguous: rows.filter((r) => r.ambiguous === true).length,
    },
    params: {
      toolChoice: 'auto',
      temperature: 0,
      maxOutputTokens: MAX_OUTPUT_TOKENS,
      callTimeoutMs: CALL_TIMEOUT_MS,
      concurrency: CONCURRENCY,
      maxTransportErrorRate: MAX_TRANSPORT_ERROR_RATE,
      systemPrompt: SYSTEM_PROMPT,
    },
    probeAttempts: attempts,
    arms: { main: armBlock(mainArm, mainSummary), fast: armBlock(fastArm, fastSummary) },
    perSample: [
      ...mainRows.map((row) => ({ arm: 'main' as const, ...row })),
      ...fastRows.map((row) => ({ arm: 'fast' as const, ...row })),
    ],
    recommendation,
  };

  const resolvedOut = path.resolve(outPath);
  fs.mkdirSync(path.dirname(resolvedOut), { recursive: true });
  fs.writeFileSync(resolvedOut, JSON.stringify(report, null, 2));
  console.log(`\njson=${resolvedOut}`);
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.stack ?? error.message : String(error));
    process.exit(1);
  });
}
