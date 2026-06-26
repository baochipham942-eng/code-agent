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
import { runReviewGate } from '../goalReviewGate';
import { goalTokensUsedWithSwarm } from './swarmGoalIntegration';
import {
  buildVerificationCard,
  buildNotRunVerificationEvidence,
  buildVerificationPlan,
  runVerificationPlan,
  type VerificationEvidence,
} from '../verification';

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
  iterations: number,
): Promise<'continue' | 'break' | null> {
  if (!ctx.goalMode?.isPending()) return null;
  const completionCall = toolCalls.find((tc) => tc.name === 'attempt_completion');
  if (!completionCall) return null;

  const rawSummary = completionCall.arguments?.summary;
  const summary = typeof rawSummary === 'string' ? rawSummary : '';
  ctx.goalMode.requestCompletion(summary);

  const reviewCondition = ctx.goalMode.getReviewCondition();
  const verificationPlan = buildVerificationPlan({
    cwd: ctx.workingDirectory,
    goal: ctx.goalMode.getGoal(),
    verifyCommand: ctx.goalMode.getVerifyCommand(),
    reviewCondition,
  });
  let verificationEvidence: VerificationEvidence = buildNotRunVerificationEvidence(verificationPlan);
  const recordVerificationEvidence = (evidence: VerificationEvidence): void => {
    ctx.turnTrace?.record('verification', {
      status: evidence.status,
      failureType: evidence.failureType || null,
      evidenceRefs: evidence.evidenceRefs,
      skippedChecks: evidence.skippedChecks,
      commands: evidence.commandResults.map((result) => ({
        id: result.id,
        command: result.command,
        cwd: result.cwd,
        required: result.required,
        exitCode: result.exitCode,
        durationMs: result.durationMs,
        timedOut: result.timedOut,
        pass: result.pass,
      })),
    });
  };

  // 闸1（确定性）：仅当契约带 verifyCommand 时跑；纯软目标（只给 review）→ 跳过直接进闸2。
  const verifyCommand = ctx.goalMode.getVerifyCommand();
  if (verifyCommand) {
    verificationEvidence = await runVerificationPlan(verificationPlan, { includeOptional: false });
    recordVerificationEvidence(verificationEvidence);
    const gate = verificationEvidence.commandResults[0];
    const pass = verificationEvidence.status === 'passed';
    // 观测事件：闸1 判定结果（UI 用）
    ctx.onEvent({
      type: 'goal_gate',
      data: {
        gate: 1,
        pass,
        exitCode: gate?.exitCode ?? null,
        timedOut: gate?.timedOut ?? false,
        verificationStatus: verificationEvidence.status,
        failureType: verificationEvidence.failureType,
        evidenceRefs: verificationEvidence.evidenceRefs,
        skippedChecks: verificationEvidence.skippedChecks,
        plannedOptionalCommands: verificationPlan.optional,
        verificationCard: buildVerificationCard(verificationEvidence),
      },
    });
    if (!pass) {
      ctx.goalMode.clearCompletionRequest();
      contextAssembly.injectSystemMessage(
        [
          '<goal-verify-failed>',
          `验证命令 \`${verifyCommand}\` 未通过（exit ${gate?.exitCode ?? 'null'}${gate?.timedOut ? '，超时' : ''}）。`,
          `失败归因：${verificationEvidence.failureType || 'unverifiable'}。${verificationEvidence.summary}`,
          '目标尚未达成。请根据下面的失败输出继续修复，修好后再调 attempt_completion。',
          '--- 验证输出（截断）---',
          gate?.output || '(无输出)',
          '</goal-verify-failed>',
        ].join('\n'),
      );
      return 'continue';
    }
  } else {
    recordVerificationEvidence(verificationEvidence);
    ctx.onEvent({
      type: 'goal_gate',
      data: {
        gate: 1,
        pass: true,
        verificationStatus: verificationEvidence.status,
        evidenceRefs: verificationEvidence.evidenceRefs,
        skippedChecks: verificationEvidence.skippedChecks,
        plannedOptionalCommands: verificationPlan.optional,
        verificationCard: buildVerificationCard(verificationEvidence),
      },
    });
  }

  // 闸2（软评审）：闸1 pass/跳过后，若契约带 reviewCondition，派 Reviewer 子代理（强模型）
  // 评无法落退出码的软条件。fail → 注理由 + continue 让模型继续改。
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
    // 根本不可达成 → markAborted 结束 goal，并通过 forceFinalResponse 通道
    // （禁工具）让下一轮推理向用户解释原因——直接 break 会让用户拿到一个
    // 看似 completed 却没有任何解释的 run（codex audit R1 修订）。
    if (review.impossible) {
      const reason = `评审判定目标不可达成：${review.reason}`;
      ctx.goalMode.markAborted(reason);
      ctx.onEvent({
        type: 'goal_complete',
        data: { status: 'aborted', reason, turns: iterations, tokensUsed: goalTokensUsedWithSwarm(ctx) },
      });
      if (!ctx.forceFinalResponseReason) {
        ctx.forceFinalResponseReason = 'goal-impossible';
        ctx.forceFinalResponsePrompt = [
          '<force-final-response reason="goal-impossible">',
          `软评审判定该目标在本会话内不可达成：${reviewCondition}`,
          '--- 评审意见（截断）---',
          review.reason,
          '本次 goal 已主动止损结束。工具已禁用，请用纯文本向用户说明：',
          '1. 不可达成的具体原因（引用评审证据）',
          '2. 已完成的工作',
          '3. 可行的替代方案或需要用户提供的前置条件',
          '</force-final-response>',
        ].join('\n');
      }
      return 'continue';
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
  const tag = verificationEvidence.status === 'not_run' ? 'goal-completed' : 'goal-verified';
  const verificationLine = verificationEvidence.status === 'not_run'
    ? 'verification status: not_run；本次没有运行本地验证命令，不标记为 fully verified。'
    : `verification status: ${verificationEvidence.status}；${verificationEvidence.summary}`;
  contextAssembly.injectSystemMessage(
    `<${tag}>\n${[passedGates || '目标条件通过', verificationLine, '目标达成，结束本次 goal。'].join('\n')}\n</${tag}>`,
  );
  return 'break';
}
