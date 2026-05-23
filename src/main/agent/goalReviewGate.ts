// ============================================================================
// 闸2：软评审闸 —— 派一个带工具的 Reviewer 子代理（路由强模型）评无法落退出码
// 的软条件（如"重构是否合理 / 有没有引入坏味道"），给出 PASS/FAIL 裁决。
//
// 与闸1（goalVerifyGate）的本质区别：闸1 是确定性的（看退出码），闸2 靠 LLM 判
// 软条件，天然非确定性。所以 verdict 解析必须 robust——找不到明确 VERDICT 时默认
// FAIL，宁可让模型多跑一轮也别误放行（见 docs/designs/goal-mode.md §3 闸2）。
// ============================================================================

import { getSubagentExecutor } from './subagentExecutor';
import { getToolResolver } from '../tools/dispatch/toolResolver';
import { getModelConfig } from './hybrid/coreAgents';
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
}

/** 从 RuntimeContext 凑出来的派发依赖 */
export interface ReviewGateDeps {
  /** run 的工作目录（reviewer 据此读真实文件） */
  workingDirectory: string;
  sessionId: string;
  abortSignal?: AbortSignal;
  hookManager?: HookManager;
}

/** Reviewer 子代理系统 prompt：对抗式审查 + 末行强制 VERDICT 格式 */
const REVIEW_SYSTEM_PROMPT = `你是一个严格的代码评审子代理。任务：裁决一个"无法用退出码确定性验证"的软条件是否达成。

工作方式：
- 默认假设条件【未】达成，主动用工具找证据推翻或证实它。
- 用 read_file / grep / glob / list_directory 读真实文件核实——不要凭对话或想当然下结论。
- 标准从严：只要条件明显不满足、或证据不足以确信满足，就判 FAIL。
- 调查充分后立刻停止调用工具，给出最终裁决。

【输出要求，必须严格遵守】
你的最后一条消息必须是纯文本（不要再调用任何工具），按下面两部分：
1. 先用 1-3 句话说明理由和关键证据（涉及哪些文件 / 发现了什么）。
2. 再【另起一行】，行首只放下面两种之一（大写、英文冒号、不要加 markdown 或其它字符）：
VERDICT: PASS
VERDICT: FAIL

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
export function parseVerdict(output: string): { pass: boolean; parsed: boolean } {
  const matches = [...output.matchAll(/VERDICT\s*[:：]\s*\*{0,2}\s*(PASS|FAIL)/gi)];
  if (matches.length === 0) {
    return { pass: false, parsed: false };
  }
  const last = matches[matches.length - 1][1].toUpperCase();
  return { pass: last === 'PASS', parsed: true };
}

/**
 * 跑闸2：派 Reviewer 子代理（强模型 'powerful' tier）评 reviewCondition。
 * 仅在 goal 契约带 reviewCondition 时由 messageProcessor 在闸1 pass 后调用。
 */
export async function runReviewGate(
  reviewCondition: string,
  goal: string,
  deps: ReviewGateDeps,
): Promise<ReviewGateResult> {
  logger.debug('[GoalGate] running review gate', { reviewCondition, cwd: deps.workingDirectory });

  // 强模型路由：闸2 评软条件需要更强的判断力，走 'powerful' tier（默认 mimo，
  // 可经 POWERFUL_MODEL_PROVIDER/POWERFUL_MODEL 覆盖）。只传 provider+model，
  // apiKey/baseUrl 由 executor 内部 modelRouter/适配器自解析。
  const modelConfig: ModelConfig = { ...getModelConfig('powerful') };

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
    // 子代理派发本身抛错 → 默认 FAIL（不误放行），把错误注回让模型继续
    const message = err instanceof Error ? err.message : String(err);
    logger.warn('[GoalGate] review subagent threw, defaulting to FAIL', { error: message });
    return { pass: false, parsed: false, reason: `评审子代理执行出错：${message}` };
  }

  // 子代理执行失败（取消/预算耗尽/child-error）→ 默认 FAIL
  if (!result.success) {
    logger.warn('[GoalGate] review subagent failed, defaulting to FAIL', {
      error: result.error,
      cancellationReason: result.cancellationReason,
    });
    return {
      pass: false,
      parsed: false,
      reason: `评审子代理未完成（${result.cancellationReason ?? result.error ?? 'unknown'}）`,
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

  return { pass: verdict.pass, parsed: verdict.parsed, reason };
}
