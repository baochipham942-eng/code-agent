// ============================================================================
// GAP-013: Generator-Critic 交付前自动验证
//
// 修改文件数达到阈值的 run，在交付（最终文本回复）前自动派 code-review 子代理
// 审查本次改动；发现 Critical 问题 → 阻塞交付，把审查意见注回上下文让模型修复。
// 利用"找 bug 比写无 bug 代码容易"的不对称性（Generator-Critic 模式）。
//
// 防死循环（#7 有界打回）：每个 run 内 critic 最多打回 DELIVERY_CRITIC.MAX_BLOCKS 次
// （ctx.deliveryCriticBlockCount），模型修复后可重审，满则强制放行。
//
// 证据驱动（#7）：把"本次验证命令（test/typecheck/build/lint）是否运行/通过"喂给 critic。
// 与闸2（goalReviewGate）的关键区别：闸2 是目标验收，出错/解析失败默认 FAIL（宁可多跑一轮）；
// critic 是附加质量门，默认 fail-open（误拦正常交付代价高）——但当本次验证已失败（客观坏证据）时，
// 即使 critic 出错/解析失败也按证据 FAIL 阻塞；验证未运行/通过时保留 fail-open，不误伤无测试基建的任务。
// ============================================================================

import { getSubagentExecutor } from './subagentExecutor';
import { getToolResolver } from '../tools/dispatch/toolResolver';
import { parseVerdict, resolveReviewModelConfig } from './goalReviewGate';
import { DELIVERY_CRITIC } from '../../shared/constants';
import { createLogger } from '../services/infra/logger';
import type { ModelConfig } from '../../shared/contract';
import type { HookManager } from '../hooks/hookManager';

const logger = createLogger('DeliveryCritic');

export interface DeliveryCriticResult {
  /** true = 放行交付；false = 发现 Critical 问题，阻塞交付 */
  pass: boolean;
  /** 是否成功解析出明确 VERDICT */
  parsed: boolean;
  /** critic 的审查意见（注回模型用） */
  reason: string;
}

/** 从 RuntimeContext 凑出来的派发依赖 */
export interface DeliveryCriticDeps {
  workingDirectory: string;
  sessionId: string;
  abortSignal?: AbortSignal;
  hookManager?: HookManager;
  /** 主 run 正在用的模型（powerful tier 无可用 key 时的降级目标） */
  parentModelConfig?: ModelConfig;
}

/** Critic 子代理系统 prompt：只抓 Critical、末行强制 VERDICT 格式 */
const CRITIC_SYSTEM_PROMPT = `你是交付前的代码评审子代理（Critic）。一个 AI agent 刚完成了一批代码修改，你的任务是在交付给用户前找出其中的 Critical 问题。

只报 Critical 级别（会阻塞交付的问题）：
- 明显的逻辑错误 / 会导致运行时崩溃的 bug
- 安全漏洞（注入、密钥泄露、越权访问）
- 数据丢失风险（误删、错误覆盖）
- 改动之间互相矛盾或明显破坏既有功能

不要报以下内容（不阻塞交付）：
- 代码风格、命名、注释
- 性能优化建议
- "可以更好"的重构建议

工作方式：
- 用 read_file / grep / glob 读修改过的文件核实，不要凭空猜测。
- 调查充分后立刻停止调用工具，给出最终裁决。

【输出要求，必须严格遵守】
你的最后一条消息必须是纯文本（不要再调用任何工具），按下面两部分：
1. 若发现 Critical 问题：逐条列出（文件 + 行号 + 问题 + 建议修法）；若没有：用 1-2 句话说明检查了什么。
2. 再【另起一行】，行首只放下面两种之一（大写、英文冒号、不要加 markdown 或其它字符）：
VERDICT: PASS
VERDICT: FAIL`;

/** 本 run 验证命令（test/typecheck/build/lint）的运行结果，用于证据驱动判定 */
export type VerificationOutcome = 'none' | 'passed' | 'failed';

/** 把验证证据翻成给 critic 的一句话指引 */
function describeVerificationEvidence(outcome: VerificationOutcome): string {
  switch (outcome) {
    case 'passed':
      return '本次修改后已运行验证命令（测试/类型检查/构建），且最近一次通过——属正面证据。';
    case 'failed':
      return '⚠️ 本次修改后运行的验证命令（测试/类型检查/构建）最近一次失败。这是 Critical 的客观证据，除非你能确认失败与本次改动无关，否则应判 FAIL。';
    case 'none':
    default:
      return '本次修改后未检测到运行任何验证命令（测试/类型检查/构建）。若改动涉及可验证的逻辑，倾向要求先验证再交付；若项目本身没有可运行的验证手段，则按代码审查本身判定。';
  }
}

