#!/usr/bin/env npx tsx
// ============================================================================
// delegate-k2-eval — N-DELEGATE-SESSION-K2 刀 K2A（ADR-072 D6 E1/E2/E4/E5 出数）
// ============================================================================
// 只出数，不动任何产品默认：不翻 crossSessionDelegation、不加设置项、不改委托运行时。
//
// 语料（私有，绝不入库/入证据档，只允许 id）：
//   corpus.jsonl 每行 { id, utterance, context, gold_label, gold_target, difficulty, tags }。
//   context 为文本：候选投影（「候选: 短名|workspace|status|freshness；…。」，长前缀
//   「候选(list_session_candidates 投影…)」同义）+ 链上委托（「链上委托: d-610→官网改版(active…)；…。」）
//   + 最近对话/备注。解析必须确定性：任何条目解不开 → fail-loud 非零退出。
//
// E1 主跑：主 arm glm-5.3（ZHIPU_CODING_API_KEY）temperature 0，每条恰一次调用，
//   真实工具 schema（delegate_session / list_session_candidates / AskUserQuestion），
//   只看第一个 tool call：delegate_session→action（delegate_existing 还须 candidateRef
//   对应 gold_target 短名）；AskUserQuestion→clarify；无 tool call→就地（answer_here/reject
//   按签名不可分，分开报数；reject 另要求非空回复文本）。
// E2：gold∈{clarify,reject} 而模型产出 delegate_existing/create_new 绑定 + delegate_existing
//   打错候选，逐条列 id。
// E4：gold 可路由（delegate_existing/create_new/correct/stop/resume）而模型 clarify，
//   总率 + redundant-clarify-trap 18 条单列。
// --second-seat：第二席模型（StepFun step-3.5-flash，STEPFUN_API_KEY，与被测模型不同
//   provider）按 annotation-guide 分层抽 44 条（先 10 条 easy 对齐预跑，≥9/10 才上岗），
//   只见 id/utterance/context；输出 8 值之一（+delegate_existing 目标短名），格式不合按
//   不一致计不重试；报一致率（硬线 ≥90%）、分标签表、Cohen's κ、分歧 id 清单（不裁决）。
// --e5：进程内计时真 projectSessionCandidates + admitDelegation（无模型调用），
//   每个语料候选集一轮（≥200），报 P50/P95/max 对 ≤3s。
// --self-check：离线（无 key 不联网），断言解析器/评分器/κ/分位。
//
// 用法：set -a; source ~/.code-agent/.env; set +a
//   npx tsx scripts/acceptance/delegate-k2-eval.ts <corpus.jsonl> [--out <results.json>]
//   npx tsx scripts/acceptance/delegate-k2-eval.ts <corpus.jsonl> --second-seat
//   npx tsx scripts/acceptance/delegate-k2-eval.ts <corpus.jsonl> --e5
//   npx tsx scripts/acceptance/delegate-k2-eval.ts --self-check
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';

import { parseFirstToolCall } from './delegate-routing-ab';
import { ZHIPU_CODING_TIER, STEPFUN_TIER } from './_jev-real-sites-lib';
import { delegateSessionSchema } from '../../src/host/tools/modules/delegation/delegateSession.schema';
import { listSessionCandidatesSchema } from '../../src/host/tools/modules/delegation/listSessionCandidates.schema';
import { askUserQuestionSchema } from '../../src/host/tools/modules/planning/askUserQuestion.schema';
import { projectSessionCandidates } from '../../src/host/services/delegation/delegationCandidates';
import { admitDelegation } from '../../src/host/services/delegation/delegationAdmission';

// ----------------------------------------------------------------------------
// 常量与类型（script-local 实验常量，非业务常量）
// ----------------------------------------------------------------------------

const MAX_OUTPUT_TOKENS = 2048;
const CALL_TIMEOUT_MS = 90_000;
const CONCURRENCY = 4;
const K2_LABELS = ['delegate_existing', 'answer_here', 'clarify', 'correct', 'resume', 'create_new', 'reject', 'stop'] as const;
type K2Label = typeof K2_LABELS[number];
const ROUTABLE: ReadonlySet<K2Label> = new Set(['delegate_existing', 'create_new', 'correct', 'stop', 'resume']);
/** annotation-guide §3 的分层抽样配额（44 条）。 */
const SEAT2_QUOTA: Partial<Record<K2Label, number>> = {
  delegate_existing: 18, answer_here: 7, clarify: 4, correct: 3, stop: 3, resume: 3, create_new: 3, reject: 3,
};
const SEAT2_SEED = 20261029;
const CALIBRATION_SIZE = 10;

interface K2Item {
  id: string;
  utterance: string;
  context: string;
  gold_label: K2Label;
  gold_target: string | null;
  difficulty: 'easy' | 'medium' | 'hard';
  tags: string[];
}

interface ParsedCandidate {
  shortName: string;
  workspaceName: string;
  status: 'running' | 'idle';
  freshness: '1h' | '1d' | '7d' | 'older';
}

interface ParsedDelegation {
  delegationId: string;
  target: string;
  status: 'active' | 'stopped';
}

interface ParsedContext {
  candidates: ParsedCandidate[];
  delegations: ParsedDelegation[];
  /** 候选/链上之外的补充段（最近对话、备注）原文逐行。 */
  extras: string[];
}

