// ============================================================================
// Goal Completion Gate — goal 模式 attempt_completion 的双闸验证
// 从 messageProcessor.handleToolResponse 抽出：闸1（确定性 verifyCommand）+
// 闸2（软评审 reviewCondition）。完成判定权在代码层 —— 模型无法靠"自称完成"
// 绕过验证（拒绝 Ralph）：跑 verifyCommand 看退出码，0 才 markMet 收尾，否则把
// 真实失败输出注回让模型继续修。
// ============================================================================

import type { ToolCall } from '../../../shared/contract';
import type { GoalGateVerdict } from '../../../shared/contract/agent';
import type { RuntimeContext } from './runtimeContext';
import type { ContextAssembly } from './contextAssembly';
import { GOAL_MODE } from '../../../shared/constants';
import { getDatabase } from '../../services/core/databaseService';
import { runReviewGate } from '../goalReviewGate';
import { runGoalEvidenceGate } from './goalEvidenceGate';
import { goalTokensUsedWithSwarm } from './swarmGoalIntegration';
import {
  buildVerificationCard,
  buildNotRunVerificationEvidence,
  buildVerificationPlan,
  runVerificationPlan,
  type VerificationEvidence,
} from '../verification';

/**
 * 裁决落账：turnTrace（诊断 JSONL）+ tool_execution_events（append-only，
 * 经 execution lane 进 session 一本账）。复用 fail-safe 写入，绝不阻断收尾。
 */
