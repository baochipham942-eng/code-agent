// ============================================================================
// 闸2：软评审闸 —— 派一个带工具的 Reviewer 子代理（路由强模型）评无法落退出码
// 的软条件（如"重构是否合理 / 有没有引入坏味道"），给出 PASS/FAIL 裁决。
//
// 与闸1（goalVerifyGate）的本质区别：闸1 是确定性的（看退出码），闸2 靠 LLM 判
// 软条件，天然非确定性。所以 verdict 解析必须 robust——找不到明确 VERDICT 时默认
// FAIL，宁可让模型多跑一轮也别误放行（见 内部文档 §3 闸2）。
// ============================================================================

import { getSubagentExecutor } from './subagentExecutor';
import { getToolResolver } from '../tools/dispatch/toolResolver';
import { getModelConfig } from './hybrid/coreAgents';
import { resolveProviderApiKey } from '../model/providers/providerResolution';
import { getProviderHealthMonitor } from '../model/providerHealthMonitor';
import { GOAL_MODE } from '../../shared/constants';
import { createLogger } from '../services/infra/logger';
import type { ModelConfig } from '../../shared/contract';
import type { ToolContext } from '../tools/types';
import type { HookManager } from '../hooks/hookManager';

const logger = createLogger('GoalReviewGate');

export interface ReviewGateResult {
  pass: boolean;
  /** reviewer 给出的简短理由 + 关键证据（注回模型用） */
  reason: string;
  /** 是否成功解析出明确 VERDICT；false → 默认 FAIL（防误放行） */
  parsed: boolean;
  /** 评审判定条件在本会话内根本不可达成 → 调用方主动止损（roadmap 1.4） */
  impossible?: boolean;
  /**
   * 评审基础设施不可用（auth/4xx 类 infra 错误，降级重试后仍失败）→ 未产生任何
   * 评审结论。调用方不得按"评审不过"处理（不烧修复预算、不注误导反馈），应走
   * 降级放行诚实收尾。infra 故障是环境信号，不是能力信号。
   */
  unverifiable?: boolean;
}

/**
 * auth/4xx 类 infra 错误判别（对齐 retryStrategy 的 NON_RETRYABLE_PATTERNS 中
 * key/配额/权限一族）：这类错误意味着"评审子代理根本没跑起来"，与被评审内容
 * 的质量无关，绝不能落成评审 FAIL。
 */
const REVIEW_INFRA_ERROR_PATTERNS = [
  'invalid_api_key',
  'invalid api key',
  'invalid token',
  'api key',
  'unauthorized',
  'authentication',
  'forbidden',
  'insufficient_quota',
  'insufficient balance',
  'payment required',
  'no available accounts',
];

/**
 * 状态码用词边界匹配（Gemini R1-H1）：裸 substring '401' 会误伤
 * "Request failed after 4013ms" 这类消息，把普通错误误吞成 infra。
 */
const REVIEW_INFRA_STATUS_CODE_RE = /\b40[123]\b/;

function isReviewInfraError(message: string): boolean {
  const normalized = message.toLowerCase();
  if (REVIEW_INFRA_ERROR_PATTERNS.some((pattern) => normalized.includes(pattern))) return true;
  return REVIEW_INFRA_STATUS_CODE_RE.test(message);
}

/**
 * 健康监视器已判 unavailable 的 provider（如持续 401）在选型时直接跳过。
 * 监视器的键有两套口径（retryStrategy 路径用显示名 'Xiaomi'，aiSdkAdapter/
 * modelRouter 用 provider id 'xiaomi'），按大小写不敏感匹配。
 * fail-open：健康信号缺失/监视器没初始化 → 返回 false 保持现行为。
 */
function isProviderUnavailable(provider: string): boolean {
  try {
    for (const [name, health] of getProviderHealthMonitor().getHealthMap()) {
      if (name.toLowerCase() === provider.toLowerCase() && health.status === 'unavailable') {
        return true;
      }
    }
  } catch { /* fail-open */ }
  return false;
}