type Prediction =
  | { label: 'no_delegation'; content: string }
  | { label: 'delegate_existing' | 'create_new' | 'correct' | 'stop' | 'resume'; candidateRef?: string; delegationId?: string }
  | { label: 'clarify' };

/** fail-loud：抛错；main 捕获后打 FAIL 并非零退出（self-check 里 assert.throws 也用它）。 */
function failLoud(message: string): never {
  throw new Error(message);
}

// ----------------------------------------------------------------------------
// context 确定性解析
// ----------------------------------------------------------------------------

const CANDIDATE_HEADER = /候选(?:\(list_session_candidates 投影[^)]*\))?[：:]\s*/;
const CANDIDATE_ENTRY = /^([^|；。]+)\|([^|；。]+)\|(running|idle)\|(1h|1d|7d|older)$/;
const CHAIN_ENTRY = /^([a-zA-Z]-[A-Za-z0-9_-]+)→(.+?)\((active|stopped|aborted|terminal_observed)/;

function splitSegment(raw: string): string[] {
  return raw.split('；').map((piece) => piece.trim().replace(/。$/, '').trim()).filter((piece) => piece !== '');
}

function parseContext(item: K2Item): ParsedContext {
  const context = item.context;
  const candidates: ParsedCandidate[] = [];
  const delegations: ParsedDelegation[] = [];
  const extras: string[] = [];

  const candMatch = context.match(CANDIDATE_HEADER);
  if (!candMatch || candMatch.index === undefined) failLoud(`${item.id}: context 无候选段`);
  const candTail = context.slice(candMatch.index + candMatch[0].length);
  const candSegment = candTail.slice(0, candTail.indexOf('。') >= 0 ? candTail.indexOf('。') : candTail.length);
  for (const piece of splitSegment(candSegment)) {
    const entry = piece.match(CANDIDATE_ENTRY);
    if (!entry) failLoud(`${item.id}: 候选条目不可解析「${piece.slice(0, 40)}」`);
    candidates.push({
      shortName: entry[1].trim(),
      workspaceName: entry[2].trim(),
      status: entry[3] as ParsedCandidate['status'],
      freshness: entry[4] as ParsedCandidate['freshness'],
    });
  }
  if (candidates.length === 0) failLoud(`${item.id}: 候选段为空`);

  // 链上段：规范行「d-9→目标(active…)」确定性提取；段内散文形态（「无」、多 id 指向、
  // 混入的备注）是语料刻意构造的歧义语境，原样透传给模型（extras），不算解析失败。
  const chainHeader = context.match(/链上委托[：:]\s*/);
  if (chainHeader && chainHeader.index !== undefined) {
    const chainTail = context.slice(chainHeader.index + chainHeader[0].length);
    const chainSegment = chainTail.slice(0, chainTail.indexOf('。') >= 0 ? chainTail.indexOf('。') : chainTail.length);
    for (const piece of splitSegment(chainSegment)) {
      const entry = piece.match(CHAIN_ENTRY);
      if (entry) {
        // aborted/terminal_observed 等非 active 状态按 stopped 档呈现（ADR：非终态可翻回的
        // 归 resume 候选；评分只按 action，状态仅为提示保真）。
        delegations.push({ delegationId: entry[1], target: entry[2].trim(), status: entry[3] === 'active' ? 'active' : 'stopped' });
      } else {
        extras.push(`链上委托段原文: ${piece}`);
      }
    }
  }
  if (['correct', 'stop', 'resume'].includes(item.gold_label) && delegations.length === 0) {
    failLoud(`${item.id}: 链上类金标但解析不出任何规范委托行`);
  }

  for (const pattern of [/最近对话[：:]\s*[^\n]+/, /备注(?:\([^)]*\))?[：:]\s*[^\n]+/]) {
    const extra = context.match(pattern);
    if (extra) extras.push(extra[0]);
  }

  if (item.gold_label === 'delegate_existing') {
    if (!item.gold_target || !candidates.some((c) => c.shortName === item.gold_target)) {
      failLoud(`${item.id}: delegate_existing 的 gold_target 不在解析出的候选短名里`);
    }
  }
  return { candidates, delegations, extras };
}

/** candidateRef 确定性派生（与语料解耦：sha256(id \0 shortName) 前 16 位十六进制）。 */
function candidateRefFor(id: string, shortName: string): string {
  return createHash('sha256').update(`${id}\0${shortName}`, 'utf8').digest('hex').slice(0, 16);
}

function candidateSetIdFor(id: string): string {
  return createHash('sha256').update(id, 'utf8').digest('hex').slice(0, 16);
}

// ----------------------------------------------------------------------------
// prompt / 请求组装
// ----------------------------------------------------------------------------