/** 构造交给 critic 的任务 prompt */
function buildCriticPrompt(modifiedFiles: string[], userGoal: string, verification: VerificationOutcome): string {
  return [
    `用户的原始任务：${userGoal || '(未提供)'}`,
    '',
    '本次 run 修改的文件：',
    ...modifiedFiles.map((file) => `- ${file}`),
    '',
    `验证证据：${describeVerificationEvidence(verification)}`,
    '',
    '请审查这些修改是否存在 Critical 问题，按系统提示的格式给出裁决。',
  ].join('\n');
}

/**
 * 跑交付前 critic：派 code-review 子代理（强模型 'powerful' tier）审查本次修改。
 * 由 messageProcessor 在最终文本回复（交付）前调用。
 */
export async function runDeliveryCritic(
  modifiedFiles: string[],
  userGoal: string,
  deps: DeliveryCriticDeps,
  verification: VerificationOutcome = 'none',
): Promise<DeliveryCriticResult> {
  logger.debug('[DeliveryCritic] running pre-delivery review', {
    fileCount: modifiedFiles.length,
    cwd: deps.workingDirectory,
  });

  // 强模型路由 + 可用性降级链（与闸2 共用 resolveReviewModelConfig）：powerful tier
  // 没配 key 时降级用主 run 模型，否则 critic 在这类机器上永远被静默跳过。
  const modelConfig: ModelConfig = resolveReviewModelConfig(deps.parentModelConfig);

  // critic 只给只读检索工具：审查不需要改文件/跑命令，且子代理权限策略默认拦
  // execute 级 bash。配合 requestPermission 自动放行——只读工具无副作用。
  let result;
  try {
    result = await getSubagentExecutor().execute({
      prompt: buildCriticPrompt(modifiedFiles, userGoal, verification),
      config: {
        name: 'delivery-critic',
        systemPrompt: CRITIC_SYSTEM_PROMPT,
        availableTools: ['read_file', 'grep', 'glob', 'list_directory'],
        maxIterations: DELIVERY_CRITIC.MAX_ITERATIONS,
      },
      context: {
        sessionId: deps.sessionId,
        cwd: deps.workingDirectory,
        modelConfig,
        resolver: getToolResolver(),
        permission: { request: async () => true },
        events: { emit: () => undefined },
        abortSignal: deps.abortSignal ?? new AbortController().signal,
        hooks: deps.hookManager,
      },
    });
  } catch (err) {
    // critic 自身出错。证据驱动：本次验证已失败时有客观坏证据 → 阻塞；否则保持 fail-open
    // （附加质量门，不能因为它故障卡死正常交付）
    const message = err instanceof Error ? err.message : String(err);
    logger.warn('[DeliveryCritic] critic subagent threw', { error: message, verification });
    return verification === 'failed'
      ? { pass: false, parsed: false, reason: `critic 执行出错，但本次验证命令运行失败（客观证据），按证据阻塞交付：${message}` }
      : { pass: true, parsed: false, reason: `critic 执行出错，跳过：${message}` };
  }

  if (!result.success) {
    logger.warn('[DeliveryCritic] critic subagent did not finish', {
      error: result.error,
      cancellationReason: result.cancellationReason,
      verification,
    });
    const reasonTail = `${result.cancellationReason ?? result.error ?? 'unknown'}`;
    return verification === 'failed'
      ? { pass: false, parsed: false, reason: `critic 未完成，但本次验证命令运行失败（客观证据），按证据阻塞交付（${reasonTail}）` }
      : { pass: true, parsed: false, reason: `critic 未完成，跳过（${reasonTail}）` };
  }

  const verdict = parseVerdict(result.output);
  // 解析不出明确 VERDICT：证据驱动 —— 验证已失败则阻塞，否则放行（误拦比漏检代价高）
  const pass = verdict.parsed ? verdict.pass : verification !== 'failed';
  const reason = result.output.slice(0, DELIVERY_CRITIC.OUTPUT_MAX_CHARS).trim() || '(critic 无输出)';

  logger.info('[DeliveryCritic] review finished', {
    pass,
    parsed: verdict.parsed,
    iterations: result.iterations,
    toolsUsed: result.toolsUsed,
  });

  return { pass, parsed: verdict.parsed, reason };
}
