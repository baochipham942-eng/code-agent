// ============================================================================
// Goal Completion Gate — goal 模式 attempt_completion 的双闸验证
// 从 messageProcessor.handleToolResponse 抽出：闸1（确定性 verifyCommand）+
// 闸2（软评审 reviewCondition）。完成判定权在代码层 —— 模型无法靠"自称完成"
// 绕过验证（拒绝 Ralph）：跑 verifyCommand 看退出码，0 才 markMet 收尾，否则把
// 真实失败输出注回让模型继续修。
// ============================================================================

import type { ToolCall } from '../../../shared/contract';
import type { RuntimeContext } from './runtimeContext';
import type { ContextAssembly } from './contextAssembly';
import { runVerifyGate } from '../goalVerifyGate';
import { runReviewGate } from '../goalReviewGate';

/**
 * 拦截 goal 模式下的 attempt_completion，跑双闸验证。
 *
 * @returns
 *  - `'break'`    —— 双闸全过，目标达成，结束本次 goal
 *  - `'continue'` —— 某闸未过，已注入失败输出，需继续修
 *  - `null`       —— 未拦截（非 goal 模式 / 无 pending / 本轮无 attempt_completion）
 */
export async function handleGoalCompletionGate(
  ctx: RuntimeContext,
  contextAssembly: ContextAssembly,
  toolCalls: ToolCall[],
): Promise<'continue' | 'break' | null> {
  if (!ctx.goalMode?.isPending()) return null;
  const completionCall = toolCalls.find((tc) => tc.name === 'attempt_completion');
  if (!completionCall) return null;

  const rawSummary = completionCall.arguments?.summary;
  const summary = typeof rawSummary === 'string' ? rawSummary : '';
  ctx.goalMode.requestCompletion(summary);

  // 闸1（确定性）：仅当契约带 verifyCommand 时跑；纯软目标（只给 review）→ 跳过直接进闸2。
  const verifyCommand = ctx.goalMode.getVerifyCommand();
  if (verifyCommand) {
    const gate = await runVerifyGate(verifyCommand, ctx.workingDirectory);
    // 观测事件：闸1 判定结果（UI 用）
    ctx.onEvent({
      type: 'goal_gate',
      data: { gate: 1, pass: gate.pass, exitCode: gate.exitCode, timedOut: gate.timedOut },
    });
    if (!gate.pass) {
      ctx.goalMode.clearCompletionRequest();
      contextAssembly.injectSystemMessage(
        [
          '<goal-verify-failed>',
          `验证命令 \`${verifyCommand}\` 未通过（exit ${gate.exitCode ?? 'null'}${gate.timedOut ? '，超时' : ''}）。`,
          '目标尚未达成。请根据下面的失败输出继续修复，修好后再调 attempt_completion。',
          '--- 验证输出（截断）---',
          gate.output || '(无输出)',
          '</goal-verify-failed>',
        ].join('\n'),
      );
      return 'continue';
    }
  }

  // 闸2（软评审）：闸1 pass/跳过后，若契约带 reviewCondition，派 Reviewer 子代理（强模型）
  // 评无法落退出码的软条件。fail → 注理由 + continue 让模型继续改。
  const reviewCondition = ctx.goalMode.getReviewCondition();
  if (reviewCondition) {
    const review = await runReviewGate(reviewCondition, ctx.goalMode.getGoal(), {
      workingDirectory: ctx.workingDirectory,
      sessionId: ctx.sessionId,
      abortSignal: ctx.runAbortController?.signal,
      hookManager: ctx.hookManager,
      // 可用性降级链：powerful tier 没配 key 时，闸2 降级用主 run 的模型
      parentModelConfig: ctx.modelConfig,
    });
    // 观测事件：闸2 判定结果（UI 用）
    ctx.onEvent({
      type: 'goal_gate',
      data: { gate: 2, pass: review.pass, reason: review.reason },
    });
    // IMPOSSIBLE 主动止损（roadmap 1.4）：评审独立核实后判定条件在本会话内
    // 根本不可达成 → 直接 markAborted 结束，不再让模型空转烧轮次/预算。
    if (review.impossible) {
      const reason = `评审判定目标不可达成：${review.reason}`;
      ctx.goalMode.markAborted(reason);
      ctx.onEvent({
        type: 'goal_complete',
        data: { status: 'aborted', reason, turns: 0, tokensUsed: 0 },
      });
      contextAssembly.injectSystemMessage(
        [
          '<goal-impossible>',
          `软评审判定该目标在本会话内不可达成：${reviewCondition}`,
          '--- 评审意见（截断）---',
          review.reason,
          '本次 goal 已主动止损结束。请向用户说明不可达成的原因和可行的替代方案。',
          '</goal-impossible>',
        ].join('\n'),
      );
      return 'break';
    }

    if (!review.pass) {
      ctx.goalMode.clearCompletionRequest();
      contextAssembly.injectSystemMessage(
        [
          '<goal-review-failed>',
          `软评审条件未通过：${reviewCondition}`,
          '目标尚未达成。请根据下面的评审意见继续改进，改好后再调 attempt_completion。',
          '--- 评审意见（截断）---',
          review.reason,
          '</goal-review-failed>',
        ].join('\n'),
      );
      return 'continue';
    }
  }

  // 闸1（或跳过）+ 闸2（或跳过）全过 → 达成。
  ctx.goalMode.markMet();
  const passedGates = [
    verifyCommand ? `验证命令 \`${verifyCommand}\` 退出码 0` : null,
    reviewCondition ? '软评审通过' : null,
  ].filter(Boolean).join('、');
  contextAssembly.injectSystemMessage(
    `<goal-verified>\n${passedGates}，目标达成，结束本次 goal。\n</goal-verified>`,
  );
  return 'break';
}