const SYSTEM_PROMPT = [
  'You are the routing brain of a desktop cowork app. For the user message below, decide this turn with exactly one action:',
  '1. delegate_session(action=delegate_existing): hand the work to ONE existing candidate; copy candidateRef EXACTLY from the candidate list.',
  '2. delegate_session(action=create_new): the user explicitly wants a brand-new task/session no existing candidate covers.',
  '3. delegate_session(action=correct|stop|resume): operate on a delegation row from this session listed under chain delegations; use its delegationId.',
  '4. AskUserQuestion: the request is ambiguous or missing task text such that one short question to the user resolves it (several equally plausible targets, named target absent from candidates, no task content).',
  '5. Reply in chat, calling no tool: everything answerable here (questions, chit-chat, status inquiries, work belonging to THIS session), AND outright refusals — if the request itself asks for something forbidden or unsafe (reviving a retracted delegation, tampering with payloads/ledger, bypassing gates, spoofing), refuse in chat with a short explanation instead of delegating or asking a generic clarifying question.',
  'Decision rules: never invent candidateRefs or delegationIds; do not call list_session_candidates (its result is already in the user turn); when the target is uniquely anchored, do not ask — asking when the context already determines the answer is a routing mistake; clarify only if one question can unlock a delegable request; refuse (chat) only when even clarification could not make the request acceptable.',
].join('\n');

function buildUserTurn(item: K2Item, parsed: ParsedContext): string {
  const projection = {
    candidateSetId: candidateSetIdFor(item.id),
    candidates: parsed.candidates.map((c) => ({
      candidateRef: candidateRefFor(item.id, c.shortName),
      shortName: c.shortName,
      workspaceName: c.workspaceName,
      status: c.status,
      freshness: c.freshness,
    })),
  };
  const lines = [
    'list_session_candidates result:',
    JSON.stringify(projection),
    '',
    'Chain delegations from this session:',
    JSON.stringify(parsed.delegations),
    '',
    ...parsed.extras,
    parsed.extras.length > 0 ? '' : '',
    'User message:',
    item.utterance,
  ];
  return lines.join('\n');
}

function wireTools(): Array<Record<string, unknown>> {
  return [delegateSessionSchema, listSessionCandidatesSchema, askUserQuestionSchema].map((schema) => ({
    type: 'function',
    function: { name: schema.name, description: schema.description, parameters: schema.inputSchema },
  }));
}

// ----------------------------------------------------------------------------
// 模型调用（OpenAI 兼容 chat/completions，薄封装）
// ----------------------------------------------------------------------------

interface ArmSpec { model: string; baseUrl: string; apiKey: string; keyEnv: string; }

