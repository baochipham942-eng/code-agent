import { readFileSync, writeFileSync } from 'fs';
import { isAbsolute, resolve, join } from 'path';
import { getUserConfigDir } from '../../config/configPaths';
import type { ToolCall, ToolResult } from '../../../shared/contract';
import { ARTIFACT_REPAIR_MAX_ATTEMPTS } from '../../../shared/constants/repair';
import { GAME_VALIDATION_TIMEOUTS } from '../../../shared/constants/game';
import { fileReadTracker } from '../../tools/fileReadTracker';
import { createLogger } from '../../services/infra/logger';
import { runReviewGate } from '../goalReviewGate';
import { runVerifyGate } from '../goalVerifyGate';
import type { ArtifactRepairIssueCode } from './artifactRepairSpec';
import { createArtifactRepairSpec, formatArtifactRepairSpecForPrompt } from './artifactRepairSpec';
import { activateArtifactRepairAdmissionStop } from './artifactRepairAdmission';
import { isSameArtifactRepairPath } from './artifactRepairGuard';
import { validateGameArtifact, type GameArtifactValidationOptions } from './gameArtifactValidator';
import type { ContextAssembly } from './contextAssembly';
import type { RunFinalizer } from './runFinalizer';
import type { RuntimeContext } from './runtimeContext';
import {
  buildArtifactRepairInstruction,
  buildRepairTargetLostValidationFailure,
  completedAppendWithoutFinal,
  getArtifactRepairPatchFingerprint,
  getArtifactValidationFailureMap,
  getModifiedFilePath,
  isAppendTool,
  refreshArtifactRepairReadStateAfterRollback,
  restoreArtifactRepairRollbackSnapshot,
  shouldKeepImprovedFailedArtifactPatch,
  decideArtifactRepairStrategy,
  shouldValidateModifiedArtifact,
  type ArtifactRepairPhase,
  type ArtifactValidationFailureState,
  type ArtifactRepairRollbackSnapshot,
} from './toolArtifactRepairPolicy';

const logger = createLogger('AgentLoop');

type HandleModifiedArtifactValidationArgs = {
  ctx: RuntimeContext;
  contextAssembly: ContextAssembly;
  runFinalizer: RunFinalizer;
  toolCall: ToolCall;
  normalizedSuccess: boolean;
  toolResult: ToolResult;
  artifactRepairRollbackSnapshot: ArtifactRepairRollbackSnapshot | null;
};

// 设计草稿（Kun 借鉴：设计 tab）写到 app 托管的 .code-agent/design 下，定义上不是
// 游戏 artifact——豁免游戏契约校验，否则带脚本/动画的落地页会被识别成游戏、校验
// 失败、误入 artifact repair mode 反噬生成（dogfood 实测，见借鉴清单 Bug B）。
// 用「已知上下文（目录）」而非「猜内容」来判定，可靠且不动游戏识别启发式。
function isDesignDraftArtifact(absolutePath: string): boolean {
  const designRoot = join(getUserConfigDir(), 'design');
  return absolutePath === designRoot || absolutePath.startsWith(`${designRoot}/`);
}

