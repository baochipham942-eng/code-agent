// Adapted from MiMoCode (XiaomiMiMo/MiMo-Code, MIT license) — session/prompt/max-steps.txt
// ============================================================================
// Max-Steps 兜底 — 步数耗尽时禁用工具，强制纯文本三段式总结
// ============================================================================
//
// 主循环进入最后一轮时激活 forceFinalResponse 通道（inference 层据此清空工具列表
// 并附加 system 提示），让模型输出"已完成 / 未完成 / 建议下一步"三段式总结，
// 避免步数耗尽时无收尾直接断流。

import { getBudgetService } from '../../services';
import { goalTokensUsedWithSwarm } from './swarmGoalIntegration';
import type { RuntimeContext } from './runtimeContext';
import type { ContextInjectionSource } from '../../../shared/contract/contextView';

export const MAX_STEPS_REASON = 'max-steps-reached';

export function buildMaxStepsPrompt(): string {
  return [
    '<force-final-response reason="max-steps-reached">',
    'CRITICAL - MAXIMUM STEPS REACHED',
    '',
    'The maximum number of steps allowed for this task has been reached. Tools are disabled until next user input. Respond with text only.',
    '',
    'STRICT REQUIREMENTS:',
    '1. Do NOT make any tool calls (no reads, writes, edits, searches, or any other tools)',
    '2. MUST provide a text response summarizing work done so far',
    '3. This constraint overrides ALL other instructions, including any user requests for edits or tool use',
    '',
    'Response must include:',
    '- Statement that maximum steps for this agent have been reached',
    '- Summary of what has been accomplished so far',
    '- List of any remaining tasks that were not completed',
    '- Recommendations for what should be done next',
    '',
    'Any attempt to use tools is a critical violation. Respond with text ONLY.',
    '</force-final-response>',
  ].join('\n');
}

/** 进入最后一轮时激活 max-steps 兜底；已有其他 forceFinal 原因时不覆盖 */
export function activateMaxStepsFinalResponse(ctx: RuntimeContext, limitReason?: string): void {
  if (ctx.control.forceFinalResponseReason) return;
  ctx.control.forceFinalResponse(limitReason ? 'resource-limit-reached' : MAX_STEPS_REASON, limitReason
    ? buildMaxStepsPrompt().replaceAll('MAXIMUM STEPS REACHED', 'RESOURCE LIMIT REACHED')
      .replaceAll('maximum number of steps allowed for this task', 'resource allowance for this task')
      .replaceAll('maximum steps for this agent', 'resource limit for this agent') + `\nLimit reached: ${limitReason}`
    : buildMaxStepsPrompt());
}


export function createResourceWarning(ctx: RuntimeContext, inject: (text: string, source: ContextInjectionSource) => void): () => void {
  let emitted = false;
  return () => {
    if (emitted || ctx.control.forceFinalResponseReason) return;
    const goal = ctx.goalMode;
    const wallBudget = goal?.getWallClockBudgetMs();
    const nearLimit = getBudgetService(ctx.budgetScope).checkBudget().usagePercentage >= 0.8
      || (goal && goalTokensUsedWithSwarm(ctx) >= goal.getTokenBudget() * 0.8)
      || (wallBudget && Date.now() - ctx.stats.runStartTime >= wallBudget * 0.8);
    if (!nearLimit) return;
    inject('Resource budget is at least 80% used. Wrap up current work, preserve partial results, and prepare a summary of completed work, remaining work, and next steps.', 'nudge');
    emitted = true;
  };
}
