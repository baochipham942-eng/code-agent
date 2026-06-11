// Adapted from MiMoCode (XiaomiMiMo/MiMo-Code, MIT license)
// ============================================================================
// Max Mode（best-of-N）编排器 — roadmap 3.3 三段式：
//   1. propose-only 并发：N 个候选只产生提案（文本 + 工具调用），绝不执行副作用。
//      Neo 的引擎调用本身不执行工具（执行在 loop 下游 handleToolResponse），所以
//      propose-only 由"无流式回调的 silentEngine + schema-only 工具"保证；
//      toSchemaOnlyTools 保留为防御层（上游 MiMoCode 靠它剥 execute 闭包阻断执行）。
//   2. judge 选索引：独立裁决调用从幸存候选中选最优；判不出/解析失败/抛错一律
//      fail-open 选 0，不阻塞主链路。输出协议改为 goalReviewGate 风格
//      （理由+逐字证据 → 末行 WINNER: <i>），上游是裸整数回复。
//   3. 赢家 replay：返回赢家的 ModelResponse，由正常主链路下游执行其工具调用。
// 成本约束：落选候选 + judge 的 usage 聚合为 overhead，由调用方计入成本统计
// （budgetService），但不进上下文长度估算（ctx.totalInputTokens 只累计赢家）。
// 降级：全候选失败 → streamingEngine 单次正常调用，用户无感。
// ============================================================================

import { MAX_MODE } from '../../../shared/constants';
import { createLogger } from '../../services/infra/logger';
import type { ModelResponse, ModelMessage } from '../loopTypes';
import type { ToolDefinition } from '../../../shared/contract';

const logger = createLogger('MaxMode');

/** 引擎调用签名：消息 + 工具 → 模型响应（config/signal 由调用方闭包绑定） */
export type MaxModeEngine = (
  messages: ModelMessage[],
  tools: ToolDefinition[],
) => Promise<ModelResponse>;

export interface MaxModeDeps {
  /** 静默引擎：无流式回调，候选与 judge 用（propose-only，无 UI 副作用） */
  silentEngine: MaxModeEngine;
  /** 流式引擎：全候选失败时的降级路径，行为与未开 Max Mode 的单次调用一致 */
  streamingEngine: MaxModeEngine;
  /**
   * 取消/转向探针（Codex R1-H2）：候选与 judge 各阶段完成后检查；为真则抛出
   * 中止错误而不是放出部分赢家——单个候选在取消前完成时，其 tool call 绝不能
   * 流入下游执行。调用方 catch 后走既有取消语义（空文本响应）。
   */
  isAborted?: () => boolean;
}

export interface MaxModeStepInput {
  messages: ModelMessage[];
  tools: ToolDefinition[];
  /** 并发候选数（<1 按 1 处理） */
  candidates: number;
}

export interface MaxModeStats {
  candidates: number;
  /** 成功返回的候选数（0 = 已降级单次调用） */
  survivors: number;
  /** 赢家在幸存者数组中的索引 */
  winner: number;
  /** 全候选失败降级单次流式调用 */
  degraded: boolean;
  /** judge 输出是否解析出明确 WINNER（false → fail-open 选 0） */
  judgeParsed: boolean;
  /** 落选候选 + judge 的 token 之和：计成本，不进上下文估算 */
  overhead: { inputTokens: number; outputTokens: number };
  /**
   * 落选候选 + judge 的逐条 usage（Codex R1-M2）：携带实际路由到的
   * provider/model（adaptive 路由/降级后可能 ≠ 请求配置），调用方按实际模型分账。
   * 无 usage 的条目不收录。
   */
  overheadEntries: Array<{
    inputTokens: number;
    outputTokens: number;
    actualProvider?: string;
    actualModel?: string;
  }>;
}

export interface MaxModeStepResult {
  response: ModelResponse;
  stats: MaxModeStats;
}

/**
 * 防御性剥离工具定义上的 execute 闭包（候选绝不能拿到可执行工具）。
 * Neo 的 ToolDefinition 本就不带 execute，此处兜底防未来工具形状变化。
 */