export async function handleModifiedArtifactValidation({
  ctx,
  contextAssembly,
  runFinalizer,
  toolCall,
  normalizedSuccess,
  toolResult,
  artifactRepairRollbackSnapshot,
}: HandleModifiedArtifactValidationArgs): Promise<void> {
  if (!shouldValidateModifiedArtifact(toolCall) || !normalizedSuccess) return;

  const filePath = getModifiedFilePath(toolCall);
  if (!filePath) return;

  try {
    const absolutePath = isAbsolute(filePath)
      ? filePath
      : resolve(ctx.workingDirectory || process.cwd(), filePath);
    // 设计草稿目录下的产物豁免游戏校验（见上方 isDesignDraftArtifact 说明）。
    if (isDesignDraftArtifact(absolutePath)) return;
    // 验证分级：仅 goal 验收走完整游戏契约 + 运行时/视觉冒烟；普通聊天里随手生成的交互产物
    // 走轻校验，避免"能跑的休闲小游戏"被内部契约卡成"验收失败"。
    const fullContract = Boolean(ctx.goalMode?.isPending());
    const probe = await validateGameArtifact(absolutePath, {
      contractLevel: fullContract ? 'full' : 'light',
    });
    const repairTargetLostValidation =
      ctx.artifact.repairGuard?.targetFile &&
      isSameArtifactRepairPath(ctx, absolutePath, ctx.artifact.repairGuard.targetFile) &&
      !probe.shouldValidate;
    const effectiveProbe = repairTargetLostValidation
      ? buildRepairTargetLostValidationFailure(probe)
      : probe;
    const artifactCompletedWithoutFinal = completedAppendWithoutFinal(toolCall, probe);
    const shouldRunValidation =
      effectiveProbe.shouldValidate &&
      (!isAppendTool(toolCall.name) || toolCall.arguments?.final === true || effectiveProbe.isComplete);

    if (!shouldRunValidation) {
      // 普通网页 / 交互产物(light 契约且无需游戏验证)写完即视为合法完成。
      // 标记为已通过,关闭 Xiaomi text-first 的重复触发闸(inference.ts: !artifactValidationPassed),
      // 否则普通网页会被每轮当作新 artifact 反复生成(interactive-artifact-N),run 永不收敛。
      // 仅对"确实无需验证"(非 append 中途、非 repair)的产物生效,不影响游戏 artifact 的分阶段验收。
      if (!effectiveProbe.shouldValidate && !isAppendTool(toolCall.name) && !ctx.artifact.repairGuard) {
        ctx.artifact.setValidationPassed(absolutePath);
      }
      return;
    }

    runFinalizer.emitTaskProgress(
      'tool_running',
      effectiveProbe.passed
        ? '正在运行 artifact 可玩性验收...'
        : 'artifact 结构验收失败，正在准备修复上下文...',
    );
    const artifactValidationOptions: GameArtifactValidationOptions = {
      contractLevel: fullContract ? 'full' : 'light',
      runRuntimeSmoke: fullContract,
      runtimeSmokeTimeoutMs: GAME_VALIDATION_TIMEOUTS.RUNTIME_SMOKE_MS,
      requireRuntimeSmoke: fullContract,
      runBrowserVisualSmoke: fullContract,
      browserVisualSmokeTimeoutMs: GAME_VALIDATION_TIMEOUTS.BROWSER_VISUAL_SMOKE_MS,
      requireBrowserVisualSmoke: fullContract,
      allowBrowserVisualComputerFallback: false,
      // light 契约此前完全没有运行时证据（"验收通过"却交付一玩就崩的游戏，dogfood 实锤）。
      // 补一个只抓硬信号（未捕获异常/全黑画面）的可玩性冒烟；重契约 goal 模式已有完整 runtime smoke，不重复跑。
      runLightPlayabilitySmoke: !fullContract,
      lightPlayabilitySmokeTimeoutMs: GAME_VALIDATION_TIMEOUTS.LIGHT_PLAYABILITY_SMOKE_MS,
    };
    const rawValidation = await validateGameArtifact(absolutePath, artifactValidationOptions);
    const validation = repairTargetLostValidation && !rawValidation.shouldValidate
      ? buildRepairTargetLostValidationFailure(rawValidation)
      : rawValidation;
    const appendFinalHint = artifactCompletedWithoutFinal
      ? '检测到文件已经完整闭合，但这次 Append 没有设置 final=true；收尾块必须显式标 final=true，不能绕过最终验收。'
      : null;

    if (validation.shouldValidate && !validation.passed) {
      const failureMap = getArtifactValidationFailureMap(ctx);
      const previousFailure = failureMap.get(absolutePath);
      const attempts = (previousFailure?.attempts || 0) + 1;
      runFinalizer.emitTaskProgress(
        'tool_running',
        `artifact 验收失败，正在准备第 ${attempts}/${ARTIFACT_REPAIR_MAX_ATTEMPTS} 次修复...`,
      );
      ctx.artifact.clearValidationPassed();
      const postPatchContent = artifactRepairRollbackSnapshot?.filePath === absolutePath
        ? readFileSync(absolutePath, 'utf-8')
        : null;
      let rollbackApplied = restoreArtifactRepairRollbackSnapshot(artifactRepairRollbackSnapshot, absolutePath);
      const rollbackValidation = rollbackApplied
        ? await validateGameArtifact(absolutePath, artifactValidationOptions)
        : null;
      const repairSpec = createArtifactRepairSpec(validation);
      let rollbackRepairSpec = rollbackValidation && rollbackValidation.shouldValidate && !rollbackValidation.passed
        ? createArtifactRepairSpec(rollbackValidation)
        : null;
      const keepImprovedFailedPatch =
        rollbackApplied &&
        postPatchContent !== null &&
        shouldKeepImprovedFailedArtifactPatch({
          currentValidation: validation,
          currentRepairSpec: repairSpec,
          rollbackValidation,
          rollbackRepairSpec,
          repairTargetLostValidation: Boolean(repairTargetLostValidation),
        });
      if (keepImprovedFailedPatch) {
        writeFileSync(absolutePath, postPatchContent, 'utf-8');
        rollbackApplied = false;
        rollbackRepairSpec = null;
        await fileReadTracker.recordReadWithStats(absolutePath);
      } else if (rollbackApplied) {
        await refreshArtifactRepairReadStateAfterRollback(artifactRepairRollbackSnapshot, absolutePath);
      } else {
        // Repair mode may intentionally spend the target read budget because
        // the failed write content is already in conversation context. Keep
        // Edit's fileReadTracker safety state in sync with that decision.
        await fileReadTracker.recordReadWithStats(absolutePath);
      }
      const repairSpecBlock = formatArtifactRepairSpecForPrompt(repairSpec);
      const previousGuard = ctx.artifact.repairGuard?.targetFile === absolutePath
        ? ctx.artifact.repairGuard
        : undefined;
      // 策略裁决（patience + 修复/重写双信号）：先在既有状态上刷新 patience/streak，
      // 再决定本轮走补丁、切干净重写、还是（goal）降级放行。
      const failureState = { ...(previousFailure ?? {}), attempts } as ArtifactValidationFailureState;
      const strategy = decideArtifactRepairStrategy({
        state: failureState,
        failureCount: validation.failures.length,
        issueCodes: repairSpec.issues
          .map((issue) => issue.code)
          .filter((code): code is ArtifactRepairIssueCode => typeof code === 'string' && code.length > 0),
        goalPending: Boolean(ctx.goalMode?.isPending()),
      });
      let phase: ArtifactRepairPhase = attempts >= 3
        ? 'read_then_patch'
        : attempts >= 2
          ? 'targeted_repair'
          : 'baseline_repair';
      if (strategy.kind === 'switch_rewrite') {
        phase = 'fresh_rewrite';
        failureState.rewriteAttempted = true;
        runFinalizer.emitTaskProgress('tool_running', `补丁修复不收敛（${strategy.reason}），切换为干净重写...`);
      } else if (strategy.kind === 'degraded_release') {
        failureState.degradedReleasePending = strategy.reason;
        runFinalizer.emitTaskProgress('tool_running', 'artifact 修复不再有净进展，准备按最佳版本降级交付...');
      }
      failureState.phase = phase;
      failureMap.set(absolutePath, failureState);
      ctx.artifact.setRepairGuard({
        targetFile: absolutePath,
        attempts,
        phase,
        patched: false,
        repairTurnsWithoutProgress: previousGuard?.repairTurnsWithoutProgress,
        blockedToolTurnsWithoutProgress: previousGuard?.blockedToolTurnsWithoutProgress,
        lastBlockedTool: previousGuard?.lastBlockedTool,
        lastFailedPatchFingerprint: getArtifactRepairPatchFingerprint(toolCall) ?? previousGuard?.lastFailedPatchFingerprint,
        activeIssueCodes: [
          ...new Set([
            ...(
              Array.isArray(rollbackRepairSpec?.issues)
                ? rollbackRepairSpec.issues
                    .map((issue) => issue.code)
                    .filter((code): code is ArtifactRepairIssueCode => typeof code === 'string' && code.length > 0)
                : []
            ),
            ...(
              Array.isArray(repairSpec.issues)
                ? repairSpec.issues
                    .map((issue) => issue.code)
                    .filter((code): code is ArtifactRepairIssueCode => typeof code === 'string' && code.length > 0)
                : []
            ),
            ...(previousGuard?.activeIssueCodes || []),
          ]),
        ],
      });
      // Route A hard stop: bound the failing-patch loop. After
      // ARTIFACT_REPAIR_MAX_ATTEMPTS failed validation passes, force-stop
      // this turn instead of spending another model request on a patch
      // loop that is not converging.
      if (attempts >= ARTIFACT_REPAIR_MAX_ATTEMPTS) {
        activateArtifactRepairAdmissionStop(
          ctx,
          absolutePath,
          `${attempts}/${ARTIFACT_REPAIR_MAX_ATTEMPTS} attempts`,
          'attempts-exhausted',
        );
      }
      const validationError = [
        `Artifact validation failed for ${absolutePath}.`,
        repairSpec.summary,
        repairSpecBlock,
        keepImprovedFailedPatch
          ? 'The failed artifact repair patch improved validation and was kept as the next repair baseline.'
          : rollbackApplied
          ? 'The failed artifact repair patch was rolled back; edit from the last valid pre-patch file state.'
          : 'The failed artifact repair patch could not be rolled back automatically; inspect the target before continuing.',
        'The file was written, but it is not accepted as complete. Edit the existing file and run validation again before final response.',
      ].join('\n');
      contextAssembly.injectSystemMessage(
        [
          ...(appendFinalHint ? [appendFinalHint] : []),
          keepImprovedFailedPatch
            ? '本次修复补丁仍未完全通过 artifact validation，但失败项变少，已保留为下一轮修复基线；下一轮继续在当前目标文件上补齐剩余证据。'
            : rollbackApplied
            ? '本次修复补丁没有通过 artifact validation，已自动回滚到补丁前的目标文件状态；下一轮不要基于失败补丁继续修改。'
            : '本次修复补丁没有通过 artifact validation，且自动回滚失败；继续前必须先确认目标文件当前状态。',
          ...(strategy.kind === 'switch_rewrite'
            ? [[
                '<artifact-fresh-rewrite>',
                `补丁式修复已停用（${strategy.reason}）。改为一次性干净重写：`,
                `1. 用 Read 完整读取 ${absolutePath}（当前磁盘上是历史最佳版本，作为参照）。`,
                '2. 用一次 Write 输出完整的全新实现——不是在旧代码上打补丁，是带着下面失败清单的完整重写。',
                '3. 已通过的验收项不得回退：' + validation.checks.slice(0, 8).join('；'),
                '4. 这是唯一一次重写机会，重写后仍不通过将按最佳版本降级收尾。',
                '</artifact-fresh-rewrite>',
              ].join('\n')]
            : []),
          buildArtifactRepairInstruction(
            absolutePath,
            validation.failures,
            attempts,
            phase,
            repairSpecBlock,
            validation.browserVisualSmoke,
            repairSpec.issues.map((issue) => issue.code),
            ctx.scaffoldProfile?.repairInstructionStyle ?? 'full',
          ),
        ].join('\n')
      );
      toolResult.success = false;
      toolResult.output = undefined;
      toolResult.error = validationError;
      toolResult.metadata = {
        ...toolResult.metadata,
        artifactRepairRollback: {
          attempted: Boolean(artifactRepairRollbackSnapshot),
          applied: rollbackApplied,
          keptImprovedPatch: keepImprovedFailedPatch,
          targetFile: absolutePath,
        },
        artifactValidation: {
          failed: true,
          attempts,
          phase,
          inferredKind: validation.inferredKind,
          failures: validation.failures,
          checks: validation.checks,
          runtimeSmoke: validation.runtimeSmoke,
          browserVisualSmoke: validation.browserVisualSmoke,
          playabilitySmoke: validation.playabilitySmoke,
          repairSpec,
        },
      };
    } else if (validation.shouldValidate && (validation.checks.length > 0 || appendFinalHint)) {
      runFinalizer.emitTaskProgress('tool_running', 'artifact 验收通过');
      getArtifactValidationFailureMap(ctx).delete(absolutePath);
      if (ctx.artifact.repairGuard?.targetFile === absolutePath) {
        ctx.artifact.markValidationPassed(absolutePath);
      } else {
        ctx.artifact.setValidationPassed(absolutePath);
      }
      contextAssembly.injectSystemMessage(
        [
          '<artifact-validation-passed kind="interactive_artifact">',
          ...(ctx.goalMode?.isPending()
            ? [
                'The artifact already passed validation. Do not rewrite it again.',
                'Goal mode is still pending, so the next action must call attempt_completion with concise evidence.',
              ]
            : []),
          ...(appendFinalHint ? [appendFinalHint] : []),
          ...validation.checks.map((check, index) => `${index + 1}. ${check}`),
          '</artifact-validation-passed>',
        ].join('\n')
      );
      await completePendingGoalAfterArtifactValidation({
        ctx,
        contextAssembly,
        absolutePath,
      });
    }
  } catch (error) {
    // 校验器自身崩溃 ≠ 产物合格。不阻塞交付，但必须留下"未验证"的可见痕迹：
    // warn 日志 + toolResult 元数据标记，禁止再静默降级成 debug 后当作通过。
    const message = error instanceof Error ? error.message : String(error);
    logger.warn('[AgentLoop] artifact validation crashed; artifact delivered unverified', {
      error: message,
      filePath,
    });
    toolResult.metadata = {
      ...toolResult.metadata,
      artifactValidation: {
        failed: false,
        crashed: true,
        error: message,
      },
    };
  }
}