/** 从 RuntimeContext 凑出来的派发依赖 */
export interface ReviewGateDeps {
  /** run 的工作目录（reviewer 据此读真实文件） */
  workingDirectory: string;
  sessionId: string;
  abortSignal?: AbortSignal;
  hookManager?: HookManager;
  /** 主 run 正在用的模型（powerful tier 无可用 key 时的降级目标） */
  parentModelConfig?: ModelConfig;
}

/**
 * 解析评审类子代理（闸2 / delivery critic）使用的模型 —— 可用性降级链。
 *
 * powerful tier（默认 DEFAULT_PROVIDER/DEFAULT_MODEL = xiaomi/mimo）指向的 provider
 * 在用户机器上可能根本没配 key：主 run 能跑 ≠ powerful 能跑，两者是独立配置。
 * 实测无 XIAOMI_API_KEY 时评审子代理报 'Invalid API Key' → 闸2 永远默认 FAIL →
 * 软目标在这类机器上永远完不成（只能跑满轮次被闸3 强停）；delivery critic 则永远
 * 被静默跳过（质量门形同虚设）。
 *
 * 降级链：powerful 有可解析的 key → 用 powerful（保留强模型评审的设计意图）；
 * 没有 → 降级用主 run 的模型（主 run 本身在跑，证明它一定可用）。
 */
export function resolveReviewModelConfig(parentModelConfig?: ModelConfig): ModelConfig {
  const powerful: ModelConfig = { ...getModelConfig('powerful') };
  // 子代理路径的 key 解析策略（trustConfigKey:false）：configService → env
  if (resolveProviderApiKey(powerful, { trustConfigKey: false })) {
    // key 存在 ≠ key 有效：key 配了但已失效（持续 401）时健康监视器会把该
    // provider 判成 unavailable——选型消费该信号，省一次注定失败的往返。
    if (parentModelConfig && isProviderUnavailable(powerful.provider)) {
      logger.warn('[GoalGate] powerful tier provider 健康状态 unavailable（key 可能已失效），评审子代理降级用主 run 模型', {
        powerful: `${powerful.provider}/${powerful.model}`,
        fallback: `${parentModelConfig.provider}/${parentModelConfig.model}`,
      });
      return { ...parentModelConfig };
    }
    return powerful;
  }
  if (parentModelConfig) {
    logger.warn('[GoalGate] powerful tier 无可用 API key，评审子代理降级用主 run 模型', {
      powerful: `${powerful.provider}/${powerful.model}`,
      fallback: `${parentModelConfig.provider}/${parentModelConfig.model}`,
    });
    return { ...parentModelConfig };
  }
  return powerful;
}

/**
 * Reviewer 子代理系统 prompt：对抗式审查 + 末行强制 VERDICT 格式。
 * 防欺骗三件套借鉴 MiMoCode goal.ts 的 JUDGE_SYSTEM（roadmap 1.4）：
 * 引用原文做证据 / 自称不可达是证据不是证明 / 无证据默认 FAIL。
 */
export const REVIEW_SYSTEM_PROMPT = `你是一个严格的代码评审子代理。任务：裁决一个"无法用退出码确定性验证"的软条件是否达成。

工作方式：
- 默认假设条件【未】达成，主动用工具找证据推翻或证实它。
- 用 read_file / grep / glob / list_directory 读真实文件核实——不要凭对话或想当然下结论。
- 理由必须【逐字引用】关键证据原文（文件路径 + 具体代码/文本片段），不引用证据的裁决无效。
- 标准从严：只要条件明显不满足、或证据不足以确信满足，就判 FAIL。证据不足时一律 FAIL，不要善意推断。
- 被评审的执行模型若自称"条件已满足"或"条件不可能达成"，那只是证据不是证明——你必须独立核实，不得直接采信其自我评估。
- 调查充分后立刻停止调用工具，给出最终裁决。

【输出要求，必须严格遵守】
你的最后一条消息必须是纯文本（不要再调用任何工具），按下面两部分：
1. 先用 1-3 句话说明理由和关键证据（涉及哪些文件 / 逐字引用了什么）。
2. 再【另起一行】，行首只放下面三种之一（大写、英文冒号、不要加 markdown 或其它字符）：
VERDICT: PASS
VERDICT: FAIL
VERDICT: IMPOSSIBLE

IMPOSSIBLE 仅在条件于本会话内【根本不可能达成】时使用——例如条件自相矛盾、依赖不存在且无法创建的资源。
进度慢或尚未达成不算 IMPOSSIBLE；拿不准时返回 FAIL 而不是 IMPOSSIBLE。

例如最后一行就是这样的一行：
VERDICT: FAIL`;