export function toSchemaOnlyTools(tools: ToolDefinition[]): ToolDefinition[] {
  return tools.map((tool) => {
    const { execute: _execute, ...rest } = tool as ToolDefinition & { execute?: unknown };
    return rest as ToolDefinition;
  });
}

/**
 * judge 系统提示 — 防欺骗三件套照 goalReviewGate（roadmap 1.4）风格：
 * 逐字引用证据 / 候选自报完成是证据不是证明 / 拿不准保守缺省（选 0）。
 */
export const JUDGE_SYSTEM_PROMPT = `你是一个严格的裁决者，从同一编程任务步骤的多个独立候选草稿中选出最优的一个。

每个候选包含它的回复文本与它【提议】的工具调用（仅提案，尚未执行）。

裁决标准：
- 优先选下一步行动正确且安全的候选：工具选择恰当、参数具体可执行、不臆造文件路径或 API。
- 候选自称"任务已完成/无需进一步操作"只是证据不是证明——除非其内容里有可核实的依据，否则优先选给出可验证下一步行动的候选。
- 理由必须【逐字引用】获胜候选的关键内容（工具名+参数或原文片段），不引用证据的裁决无效。
- 拿不准时选候选 0。

【输出要求，必须严格遵守】
1. 先用 1-3 句话说明理由（引用获胜候选的关键证据）。
2. 再【另起一行】，行首只放（不要加 markdown 或其它字符）：
WINNER: <候选编号>

例如最后一行就是这样的一行：
WINNER: 0`;

/**
 * 从 judge 输出解析获胜索引。只认【最后一个非空行】且必须整行锚定为 WINNER 行
 * （容忍 markdown 加粗与中英文冒号）——防 spoof（Codex R1-H1）：候选内容或 judge
 * 行文中引用的 "WINNER: x" 字样不得劫持裁决，赢家的 tool call 会被下游真实执行。
 * 无匹配或越界 → fail-open 选 0（parsed=false）。
 */
export function parseJudgeWinner(output: string, count: number): { index: number; parsed: boolean } {
  const lines = output.split('\n').map((l) => l.trim()).filter((l) => l.length > 0);
  const lastLine = lines[lines.length - 1] ?? '';
  const match = lastLine.match(/^(?:\*{1,2})?WINNER\s*[:：]\s*(\d+)(?:\*{1,2})?$/i);
  if (!match) {
    return { index: 0, parsed: false };
  }
  const picked = parseInt(match[1], 10);
  if (Number.isNaN(picked) || picked < 0 || picked >= count) {
    return { index: 0, parsed: false };
  }
  return { index: picked, parsed: true };
}

/**
 * 归一化候选数（Codex R1-M3）：非安全整数（NaN/Infinity/小数）回落 1，
 * 合法整数钳到 [1, MAX_CANDIDATES]——防错误配置触发海量并发扇出。
 */
function normalizeCandidateCount(candidates: number): number {
  if (!Number.isSafeInteger(candidates)) return 1;
  return Math.min(Math.max(1, candidates), MAX_MODE.MAX_CANDIDATES);
}

/** 渲染单个候选给 judge（截断控 token） */
function renderCandidate(candidate: ModelResponse, index: number): string {
  const text = (candidate.content ?? '').trim();
  const calls = (candidate.toolCalls ?? [])
    .map((tc) => `  - ${tc.name}(${JSON.stringify(tc.arguments ?? {})})`)
    .join('\n');
  const rendered = [
    `### 候选 ${index}`,
    `回复文本：\n${text || '（无文本）'}`,
    `提议的工具调用：\n${calls || '（无工具调用 — 纯文本收尾）'}`,
  ].join('\n');
  return rendered.length > MAX_MODE.CANDIDATE_RENDER_MAX_CHARS
    ? `${rendered.slice(0, MAX_MODE.CANDIDATE_RENDER_MAX_CHARS)}\n…（已截断）`
    : rendered;
}

function buildJudgeMessages(survivors: ModelResponse[]): ModelMessage[] {
  const rendered = survivors.map((c, i) => renderCandidate(c, i)).join('\n\n');
  return [
    { role: 'system', content: JUDGE_SYSTEM_PROMPT },
    {
      role: 'user',
      content: [
        `共有 ${survivors.length} 个候选，编号 0..${survivors.length - 1}。`,
        '',
        rendered,
        '',
        `按系统提示的格式给出裁决，最后一行是 WINNER: <0..${survivors.length - 1}>。`,
      ].join('\n'),
    },
  ];
}