async function completePendingGoalAfterArtifactValidation({
  ctx,
  contextAssembly,
  absolutePath,
}: {
  ctx: RuntimeContext;
  contextAssembly: ContextAssembly;
  absolutePath: string;
}): Promise<void> {
  const goalMode = ctx.goalMode;
  if (!goalMode?.isPending()) return;

  const summary = `Artifact validation passed for ${absolutePath}.`;
  goalMode.requestCompletion(summary);

  const verifyCommand = goalMode.getVerifyCommand();
  if (verifyCommand) {
    const gate = await runVerifyGate(verifyCommand, ctx.workingDirectory);
    ctx.onEvent({
      type: 'goal_gate',
      data: { gate: 1, pass: gate.pass, exitCode: gate.exitCode, timedOut: gate.timedOut },
    });
    if (!gate.pass) {
      ctx.artifact.clearValidationPassed();
      goalMode.clearCompletionRequest();
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
      return;
    }
  }

  const reviewCondition = goalMode.getReviewCondition();
  if (reviewCondition) {
    const review = await runReviewGate(reviewCondition, goalMode.getGoal(), {
      workingDirectory: ctx.workingDirectory,
      sessionId: ctx.sessionId,
      abortSignal: ctx.control.runAbortController?.signal,
      hookManager: ctx.hookManager,
    });
    ctx.onEvent({
      type: 'goal_gate',
      data: { gate: 2, pass: review.pass, reason: review.reason },
    });
    if (!review.pass) {
      ctx.artifact.clearValidationPassed();
      goalMode.clearCompletionRequest();
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
      return;
    }
  }

  goalMode.markMet();
  const passedGates = [
    `artifact validation passed for ${absolutePath}`,
    verifyCommand ? `验证命令 \`${verifyCommand}\` 退出码 0` : null,
    reviewCondition ? '软评审通过' : null,
  ].filter(Boolean).join('、');
  contextAssembly.injectSystemMessage(
    `<goal-verified>\n${passedGates}，目标达成，结束本次 goal。\n</goal-verified>`,
  );
}