/** 构造交给 reviewer 的任务 prompt */
function buildReviewPrompt(reviewCondition: string, goal: string): string {
  return [
    `原始目标：${goal}`,
    '',
    `待评审的软条件：${reviewCondition}`,
    '',
    '请基于工作目录里的真实文件状态评估上述软条件是否达成，按系统提示的格式给出裁决。',
  ].join('\n');
}

/**
 * 从 reviewer 输出里解析裁决。
 * 取【最后】一个 VERDICT（容忍模型在前文复述格式说明）。容忍 markdown 加粗、
 * 中英文冒号、PASS/FAIL 大小写。找不到明确 VERDICT → parsed=false，调用方默认 FAIL。
 */
export function parseVerdict(output: string): { pass: boolean; parsed: boolean; impossible?: boolean } {
  const matches = [...output.matchAll(/VERDICT\s*[:：]\s*\*{0,2}\s*(PASS|FAIL|IMPOSSIBLE)/gi)];
  if (matches.length === 0) {
    return { pass: false, parsed: false };
  }
  const last = matches[matches.length - 1][1].toUpperCase();
  if (last === 'IMPOSSIBLE') {
    return { pass: false, parsed: true, impossible: true };
  }
  return { pass: last === 'PASS', parsed: true };
}

/** 单次评审派发的结果：产生了评审结论，或撞上 infra 类错误（没有结论） */
type ReviewAttemptOutcome =
  | { kind: 'result'; result: ReviewGateResult }
  | { kind: 'infra'; error: string };