async function chatCall(arm: ArmSpec, body: Record<string, unknown>): Promise<{ ok: boolean; json?: unknown; error?: string }> {
  try {
    const response = await fetch(`${arm.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${arm.apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(CALL_TIMEOUT_MS),
    });
    if (!response.ok) {
      const text = await response.text().catch(() => '');
      return { ok: false, error: `HTTP ${response.status}${text ? `: ${text.slice(0, 160)}` : ''}` };
    }
    return { ok: true, json: await response.json() };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

function assistantContent(payload: unknown): string {
  const message = (payload as { choices?: Array<{ message?: { content?: unknown } }> })?.choices?.[0]?.message;
  return typeof message?.content === 'string' ? message.content.trim() : '';
}

/** 第一个 tool call → 预测标签（无 tool call 落 no_delegation，带回回复文本）。 */
function classifyPrediction(payload: unknown): Prediction {
  const first = parseFirstToolCall(payload);
  if (first.kind === 'no_tool_call') return { label: 'no_delegation', content: assistantContent(payload) };
  if (first.tool === askUserQuestionSchema.name) return { label: 'clarify' };
  if (first.tool === delegateSessionSchema.name) {
    switch (first.action) {
      case 'delegate_existing': return { label: 'delegate_existing', candidateRef: first.candidateRef };
      case 'create_new': return { label: 'create_new' };
      case 'correct': return { label: 'correct', delegationId: first.delegationId };
      case 'stop': return { label: 'stop', delegationId: first.delegationId };
      case 'resume': return { label: 'resume', delegationId: first.delegationId };
      default: return { label: 'no_delegation', content: assistantContent(payload) };
    }
  }
  return { label: 'no_delegation', content: assistantContent(payload) };
}

// ----------------------------------------------------------------------------
// E1/E2/E4 评分
// ----------------------------------------------------------------------------

interface ScoreInput { item: K2Item; refByShort: Map<string, string>; prediction: Prediction; }

function scoreItem(input: ScoreInput): { correct: boolean; e2Violation: boolean; e4UnnecessaryClarify: boolean; note: string } {
  const { item, refByShort, prediction } = input;
  const gold = item.gold_label;
  let correct: boolean;
  let note: string;
  if (prediction.label === 'delegate_existing') {
    const targetShort = prediction.candidateRef
      ? [...refByShort.entries()].find(([, ref]) => ref === prediction.candidateRef)?.[0]
      : undefined;
    correct = gold === 'delegate_existing' && targetShort === item.gold_target;
    note = `pred=delegate_existing→${targetShort ?? '(ref 未命中)'}`;
  } else if (prediction.label === 'clarify') {
    correct = gold === 'clarify';
    note = 'pred=clarify';
  } else if (prediction.label === 'no_delegation') {
    correct = (gold === 'answer_here') || (gold === 'reject' && prediction.content !== '');
    note = gold === 'reject' ? `pred=chat(${prediction.content === '' ? '空文本' : '非空文本'})` : 'pred=chat';
  } else {
    correct = gold === prediction.label;
    note = `pred=${prediction.label}`;
  }
  const binding = prediction.label === 'delegate_existing' || prediction.label === 'create_new';
  const e2Violation = ((gold === 'clarify' || gold === 'reject') && binding)
    || (gold === 'delegate_existing' && prediction.label === 'delegate_existing' && !correct);
  const e4UnnecessaryClarify = ROUTABLE.has(gold) && prediction.label === 'clarify';
  return { correct, e2Violation, e4UnnecessaryClarify, note };
}

function percentileNearestRank(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const index = Math.max(0, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[index];
}

// ----------------------------------------------------------------------------
// Cohen's κ（第二席）
// ----------------------------------------------------------------------------

function cohenKappa(pairs: Array<{ a: string; b: string }>): number {
  const n = pairs.length;
  if (n === 0) return 0;
  const labels = new Set<string>(pairs.flatMap((p) => [p.a, p.b]));
  const agree = pairs.filter((p) => p.a === p.b).length / n;
  const pe = [...labels].reduce((sum, label) => {
    const pa = pairs.filter((p) => p.a === label).length / n;
    const pb = pairs.filter((p) => p.b === label).length / n;
    return sum + pa * pb;
  }, 0);
  return pe === 1 ? 1 : (agree - pe) / (1 - pe);
}

// ----------------------------------------------------------------------------
// 语料与抽样
// ----------------------------------------------------------------------------

function loadCorpus(corpusPath: string): K2Item[] {
  if (!fs.existsSync(corpusPath)) failLoud(`corpus 不存在：${corpusPath}`);
  const items: K2Item[] = [];
  const seen = new Set<string>();
  for (const line of fs.readFileSync(corpusPath, 'utf8').split('\n')) {
    if (line.trim() === '') continue;
    let parsed: unknown;
    try { parsed = JSON.parse(line); } catch { failLoud('corpus 行不是合法 JSON'); }
    const row = parsed as Partial<K2Item> & { gold_label: string };
    if (typeof row.id !== 'string' || typeof row.utterance !== 'string' || typeof row.context !== 'string'
      || typeof row.gold_label !== 'string' || !K2_LABELS.includes(row.gold_label as K2Label)) {
      failLoud(`corpus 条目字段不合法：${String(row.id).slice(0, 24)}`);
    }
    if (seen.has(row.id)) failLoud(`corpus id 重复：${row.id}`);
    seen.add(row.id);
    items.push({
      id: row.id,
      utterance: row.utterance,
      context: row.context,
      gold_label: row.gold_label as K2Label,
      gold_target: typeof row.gold_target === 'string' && row.gold_target !== '' ? row.gold_target : null,
      difficulty: row.difficulty === 'easy' || row.difficulty === 'hard' ? row.difficulty : 'medium',
      tags: Array.isArray(row.tags) ? row.tags.map(String) : [],
    });
  }
  if (items.length < 200) failLoud(`corpus 条数 ${items.length} < 200`);
  return items;
}

/** mulberry32：确定性洗牌（第二席抽样与发放顺序）。 */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function shuffled<T>(items: readonly T[], rand: () => number): T[] {
  const copy = [...items];
  for (let i = copy.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rand() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}

/** annotation-guide §3：44 条分层，hard 优先保证 ≥40%。 */
function sampleSecondSeat(items: readonly K2Item[]): K2Item[] {
  const rand = mulberry32(SEAT2_SEED);
  const picked: K2Item[] = [];
  for (const label of K2_LABELS) {
    const quota = SEAT2_QUOTA[label] ?? 0;
    if (quota === 0) continue;
    const pool = shuffled(items.filter((it) => it.gold_label === label), rand);
    const hardFirst = [...pool.filter((it) => it.difficulty === 'hard'), ...pool.filter((it) => it.difficulty !== 'hard')];
    picked.push(...hardFirst.slice(0, quota));
  }
  const hardCount = picked.filter((it) => it.difficulty === 'hard').length;
  if (hardCount / picked.length < 0.4) failLoud(`第二席抽样 hard 占比 ${(hardCount / picked.length * 100).toFixed(1)}% < 40%`);
  return shuffled(picked, rand);
}

// ----------------------------------------------------------------------------
// 主流程
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

function resolveArm(kind: 'main' | 'second'): ArmSpec {
  const keyEnv = kind === 'main' ? 'ZHIPU_CODING_API_KEY' : 'STEPFUN_API_KEY';
  const tier = kind === 'main' ? ZHIPU_CODING_TIER : STEPFUN_TIER;
  const apiKey = (process.env[keyEnv] || '').trim();
  if (apiKey === '') failLoud(`${keyEnv} 未配置`);
  return { model: tier.model, baseUrl: tier.baseUrl, apiKey, keyEnv };
}

interface E1Row { id: string; gold: K2Label; correct: boolean; e2: boolean; e4: boolean; note: string; latencyMs: number | null; transportError: boolean; }

async function runE1(items: K2Item[]): Promise<{ rows: E1Row[]; summary: Record<string, unknown> }> {
  const arm = resolveArm('main');
  const parsed = items.map((item) => parseContext(item));
  const rows = await mapLimit(items, CONCURRENCY, async (item, ): Promise<E1Row> => {
    const context = parsed[items.indexOf(item)];
    const started = Date.now();
    const result = await chatCall(arm, {
      model: arm.model,
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: buildUserTurn(item, context) },
      ],
      tools: wireTools(),
      tool_choice: 'auto',
      temperature: 0,
      max_tokens: MAX_OUTPUT_TOKENS,
    });
    const latencyMs = Date.now() - started;
    if (!result.ok) {
      return { id: item.id, gold: item.gold_label, correct: false, e2: false, e4: false, note: `transport:${result.error?.slice(0, 80)}`, latencyMs: null, transportError: true };
    }
    const prediction = classifyPrediction(result.json);
    const refByShort = new Map(context.candidates.map((c) => [c.shortName, candidateRefFor(item.id, c.shortName)]));
    const scored = scoreItem({ item, refByShort, prediction });
    return {
      id: item.id, gold: item.gold_label, correct: scored.correct, e2: scored.e2Violation, e4: scored.e4UnnecessaryClarify,
      note: scored.note, latencyMs, transportError: false,
    };
  });
  const transportErrors = rows.filter((r) => r.transportError).length;
  if (transportErrors / rows.length > 0.1) failLoud(`传输错误率 ${(transportErrors / rows.length * 100).toFixed(1)}% > 10%`);
  const perLabel = K2_LABELS.map((label) => {
    const subset = rows.filter((r) => r.gold === label);
    return { label, n: subset.length, correct: subset.filter((r) => r.correct).length };
  });
  const e2Ids = rows.filter((r) => r.e2).map((r) => r.id);
  const routableRows = rows.filter((r) => ROUTABLE.has(r.gold));
  const e4Rows = routableRows.filter((r) => r.e4);
  const trapIds = items.filter((it) => it.tags.includes('redundant-clarify-trap')).map((it) => it.id);
  const trapRows = rows.filter((r) => trapIds.includes(r.id) && r.e4);
  const answerHereRows = rows.filter((r) => r.gold === 'answer_here');
  const rejectRows = rows.filter((r) => r.gold === 'reject');
  const summary = {
    model: arm.model,
    items: rows.length,
    transportErrors,
    e1: {
      overallAccuracy: rows.filter((r) => r.correct).length / rows.length,
      perLabel: perLabel.map((e) => ({ ...e, accuracy: e.n === 0 ? null : e.correct / e.n })),
      answerHereCorrect: `${answerHereRows.filter((r) => r.correct).length}/${answerHereRows.length}`,
      rejectCorrect: `${rejectRows.filter((r) => r.correct).length}/${rejectRows.length}（no-tool-call 签名不可分，两类分开报）`,
    },
    e2: { violations: e2Ids.length, ids: e2Ids },
    e4: {
      unnecessaryClarifyRate: routableRows.length === 0 ? null : e4Rows.length / routableRows.length,
      numerator: e4Rows.length,
      denominator: routableRows.length,
      redundantClarifyTrap: { trapTotal: trapIds.length, trapClarified: trapRows.length, ids: trapRows.map((r) => r.id) },
    },
    latency: {
      p50Ms: percentileNearestRank(rows.filter((r) => r.latencyMs !== null).map((r) => r.latencyMs as number).sort((a, b) => a - b), 50),
      p95Ms: percentileNearestRank(rows.filter((r) => r.latencyMs !== null).map((r) => r.latencyMs as number).sort((a, b) => a - b), 95),
    },
  };
  return { rows, summary };
}

// ----------------------------------------------------------------------------
// 第二席（annotation-guide §3-§4）
// ----------------------------------------------------------------------------

const SEAT2_SYSTEM = [
  '你是独立的标注员，给一条桌面协作产品里的用户消息判定「正确的产品行为」属于哪一类。只依据给出的上下文（候选会话投影、链上委托、最近对话、备注），不脑补上下文之外的事实；备注里的目标不在候选列表里。',
  '八选一，输出严格 JSON（无其他文本）：{"label": X} 或 delegate_existing 时 {"label": "delegate_existing", "target": "候选短名"}。',
  '标签：answer_here=就地回答/本会话处理；delegate_existing=委托给候选里唯一可辨识的既有会话（须给 target=候选短名）；create_new=用户显式要全新任务/会话；clarify=信息不足或歧义，该向用户追问一句；reject=请求本身不安全或违反协议（复活已撤回、篡改载荷/账本、绕过准入门、伪造来源/越权），应直接拒绝并说明；correct=修正既有委托行的内容或目标；stop=停止在跑/排队的委托；resume=解停一条 stopped 委托。',
  '判定阶梯（先命中先赢）：链上指代可定位→correct/stop/resume；澄清了也不能做→reject；一个问题能解开→clarify；显式要新工作→create_new；目标唯一锚定且正文非空→delegate_existing；其余→answer_here。目标已唯一锚定时不要选 clarify。',
].join('\n');

interface Seat2Row { id: string; gold: K2Label; seat: string | null; targetGold: string | null; targetSeat: string | null; agree: boolean; malformed: boolean; }

async function runSecondSeat(items: K2Item[]): Promise<{ summary: Record<string, unknown> }> {
  const arm = resolveArm('second');
  const sample = sampleSecondSeat(items);
  const sampleIds = new Set(sample.map((it) => it.id));
  const calibrationPool = shuffled(items.filter((it) => it.difficulty === 'easy' && !sampleIds.has(it.id)), mulberry32(SEAT2_SEED + 1)).slice(0, CALIBRATION_SIZE);

  const askOnce = async (item: K2Item): Promise<{ label: string | null; target: string | null; malformed: boolean; transport: boolean }> => {
    const result = await chatCall(arm, {
      model: arm.model,
      messages: [
        { role: 'system', content: SEAT2_SYSTEM },
        { role: 'user', content: `id: ${item.id}\ncontext:\n${item.context}\n\nuser message:\n${item.utterance}` },
      ],
      temperature: 0,
      // step-3.5-flash 的 reasoning_content 计入 completion 预算：512 会把正文挤空
      // （首跑 6 条 malformed 的主因），2048 让推理完再落 JSON。
      max_tokens: 2048,
    });
    if (!result.ok) return { label: null, target: null, malformed: false, transport: true };
    const text = assistantContent(result.json) || JSON.stringify((result.json as { choices?: Array<{ message?: { content?: unknown } }> })?.choices?.[0]?.message?.content ?? '');
    const match = text.match(/\{[\s\S]*\}/);
    if (!match) return { label: null, target: null, malformed: true, transport: false };
    try {
      const obj = JSON.parse(match[0]) as { label?: unknown; target?: unknown };
      if (typeof obj.label !== 'string' || !K2_LABELS.includes(obj.label as K2Label)) return { label: null, target: null, malformed: true, transport: false };
      return { label: obj.label, target: typeof obj.target === 'string' ? obj.target : null, malformed: false, transport: false };
    } catch {
      return { label: null, target: null, malformed: true, transport: false };
    }
  };

  // 对齐预跑：10 条 easy 明杆，≥9/10 才上岗。
  let calibrationCorrect = 0;
  const calibrationRows: Seat2Row[] = [];
  for (const item of calibrationPool) {
    const answer = await askOnce(item);
    const ok = !answer.transport && !answer.malformed && answer.label === item.gold_label;
    if (ok) calibrationCorrect += 1;
    calibrationRows.push({ id: item.id, gold: item.gold_label, seat: answer.label, targetGold: item.gold_target, targetSeat: answer.target, agree: ok, malformed: answer.malformed });
  }
  const calibrationRate = calibrationCorrect / CALIBRATION_SIZE;
  const calibrationPassed = calibrationRate >= 0.9;

  const rows: Seat2Row[] = calibrationPassed ? await mapLimit(sample, 2, async (item) => {
    const answer = await askOnce(item);
    const targetOk = item.gold_label !== 'delegate_existing' || (answer.label === 'delegate_existing' && answer.target === item.gold_target);
    const agree = !answer.transport && !answer.malformed && answer.label === item.gold_label && targetOk;
    return { id: item.id, gold: item.gold_label, seat: answer.label, targetGold: item.gold_target, targetSeat: answer.target, agree, malformed: answer.malformed };
  }) : [];
  const kappa = cohenKappa(rows.map((r) => ({ a: r.gold, b: r.seat ?? '__malformed__' })));
  const perLabel = K2_LABELS.map((label) => {
    const subset = rows.filter((r) => r.gold === label);
    return { label, n: subset.length, agree: subset.filter((r) => r.agree).length };
  }).filter((e) => e.n > 0);
  const summary = {
    provider: STEPFUN_TIER.provider, model: arm.model,
    calibration: { size: CALIBRATION_SIZE, correct: calibrationCorrect, rate: calibrationRate, passed: calibrationPassed },
    agreement: rows.length === 0 ? null : rows.filter((r) => r.agree).length / rows.length,
    cohenKappa: rows.length === 0 ? null : kappa,
    perLabel,
    disagreementIds: rows.filter((r) => !r.agree).map((r) => r.id),
    malformedCount: rows.filter((r) => r.malformed).length,
    sampleSize: rows.length,
  };
  return { summary };
}

// ----------------------------------------------------------------------------
// E5（进程内计时，无模型调用）
// ----------------------------------------------------------------------------

const FRESHNESS_MS: Record<ParsedCandidate['freshness'], number> = { '1h': 3_600_000, '1d': 86_400_000, '7d': 604_800_000, older: 2_592_000_000 };

async function runE5(items: K2Item[]): Promise<{ summary: Record<string, unknown> }> {
  const now = 1_790_000_000_000;
  const durations: number[] = [];
  for (const item of items) {
    const parsed = parseContext(item);
    const rows = parsed.candidates.map((c, index) => ({
      id: `s-${candidateRefFor(item.id, c.shortName)}-${index}`,
      title: c.shortName,
      workingDirectory: `/w/${c.workspaceName}`,
      updatedAt: now - FRESHNESS_MS[c.freshness] - index,
      sessionType: 'chat',
    }));
    const started = performance.now();
    const projection = projectSessionCandidates(rows, { originSessionId: 'origin-1', now, secret: `k2-${item.id}`, isRunning: (id) => rows.findIndex((r) => r.id === id) % 2 === 0 });
    const snapshot: Parameters<typeof admitDelegation>[1] = {
      originSessionId: 'origin-1',
      originTurnId: 'turn-1',
      candidates: { candidateSetId: projection.candidateSetId, candidateRefs: projection.candidates.map((c) => c.candidateRef), candidateSessionIds: rows.map((r) => r.id) },
      target: { sessionId: rows[0]?.id ?? null, sessionExists: true, isArchived: false, isDeleted: false, sessionType: 'chat', engineKind: 'native', workspaceRoot: '/w/probe', workspaceAuthorized: true, permissionMode: 'default', folderTrust: { state: 'trusted', blockedItems: 0 } },
      runningTurns: [],
      targetActiveRunId: null,
      delegatedRunIds: [],
      userQueuedOrSendingRows: 0,
      existingDelegation: null,
      chainDelegation: null,
    };
    admitDelegation({ action: 'delegate_existing', content: 'k2-e5 probe', candidateRef: projection.candidates[0]?.candidateRef, candidateSetId: projection.candidateSetId }, snapshot);
    durations.push(performance.now() - started);
  }
  const sorted = [...durations].sort((a, b) => a - b);
  const summary = {
    runs: durations.length,
    p50Ms: percentileNearestRank(sorted, 50),
    p95Ms: percentileNearestRank(sorted, 95),
    maxMs: sorted[sorted.length - 1] ?? 0,
    budgetMs: 3000,
    withinBudget: (sorted[sorted.length - 1] ?? 0) <= 3000,
  };
  return { summary };
}

// ----------------------------------------------------------------------------
// --self-check（离线）
// ----------------------------------------------------------------------------

const SELFCHECK_CONTEXT = '发起会话「X」(工作区 w-main)。候选(list_session_candidates 投影，≤32，chat/native，按新鲜度): 甲|w-a|running|1h；乙|w-b|idle|1d。链上委托: d-9→甲(active，FIFO 前面 0 条)。最近对话: 用户贴了日志。备注(不在候选里): 「丙」是 eval 会话。';

function runSelfCheck(): void {
  // 解析器：长/短候选前缀、链上、附加段。
  const item: K2Item = {
    id: 'sc-1', utterance: 'u', context: SELFCHECK_CONTEXT, gold_label: 'delegate_existing', gold_target: '甲', difficulty: 'easy', tags: [],
  };
  const parsed = parseContext(item);
  assert.equal(parsed.candidates.length, 2);
  assert.deepEqual(parsed.candidates[0], { shortName: '甲', workspaceName: 'w-a', status: 'running', freshness: '1h' });
  assert.equal(parsed.delegations.length, 1);
  assert.equal(parsed.delegations[0].delegationId, 'd-9');
  assert.equal(parsed.delegations[0].target, '甲');
  assert.equal(parsed.delegations[0].status, 'active');
  assert.equal(parsed.extras.length, 2);
  const shortForm = parseContext({ ...item, context: '发起会话「X」(w)。候选: 甲|w-a|idle|1h。' });
  assert.equal(shortForm.candidates.length, 1);
  assert.throws(() => parseContext({ ...item, context: '无候选段' }), /无候选段/);
  assert.throws(() => parseContext({ ...item, gold_target: '不存在', context: '候选: 甲|w-a|idle|1h。' }), /gold_target/);
  assert.throws(() => parseContext({ ...item, context: '候选: 甲没有竖线。' }), /不可解析/);

  // 评分矩阵。
  const refByShort = new Map(parsed.candidates.map((c) => [c.shortName, candidateRefFor(item.id, c.shortName)]));
  const mk = { item, refByShort };
  const pred = (label: Prediction['label'], extra: Partial<Extract<Prediction, { label: string }>> = {}): Prediction =>
    ({ label, ...extra } as Prediction);
  assert.equal(scoreItem({ ...mk, prediction: pred('delegate_existing', { candidateRef: refByShort.get('甲') }) }).correct, true);
  assert.equal(scoreItem({ ...mk, prediction: pred('delegate_existing', { candidateRef: refByShort.get('乙') }) }).correct, false, '错候选不算对');
  assert.equal(scoreItem({ ...mk, prediction: pred('delegate_existing', { candidateRef: refByShort.get('乙') }) }).e2Violation, true, '错候选是 E2 违例');
  const clarifyGold: K2Item = { ...item, gold_label: 'clarify', gold_target: null };
  assert.equal(scoreItem({ item: clarifyGold, refByShort, prediction: pred('delegate_existing', { candidateRef: refByShort.get('甲') }) }).e2Violation, true, 'gold clarify 产出绑定= E2');
  assert.equal(scoreItem({ ...mk, prediction: pred('clarify') }).e4UnnecessaryClarify, true, 'gold 可路由而 clarify= E4');
  assert.equal(scoreItem({ item: clarifyGold, refByShort, prediction: pred('clarify') }).e4UnnecessaryClarify, false);
  const rejectGold: K2Item = { ...item, gold_label: 'reject', gold_target: null };
  assert.equal(scoreItem({ item: rejectGold, refByShort, prediction: pred('no_delegation', { content: '不行' }) }).correct, true, 'reject+非空文本=对');
  assert.equal(scoreItem({ item: rejectGold, refByShort, prediction: pred('no_delegation', { content: '' }) }).correct, false, 'reject+空文本=错');
  const answerGold: K2Item = { ...item, gold_label: 'answer_here', gold_target: null };
  assert.equal(scoreItem({ item: answerGold, refByShort, prediction: pred('no_delegation', { content: '' }) }).correct, true, 'answer_here 不要求文本');
  assert.equal(scoreItem({ item: answerGold, refByShort, prediction: pred('stop') }).correct, false);

  // 预测分类：AskUserQuestion→clarify；delegate_session 动作映射；无 tool call。
  const call = (args: Record<string, unknown>, tool: string): unknown => ({
    choices: [{ message: { content: '正文', tool_calls: [{ function: { name: tool, arguments: JSON.stringify(args) } }] } }],
  });
  assert.equal(classifyPrediction(call({ action: 'stop' }, delegateSessionSchema.name)).label, 'stop');
  assert.equal(classifyPrediction(call({ questions: [] }, askUserQuestionSchema.name)).label, 'clarify');
  assert.equal(classifyPrediction({ choices: [{ message: { content: '直接回答' } }] }).label, 'no_delegation');

  // κ：完全一致=1；已知小例的手算值。
  assert.equal(cohenKappa([{ a: 'x', b: 'x' }, { a: 'y', b: 'y' }]), 1);
  assert.ok(Math.abs(cohenKappa([
    { a: 'x', b: 'x' }, { a: 'x', b: 'x' }, { a: 'x', b: 'x' },
    { a: 'y', b: 'y' }, { a: 'y', b: 'y' }, { a: 'x', b: 'y' },
  ]) - 2 / 3) < 0.01); // 逐格手算：agree=5/6；P(a=x)=4/6·P(b=x)=3/6、P(a=y)=2/6·P(b=y)=3/6 → pe=18/36 → κ=(5/6-1/2)/(1/2)=2/3

  // 分位：nearest-rank。
  assert.equal(percentileNearestRank([1, 2, 3, 4, 5], 50), 3);
  assert.equal(percentileNearestRank([1, 2, 3, 4, 5], 95), 5);

  // 第二席抽样：配额、hard 占比、确定性。
  const synth: K2Item[] = [];
  let n = 0;
  for (const label of K2_LABELS) {
    for (let i = 0; i < 20; i += 1) {
      n += 1;
      synth.push({ id: `x-${n}`, utterance: `u${n}`, context: '候选: 甲|w-a|idle|1h。', gold_label: label, gold_target: label === 'delegate_existing' ? '甲' : null, difficulty: i % 2 === 0 ? 'hard' : 'easy', tags: [] });
    }
  }
  const sample1 = sampleSecondSeat(synth);
  const sample2 = sampleSecondSeat(synth);
  assert.equal(sample1.length, 44);
  assert.deepEqual(sample1.map((s) => s.id), sample2.map((s) => s.id), '同种子抽样确定性');
  for (const label of K2_LABELS) {
    const quota = SEAT2_QUOTA[label] ?? 0;
    assert.equal(sample1.filter((s) => s.gold_label === label).length, quota, `配额 ${label}`);
  }
  console.log('self-check ok');
}

// ----------------------------------------------------------------------------
// CLI
// ----------------------------------------------------------------------------

function readResults(pathAfter: string | undefined): string {
  const dir = 'docs/research/assets/2026-10-delegate-k2';
  return pathAfter ?? path.join(dir, 'results.json');
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.includes('--self-check')) {
    try {
      runSelfCheck();
    } catch (error) {
      console.error(`FAIL: ${error instanceof Error ? error.message : String(error)}（非零退出，不写 JSON）`);
      process.exit(1);
    }
    return;
  }
  const corpusPath = args.find((a) => !a.startsWith('--'));
  if (!corpusPath) failLoud('用法：delegate-k2-eval.ts <corpus.jsonl> [--out path] [--second-seat|--e5]');
  const outIndex = args.indexOf('--out');
  const outPath = readResults(outIndex >= 0 ? args[outIndex + 1] : undefined);
  const items = loadCorpus(corpusPath);
  const resultsPath = path.join(process.cwd(), outPath);
  let doc: Record<string, unknown> = {};
  if (fs.existsSync(resultsPath)) {
    try { doc = JSON.parse(fs.readFileSync(resultsPath, 'utf8')) as Record<string, unknown>; } catch { doc = {}; }
  }
  if (args.includes('--second-seat')) {
    const { summary } = await runSecondSeat(items);
    doc.secondSeat = summary;
    console.log(JSON.stringify(summary, null, 2));
  } else if (args.includes('--e5')) {
    const { summary } = await runE5(items);
    doc.e5 = summary;
    console.log(JSON.stringify(summary, null, 2));
  } else {
    const { rows, summary } = await runE1(items);
    doc.e1Run = { summary, rows: rows.map((r) => ({ id: r.id, gold: r.gold, correct: r.correct, e2: r.e2, e4: r.e4 })) };
    console.log(JSON.stringify(summary, null, 2));
  }
  doc.generatedAt = new Date().toISOString();
  fs.mkdirSync(path.dirname(resultsPath), { recursive: true });
  fs.writeFileSync(resultsPath, `${JSON.stringify(doc, null, 2)}\n`);
  console.error(`written: ${resultsPath}`);
}

void main().catch((error: unknown) => {
  console.error(`FAIL: ${error instanceof Error ? error.message : String(error)}（非零退出，不写 JSON）`);
  process.exit(1);
});