/**
 * 跑一个 Max Mode step：N 并发 propose-only 候选 → judge 选索引 → 返回赢家响应
 * 由主链路 replay。全候选失败降级单次流式调用。
 */
export async function runMaxModeStep(
  deps: MaxModeDeps,
  input: MaxModeStepInput,
): Promise<MaxModeStepResult> {
  const n = normalizeCandidateCount(input.candidates);
  const schemaOnlyTools = toSchemaOnlyTools(input.tools);
  const assertNotAborted = () => {
    if (deps.isAborted?.()) {
      // 不能区分"取消前已完成"与"被取消打断"的候选——一律丢弃，
      // 由调用方的既有取消语义接管（部分赢家的 tool call 绝不流入下游）
      throw new Error('[MaxMode] step aborted (cancel/steer during candidates)');
    }
  };

  const results = await Promise.all(
    Array.from({ length: n }, (_, index) =>
      deps.silentEngine(input.messages, schemaOnlyTools).catch((error: unknown) => {
        logger.warn(`[MaxMode] candidate ${index} failed`, {
          error: error instanceof Error ? error.message : String(error),
        });
        return null;
      }),
    ),
  );
  assertNotAborted();
  const survivors = results.filter((r): r is ModelResponse => r !== null);

  if (survivors.length === 0) {
    logger.warn('[MaxMode] all candidates failed; degrading to single streaming call');
    const response = await deps.streamingEngine(input.messages, input.tools);
    return {
      response,
      stats: {
        candidates: n,
        survivors: 0,
        winner: 0,
        degraded: true,
        judgeParsed: false,
        overhead: { inputTokens: 0, outputTokens: 0 },
        overheadEntries: [],
      },
    };
  }

  let winner = 0;
  let judgeParsed = true;
  let judgeResponse: ModelResponse | undefined;
  if (survivors.length > 1) {
    try {
      judgeResponse = await deps.silentEngine(buildJudgeMessages(survivors), []);
      const verdict = parseJudgeWinner(judgeResponse.content ?? '', survivors.length);
      winner = verdict.index;
      judgeParsed = verdict.parsed;
      if (!verdict.parsed) {
        logger.warn('[MaxMode] judge output unparseable; fail-open to candidate 0');
      }
    } catch (error: unknown) {
      winner = 0;
      judgeParsed = false;
      logger.warn('[MaxMode] judge call failed; fail-open to candidate 0', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  assertNotAborted();

  // overhead = 落选候选 + judge（赢家的 usage 留在 response 上走正常上下文/统计路径）。
  // 逐条携带实际路由模型，调用方按实际模型分账（Codex R1-M2）。
  const overheadEntries: MaxModeStats['overheadEntries'] = [];
  survivors.forEach((candidate, index) => {
    if (index === winner || !candidate.usage) return;
    overheadEntries.push({
      inputTokens: candidate.usage.inputTokens,
      outputTokens: candidate.usage.outputTokens,
      actualProvider: candidate.actualProvider,
      actualModel: candidate.actualModel,
    });
  });
  if (judgeResponse?.usage) {
    overheadEntries.push({
      inputTokens: judgeResponse.usage.inputTokens,
      outputTokens: judgeResponse.usage.outputTokens,
      actualProvider: judgeResponse.actualProvider,
      actualModel: judgeResponse.actualModel,
    });
  }
  const overhead = overheadEntries.reduce(
    (acc, entry) => {
      acc.inputTokens += entry.inputTokens;
      acc.outputTokens += entry.outputTokens;
      return acc;
    },
    { inputTokens: 0, outputTokens: 0 },
  );

  logger.info('[MaxMode] step complete', {
    candidates: n,
    survivors: survivors.length,
    winner,
    judgeParsed,
    overheadTokens: overhead.inputTokens + overhead.outputTokens,
  });

  return {
    response: survivors[winner],
    stats: { candidates: n, survivors: survivors.length, winner, degraded: false, judgeParsed, overhead, overheadEntries },
  };
}
