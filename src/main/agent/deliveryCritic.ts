// ============================================================================
// GAP-013: Generator-Critic 交付前自动验证
//
// 修改文件数达到阈值的 run，在交付（最终文本回复）前自动派 code-review 子代理
// 审查本次改动；发现 Critical 问题 → 阻塞交付，把审查意见注回上下文让模型修复。
// 利用"找 bug 比写无 bug 代码容易"的不对称性（Generator-Critic 模式）。
//
// 防死循环：每个 run 最多跑一次 critic（ctx.deliveryCriticRan），与 GAP-006
// Stop hook 安全阀同属"最多拦一次"机制。
//
// 与闸2（goalReviewGate）的关键区别：闸2 是目标验收，出错/解析失败默认 FAIL
// （宁可多跑一轮不误放行）；critic 是附加质量门，出错/解析失败默认 PASS
// （误拦正常交付的代价高于漏检）。
// ============================================================================

import { getSubagentExecutor } from './subagentExecutor';
import { getToolResolver } from '../tools/dispatch/toolResolver';
import { parseVerdict, resolveReviewModelConfig } from './goalReviewGate';
import { DELIVERY_CRITIC } from '../../shared/constants';
import { createLogger } from '../services/infra/logger';
import type { ModelConfig } from '../../shared/contract';
import type { ToolContext } from '../tools/types';
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

/** 构造交给 critic 的任务 prompt */
function buildCriticPrompt(modifiedFiles: string[], userGoal: string): string {
  return [
    `用户的原始任务：${userGoal || '(未提供)'}`,
    '',
    '本次 run 修改的文件：',
    ...modifiedFiles.map((file) => `- ${file}`),
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
  const toolContext: ToolContext = {
    workingDirectory: deps.workingDirectory,
    requestPermission: async () => true,
    abortSignal: deps.abortSignal,
    sessionId: deps.sessionId,
    hookManager: deps.hookManager,
    modelConfig,
  };

  let result;
  try {
    result = await getSubagentExecutor().execute(
      buildCriticPrompt(modifiedFiles, userGoal),
      {
        name: 'delivery-critic',
        systemPrompt: CRITIC_SYSTEM_PROMPT,
        availableTools: ['read_file', 'grep', 'glob', 'list_directory'],
        maxIterations: DELIVERY_CRITIC.MAX_ITERATIONS,
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
    // critic 自身出错 → 放行交付（附加质量门，不能因为它故障卡死正常交付）
    const message = err instanceof Error ? err.message : String(err);
    logger.warn('[DeliveryCritic] critic subagent threw, skipping gate', { error: message });
    return { pass: true, parsed: false, reason: `critic 执行出错，跳过：${message}` };
  }

  if (!result.success) {
    logger.warn('[DeliveryCritic] critic subagent failed, skipping gate', {
      error: result.error,
      cancellationReason: result.cancellationReason,
    });
    return {
      pass: true,
      parsed: false,
      reason: `critic 未完成，跳过（${result.cancellationReason ?? result.error ?? 'unknown'}）`,
    };
  }

  const verdict = parseVerdict(result.output);
  // 解析不出明确 VERDICT → 放行（critic 误拦比漏检代价高）
  const pass = verdict.parsed ? verdict.pass : true;
  const reason = result.output.slice(0, DELIVERY_CRITIC.OUTPUT_MAX_CHARS).trim() || '(critic 无输出)';

  logger.info('[DeliveryCritic] review finished', {
    pass,
    parsed: verdict.parsed,
    iterations: result.iterations,
    toolsUsed: result.toolsUsed,
  });

  return { pass, parsed: verdict.parsed, reason };
}