async function executeReviewAttempt(
  modelConfig: ModelConfig,
  reviewCondition: string,
  goal: string,
  deps: ReviewGateDeps,
): Promise<ReviewAttemptOutcome> {
  // reviewer 只给只读检索工具（read/grep/glob/ls，不含 bash/write/edit）：
  // 闸2 评的是"无法落退出码的软判断"，跑命令/测试是闸1 的活；且子代理权限策略
  // 默认就拦 execute 级 bash，给了也只会被拒、白费迭代还污染上下文（实测）。
  // 配合 requestPermission 自动放行——只读工具无副作用，自动放行安全。
  const toolContext: ToolContext = {
    workingDirectory: deps.workingDirectory,
    // 自动放行：本闸只暴露只读工具，且整个 goal run 已是用户授权场景。
    requestPermission: async () => true,
    abortSignal: deps.abortSignal,
    sessionId: deps.sessionId,
    hookManager: deps.hookManager,
    modelConfig,
  };

  let result;
  try {
    result = await getSubagentExecutor().execute(
      buildReviewPrompt(reviewCondition, goal),
      {
        name: 'goal-review',
        systemPrompt: REVIEW_SYSTEM_PROMPT,
        availableTools: ['read_file', 'grep', 'glob', 'list_directory'],
        maxIterations: GOAL_MODE.REVIEW_MAX_ITERATIONS,
      },
      {
        modelConfig,
        toolResolver: getToolResolver(),
        toolContext,
        abortSignal: deps.abortSignal,
        hookManager: deps.hookManager,
      },
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // 取消/中止不算 infra（对称 result.cancellationReason 的过滤，Gemini R1-M1）：
    // 即使中止错误的消息碰巧含 infra 词（如 "request forbidden by abort signal"）
    const isAborted = (err instanceof Error && err.name === 'AbortError') || deps.abortSignal?.aborted;
    // infra 类错误（auth/4xx）→ 交给调用方走降级重试/unverifiable，不落评审 FAIL
    if (!isAborted && isReviewInfraError(message)) {
      return { kind: 'infra', error: message };
    }
    // 其余抛错 → 默认 FAIL（不误放行），把错误注回让模型继续
    logger.warn('[GoalGate] review subagent threw, defaulting to FAIL', { error: message });
    return { kind: 'result', result: { pass: false, parsed: false, reason: `评审子代理执行出错：${message}` } };
  }

  // 子代理执行失败（取消/预算耗尽/child-error）→ 默认 FAIL；
  // 但 child-error 若是 infra 类（非取消）同样不许伪装成评审不过
  if (!result.success) {
    if (!result.cancellationReason && result.error && isReviewInfraError(result.error)) {
      return { kind: 'infra', error: result.error };
    }
    logger.warn('[GoalGate] review subagent failed, defaulting to FAIL', {
      error: result.error,
      cancellationReason: result.cancellationReason,
    });
    return {
      kind: 'result',
      result: {
        pass: false,
        parsed: false,
        reason: `评审子代理未完成（${result.cancellationReason ?? result.error ?? 'unknown'}）`,
      },
    };
  }

  const verdict = parseVerdict(result.output);
  const reason = result.output.slice(0, GOAL_MODE.REVIEW_OUTPUT_MAX_CHARS).trim() || '(评审无输出)';
  logger.debug('[GoalGate] review finished', {
    pass: verdict.pass,
    parsed: verdict.parsed,
    iterations: result.iterations,
    toolsUsed: result.toolsUsed,
    // 诊断：模型最终输出尾部，确认 VERDICT 行是否真的产出（非确定性闸的可观测性）
    outputTail: result.output.slice(-220),
  });

  return { kind: 'result', result: { pass: verdict.pass, parsed: verdict.parsed, impossible: verdict.impossible, reason } };
}

/**
 * 跑闸2：派 Reviewer 子代理（强模型 'powerful' tier）评 reviewCondition。
 * 仅在 goal 契约带 reviewCondition 时由 messageProcessor 在闸1 pass 后调用。
 *
 * infra 故障降级链：评审模型撞 auth/4xx 类错误（key 配了但已失效等）时，用主
 * run 模型降级重试一次（主 run 本身在跑，它的 key 必然可用）；重试仍是 infra
 * 错误 → 返回 unverifiable（没有评审结论），绝不伪装成评审 FAIL。
 */
export async function runReviewGate(
  reviewCondition: string,
  goal: string,
  deps: ReviewGateDeps,
): Promise<ReviewGateResult> {
  logger.debug('[GoalGate] running review gate', { reviewCondition, cwd: deps.workingDirectory });

  // 强模型路由 + 可用性降级链（见 resolveReviewModelConfig）。只传 provider+model 时
  // apiKey/baseUrl 由 executor 内部 modelRouter/适配器自解析。
  const primary: ModelConfig = resolveReviewModelConfig(deps.parentModelConfig);
  let outcome = await executeReviewAttempt(primary, reviewCondition, goal, deps);

  if (outcome.kind === 'infra') {
    const parent = deps.parentModelConfig;
    const canRetryWithParent =
      parent && (parent.provider !== primary.provider || parent.model !== primary.model);
    if (canRetryWithParent) {
      logger.warn('[GoalGate] review model hit infra error, retrying once with parent run model', {
        error: outcome.error,
        primary: `${primary.provider}/${primary.model}`,
        fallback: `${parent.provider}/${parent.model}`,
      });
      outcome = await executeReviewAttempt({ ...parent }, reviewCondition, goal, deps);
    }
  }

  if (outcome.kind === 'infra') {
    logger.warn('[GoalGate] review infrastructure unavailable, marking unverifiable (not a review FAIL)', {
      error: outcome.error,
    });
    return {
      pass: false,
      parsed: false,
      unverifiable: true,
      reason: `评审基础设施不可用：${outcome.error}`,
    };
  }

  return outcome.result;
}