function recordGateVerdict(
  ctx: RuntimeContext,
  // 'unverifiable'：闸2 评审基础设施不可用（非评审结论）——只进诊断/账本词汇，
  // 不进 GoalGateVerdict 契约（观测事件的可区分信号走 verificationStatus:not_run）
  input: { gate: 1 | 2; verdict: GoalGateVerdict | 'unverifiable'; attempt: number; detail: string },
): void {
  const recordedAt = Date.now();
  ctx.turnTrace?.record('goal_verdict', {
    gate: input.gate,
    verdict: input.verdict,
    attempt: input.attempt,
    maxAttempts: GOAL_MODE.GATE_REPAIR_MAX_ATTEMPTS,
    detail: input.detail,
  });
  try {
    getDatabase().appendToolExecutionComplete({
      executionId: `goal-gate-${input.gate}-${ctx.sessionId}-${recordedAt}`,
      toolName: 'goal_gate_verdict',
      status: input.verdict === 'allow_finalize' ? 'success' : 'error',
      summary: `gate${input.gate} ${input.verdict} (attempt ${input.attempt}/${GOAL_MODE.GATE_REPAIR_MAX_ATTEMPTS})`,
      sessionId: ctx.sessionId,
      error: input.verdict === 'allow_finalize' ? undefined : input.detail,
      recordedAt,
    });
  } catch { /* fail-safe：账本写入永不阻断裁决 */ }
}

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

  // 闸0（公开证据自证核验，maka self-check gate 借鉴）：零 LLM 成本的程序化前置闸。
  // 产物文件存在性 + 命令真实执行过；不足则有界打回，预算用尽放行进闸1/闸2。
  const evidenceVerdict = runGoalEvidenceGate(ctx, completionCall);
  ctx.turnTrace?.record('goal_evidence_gate', {
    verdict: evidenceVerdict.verdict,
    reason: evidenceVerdict.reason,
    evidenceRefs: evidenceVerdict.evidenceRefs,
  });
  ctx.onEvent({
    type: 'goal_gate',
    data: {
      gate: 0,
      pass: evidenceVerdict.verdict !== 'bounce',
      // 三态映射到闸1/闸2 既有 verdict 词汇表（eval/UI 可区分「核验通过」与
      // 「打回预算耗尽放行」——两者 pass 同为 true）：
      // pass → allow_finalize / bounce → repair_prompt / exhausted_release → 原样
      verdict: evidenceVerdict.verdict === 'pass'
        ? 'allow_finalize'
        : evidenceVerdict.verdict === 'bounce'
          ? 'repair_prompt'
          : 'exhausted_release',
      reason: evidenceVerdict.reason,
      evidenceRefs: evidenceVerdict.evidenceRefs,
    },
  });
  if (evidenceVerdict.verdict === 'bounce') {
    ctx.goalMode.clearCompletionRequest();
    contextAssembly.injectSystemMessage(evidenceVerdict.feedback ?? evidenceVerdict.reason);
    return 'continue';
  }

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
      workspaceSideEffects: evidence.workspaceSideEffects ?? null,
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
      // 三分支裁决：失败 → 有界修复（repair_prompt），预算耗尽 → 到限放行
      // （exhausted_release），绝不无限阻塞在验证修复循环里。
      const attempt = ctx.goalMode.recordGateFailure(1);
      const failDetail = `验证命令 \`${verifyCommand}\` exit ${gate?.exitCode ?? 'null'}${gate?.timedOut ? '（超时）' : ''}：${verificationEvidence.summary}`;
      if (!ctx.goalMode.isGateRepairExhausted(1)) {
        recordGateVerdict(ctx, { gate: 1, verdict: 'repair_prompt', attempt, detail: failDetail });
        ctx.goalMode.clearCompletionRequest();
        contextAssembly.injectSystemMessage(
          [
            '<goal-verify-failed>',
            `验证命令 \`${verifyCommand}\` 未通过（exit ${gate?.exitCode ?? 'null'}${gate?.timedOut ? '，超时' : ''}）。`,
            `失败归因：${verificationEvidence.failureType || 'unverifiable'}。${verificationEvidence.summary}`,
            `修复机会 ${attempt}/${GOAL_MODE.GATE_REPAIR_MAX_ATTEMPTS}：请根据下面的失败输出继续修复，修好后再调 attempt_completion；修复机会用尽后将按当前验证结果收尾。`,
            '--- 验证输出（截断）---',
            gate?.output || '(无输出)',
            '</goal-verify-failed>',
          ].join('\n'),
        );
        return 'continue';
      }
      // 到限放行：官方判定（验证命令失败）保持原样，收尾但带降级标记。
      const releaseReason = `验证命令 ${GOAL_MODE.GATE_REPAIR_MAX_ATTEMPTS} 次修复机会用尽仍未通过：${failDetail}`;
      recordGateVerdict(ctx, { gate: 1, verdict: 'exhausted_release', attempt, detail: releaseReason });
      ctx.goalMode.clearCompletionRequest();
      ctx.goalMode.markMetDegraded(releaseReason);
      ctx.onEvent({
        type: 'goal_gate',
        data: { gate: 1, pass: false, verdict: 'exhausted_release', attempt, reason: releaseReason },
      });
      // 终态事件在闸内立即发出（对齐 IMPOSSIBLE 分支）：final 推理若失败/取消，
      // UI 仍能拿到终态；conversationRuntime met 路径见 degraded 不重发。
      ctx.onEvent({
        type: 'goal_complete',
        data: {
          status: 'met',
          turns: iterations,
          tokensUsed: goalTokensUsedWithSwarm(ctx),
          degraded: true,
          degradedReason: releaseReason,
        },
      });
      if (!ctx.forceFinalResponseReason) {
        ctx.forceFinalResponseReason = 'goal-verify-exhausted';
        ctx.forceFinalResponsePrompt = [
          '<goal-verify-exhausted>',
          `验证命令 \`${verifyCommand}\` 在 ${GOAL_MODE.GATE_REPAIR_MAX_ATTEMPTS} 次修复机会后仍未通过，本次 goal 按到限放行收尾（完成但验证未全过）。`,
          '工具已禁用，请用纯文本向用户诚实收尾：',
          '1. 已完成并可用的部分（引用具体产物/文件）',
          '2. 验证仍未通过的部分及最后一次失败原因（不要淡化或掩饰）',
          '3. 用户如需完全通过验证，下一步可以怎么做',
          '--- 最后一次验证输出（截断）---',
          gate?.output || '(无输出)',
          '</goal-verify-exhausted>',
        ].join('\n');
      }
      return 'continue';
    }
    recordGateVerdict(ctx, {
      gate: 1,
      verdict: 'allow_finalize',
      attempt: ctx.goalMode.getGateFailureCount(1),
      detail: verificationEvidence.summary,
    });
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
    // 观测事件：闸2 判定结果（UI 用）。unverifiable 时带 not_run 标记——
    // "评审没跑成"与"评审不过"必须可区分（infra 错误不许伪装成能力信号）。
    ctx.onEvent({
      type: 'goal_gate',
      data: {
        gate: 2,
        pass: review.pass,
        reason: review.reason,
        ...(review.unverifiable ? { verificationStatus: 'not_run' as const } : {}),
      },
    });
    // 闸2 infra 故障（unverifiable）：评审基础设施不可用（降级重试后仍失败），
    // 没有产生任何评审结论。不 recordGateFailure（不烧修复预算）、不注入"评审
    // 不过"的误导反馈；软条件没核实不能静默 markMet（假绿），有产物也不该
    // aborted（丢产物）→ 复用降级放行语义诚实收尾（met + degraded）。
    if (review.unverifiable) {
      const releaseReason = review.reason; // 已是"评审基础设施不可用：<真实错误>"
      recordGateVerdict(ctx, {
        gate: 2,
        verdict: 'unverifiable',
        attempt: ctx.goalMode.getGateFailureCount(2),
        detail: releaseReason,
      });
      ctx.goalMode.clearCompletionRequest();
      ctx.goalMode.markMetDegraded(releaseReason);
      // 终态 gate:2 事件（对齐 exhausted_release 的终态事件形状，Gemini R1-M2）：
      // 可区分信号走 verificationStatus:'not_run'，不新造 verdict 词汇。
      ctx.onEvent({
        type: 'goal_gate',
        data: {
          gate: 2,
          pass: false,
          verificationStatus: 'not_run',
          attempt: ctx.goalMode.getGateFailureCount(2),
          reason: releaseReason,
        },
      });
      // 同 exhausted_release：终态事件在闸内立即发出，final 推理失败也不留
      // "永远 running"的 UI。
      ctx.onEvent({
        type: 'goal_complete',
        data: {
          status: 'met',
          turns: iterations,
          tokensUsed: goalTokensUsedWithSwarm(ctx),
          degraded: true,
          degradedReason: releaseReason,
        },
      });
      if (!ctx.forceFinalResponseReason) {
        ctx.forceFinalResponseReason = 'goal-review-unverifiable';
        ctx.forceFinalResponsePrompt = [
          '<goal-review-unverifiable>',
          `软评审条件本次未能核实：${releaseReason}。本次 goal 按降级放行收尾（工作已完成，但软条件因评审服务不可用而未经核实）。`,
          '工具已禁用，请用纯文本向用户诚实收尾：',
          '1. 已完成并可用的部分（引用具体产物/文件）',
          `2. 未能核实的软条件：${reviewCondition}——说明是评审基础设施不可用导致未核实，不要说成质量不达标`,
          '3. 用户如需完成核实，下一步可以怎么做（如修复评审模型的 API key 后重新验收）',
          '</goal-review-unverifiable>',
        ].join('\n');
      }
      return 'continue';
    }
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
      // 与闸1 共享同一修复预算：软评审反复不过同样不允许无限阻塞收尾。
      const attempt = ctx.goalMode.recordGateFailure(2);
      const failDetail = `软评审条件未通过：${reviewCondition}。${review.reason}`;
      if (!ctx.goalMode.isGateRepairExhausted(2)) {
        recordGateVerdict(ctx, { gate: 2, verdict: 'repair_prompt', attempt, detail: failDetail });
        ctx.goalMode.clearCompletionRequest();
        contextAssembly.injectSystemMessage(
          [
            '<goal-review-failed>',
            `软评审条件未通过：${reviewCondition}`,
            `修复机会 ${attempt}/${GOAL_MODE.GATE_REPAIR_MAX_ATTEMPTS}：请根据下面的评审意见继续改进，改好后再调 attempt_completion；修复机会用尽后将按当前评审结果收尾。`,
            '--- 评审意见（截断）---',
            review.reason,
            '</goal-review-failed>',
          ].join('\n'),
        );
        return 'continue';
      }
      const releaseReason = `软评审 ${GOAL_MODE.GATE_REPAIR_MAX_ATTEMPTS} 次修复机会用尽仍未通过：${failDetail}`;
      recordGateVerdict(ctx, { gate: 2, verdict: 'exhausted_release', attempt, detail: releaseReason });
      ctx.goalMode.clearCompletionRequest();
      ctx.goalMode.markMetDegraded(releaseReason);
      ctx.onEvent({
        type: 'goal_gate',
        data: { gate: 2, pass: false, verdict: 'exhausted_release', attempt, reason: releaseReason },
      });
      // 同闸1：终态事件在闸内立即发出，final 推理失败也不留"永远 running"的 UI。
      ctx.onEvent({
        type: 'goal_complete',
        data: {
          status: 'met',
          turns: iterations,
          tokensUsed: goalTokensUsedWithSwarm(ctx),
          degraded: true,
          degradedReason: releaseReason,
        },
      });
      if (!ctx.forceFinalResponseReason) {
        ctx.forceFinalResponseReason = 'goal-verify-exhausted';
        ctx.forceFinalResponsePrompt = [
          '<goal-verify-exhausted>',
          `软评审条件在 ${GOAL_MODE.GATE_REPAIR_MAX_ATTEMPTS} 次修复机会后仍未通过，本次 goal 按到限放行收尾（完成但验证未全过）。`,
          '工具已禁用，请用纯文本向用户诚实收尾：',
          '1. 已完成并可用的部分（引用具体产物/文件）',
          '2. 评审仍不满意的部分及最后一次评审意见（不要淡化或掩饰）',
          '3. 用户如需完全达标，下一步可以怎么做',
          '--- 最后一次评审意见（截断）---',
          review.reason,
          '</goal-verify-exhausted>',
        ].join('\n');
      }
      return 'continue';
    }
    recordGateVerdict(ctx, {
      gate: 2,
      verdict: 'allow_finalize',
      attempt: ctx.goalMode.getGateFailureCount(2),
      detail: `软评审通过：${reviewCondition}`,
    });
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
