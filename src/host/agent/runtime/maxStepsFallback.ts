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
import { createLogger } from '../../services/infra/logger';
import type { Message } from '../../../shared/contract';
import type { RuntimeContext } from './runtimeContext';
import type { ContextAssembly } from './contextAssembly';
import type { ContextInjectionSource } from '../../../shared/contract/contextView';

const logger = createLogger('MaxStepsFallback');

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

/**
 * 撞 max iterations 且最后一轮 forced-final 推理没产出任何可见文本时的确定性保底：
 * 用本次运行已有的产出（改动文件 / 最近一条助手文本）合成「部分结果 + 未完成说明」，
 * 与 forced-final 同一条收尾通道——模型有最后一轮的优先权，模型交白卷时运行时兜底，
 * 不允许出现零收尾断流的 run（issue #1999：exit 1 + 空回复 + 无产物）。
 */
function buildMaxStepsPartialResultContent(ctx: RuntimeContext, maxIterations: number): string {
  const modifiedFiles = Array.from(ctx.nudgeManager?.getModifiedFiles?.() ?? []);
  // 只认本次 run 的产出：会话历史里的旧 assistant 文本不能算「这次做了什么」（ai-review #2005）
  const lastAssistantText = [...ctx.messages]
    .reverse()
    .find((m) => m.role === 'assistant' && m.timestamp >= ctx.stats.runStartTime
      && typeof m.content === 'string' && m.content.trim().length > 0)
    ?.content?.trim();
  const goalSummary = ctx.goalTracker?.getGoalSummary?.();
  const goal = goalSummary?.goal?.trim() ?? '';
  const pendingActions = goalSummary?.pending ?? [];

  const doneLines: string[] = [];
  if (modifiedFiles.length > 0) {
    const shown = modifiedFiles.slice(0, 10).join('、');
    doneLines.push(`- 已改动文件（共 ${modifiedFiles.length} 个）：${shown}${modifiedFiles.length > 10 ? ' 等' : ''}`);
  }
  if (lastAssistantText) {
    const excerpt = lastAssistantText.length > 300 ? `${lastAssistantText.slice(0, 300)}…` : lastAssistantText;
    doneLines.push(`- 最近一次产出：${excerpt}`);
  }
  if (doneLines.length === 0) {
    doneLines.push('- （本次运行没有留下可见产出，执行记录已保留在会话中）');
  }

  const remainingLines: string[] = pendingActions.slice(0, 5).map((action) => `- ${action}`);
  remainingLines.push(
    `- 任务在轮次上限前未能收尾，上方执行记录中未完成的步骤即为剩余工作。${goal ? `原始目标：${goal}` : ''}`,
  );

  return [
    `⚠️ 已达最大执行轮次（${maxIterations} 轮），任务未全部完成，执行已停止。`,
    '',
    '**已完成的部分：**',
    ...doneLines,
    '',
    '**未完成的部分：**',
    ...remainingLines,
    '',
    `**为什么停：** 达到单次运行的最大执行轮次上限（${maxIterations} 轮）。可以发新指令让我从当前进度继续，或把任务拆小后重试。`,
  ].join('\n');
}

/**
 * Max-iterations 收尾保底（issue #1999）：以 max-iterations 完成、但最后一轮
 * forced-final 推理没交付收尾文本（交白卷/被守卫吞掉）时，用本次运行已有产出
 * 合成「部分结果 + 未完成说明」补一条 final 消息。与 forced-final 同一收尾
 * 通道——模型在最后一轮有优先权，这里只兜它没交付的情况，不许零收尾断流。
 *
 * 「已交付」的判据是 forceFinalResponseReason 已被清除：forced-final 的所有收尾
 * 落盘路径（文本 / forceFinal 工具分支 / unavailable-tools 内联路径）都会在持久化
 * 收尾消息后 clearForceFinalResponse；reason 残留 = 收尾轮白跑，且对预算耗尽、
 * 只读硬阈值等其他 forced-final 触发路径同样成立（两条触发路径行为对齐）。
 */
export async function ensureMaxStepsWrapUp(
  ctx: RuntimeContext,
  contextAssembly: Pick<ContextAssembly, 'generateId' | 'addAndPersistMessage'>,
  iterations: number,
  terminalCompleted: boolean,
): Promise<void> {
  if (
    !terminalCompleted
    || ctx.maxIterations <= 1
    || iterations < ctx.maxIterations
    || ctx.control.isCancelled
    || ctx.control.isInterrupted
    || ctx.circuitBreaker.isTripped()
    || !ctx.control.forceFinalResponseReason
  ) {
    return;
  }
  logger.warn('[AgentLoop] Max iterations reached without a final wrap-up; synthesizing partial result', {
    sessionId: ctx.sessionId,
    iterations,
  });
  const partialMessage: Message = {
    id: contextAssembly.generateId(),
    role: 'assistant',
    content: buildMaxStepsPartialResultContent(ctx, ctx.maxIterations),
    timestamp: Date.now(),
  };
  await contextAssembly.addAndPersistMessage(partialMessage);
  ctx.onEvent({ type: 'message', data: partialMessage });
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
