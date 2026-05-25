import { readFileSync, writeFileSync } from 'fs';
import { isAbsolute, resolve } from 'path';
import type { ToolCall, ToolResult } from '../../../shared/contract';
import { ARTIFACT_REPAIR_MAX_ATTEMPTS } from '../../../shared/constants/repair';
import { fileReadTracker } from '../../tools/fileReadTracker';
import { createLogger } from '../../services/infra/logger';
import { runReviewGate } from '../goalReviewGate';
import { runVerifyGate } from '../goalVerifyGate';
import type { ArtifactRepairIssueCode } from './artifactRepairSpec';
import { createArtifactRepairSpec, formatArtifactRepairSpecForPrompt } from './artifactRepairSpec';
import { activateArtifactRepairAdmissionStop } from './artifactRepairAdmission';
import { isSameArtifactRepairPath } from './artifactRepairGuard';
import { validateGameArtifact } from './gameArtifactValidator';
import { buildXiaomiBreakoutEnhancementInstruction } from './contextAssembly/xiaomiArtifactTextFirst';
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
  shouldValidateModifiedArtifact,
  type ArtifactRepairPhase,
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
    const probe = await validateGameArtifact(absolutePath);
    const repairTargetLostValidation =
      ctx.artifactRepairGuard?.targetFile &&
      isSameArtifactRepairPath(ctx, absolutePath, ctx.artifactRepairGuard.targetFile) &&
      !probe.shouldValidate;
    const effectiveProbe = repairTargetLostValidation
      ? buildRepairTargetLostValidationFailure(probe)
      : probe;
    const artifactCompletedWithoutFinal = completedAppendWithoutFinal(toolCall, probe);
    const shouldRunValidation =
      effectiveProbe.shouldValidate &&
      (!isAppendTool(toolCall.name) || toolCall.arguments?.final === true || effectiveProbe.isComplete);

    if (!shouldRunValidation) {
      return;
    }

    runFinalizer.emitTaskProgress(
      'tool_running',
      effectiveProbe.passed
        ? '正在运行 artifact 可玩性验收...'
        : 'artifact 结构验收失败，正在准备修复上下文...',
    );
    const artifactValidationOptions = {
      runRuntimeSmoke: true,
      runtimeSmokeTimeoutMs: 7000,
      requireRuntimeSmoke: true,
      runBrowserVisualSmoke: true,
      browserVisualSmokeTimeoutMs: 10000,
      requireBrowserVisualSmoke: true,
      allowBrowserVisualComputerFallback: false,
    } as const;
    const rawValidation = await validateGameArtifact(absolutePath, artifactValidationOptions);
    const validation = repairTargetLostValidation && !rawValidation.shouldValidate
      ? buildRepairTargetLostValidationFailure(rawValidation)
      : rawValidation;
    const appendFinalHint = artifactCompletedWithoutFinal
      ? '检测到文件已经完整闭合，但这次 Append 没有设置 final=true；收尾块必须显式标 final=true，不能绕过最终验收。'
      : null;

    if (validation.shouldValidate && !validation.passed) {
      runFinalizer.emitTaskProgress('tool_running', 'artifact 验收失败，正在准备修复指令...');
      ctx.artifactValidationPassedTargetFile = undefined;
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
      const failureMap = getArtifactValidationFailureMap(ctx);
      const previousFailure = failureMap.get(absolutePath);
      const previousGuard = ctx.artifactRepairGuard?.targetFile === absolutePath
        ? ctx.artifactRepairGuard
        : undefined;
      const attempts = (previousFailure?.attempts || 0) + 1;
      const phase: ArtifactRepairPhase = attempts >= 3
        ? 'read_then_patch'
        : attempts >= 2
          ? 'targeted_repair'
          : 'baseline_repair';
      failureMap.set(absolutePath, { attempts, phase });
      ctx.artifactRepairGuard = {
        targetFile: absolutePath,
        attempts,
        phase,
        patched: false,
        repairTurnsWithoutProgress: previousGuard?.repairTurnsWithoutProgress,
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
      };
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
          buildArtifactRepairInstruction(
            absolutePath,
            validation.failures,
            attempts,
            phase,
            repairSpecBlock,
            validation.browserVisualSmoke,
            repairSpec.issues.map((issue) => issue.code),
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
          repairSpec,
        },
      };
    } else if (validation.shouldValidate && (validation.checks.length > 0 || appendFinalHint)) {
      runFinalizer.emitTaskProgress('tool_running', 'artifact 验收通过');
      getArtifactValidationFailureMap(ctx).delete(absolutePath);
      if (ctx.artifactRepairGuard?.targetFile === absolutePath) {
        ctx.artifactRepairGuard = undefined;
      }
      const xiaomiEnhancementRequested = maybeRequestXiaomiBreakoutEnhancement({
        ctx,
        contextAssembly,
        runFinalizer,
        absolutePath,
        checks: validation.checks,
        appendFinalHint,
      });
      if (xiaomiEnhancementRequested) {
        return;
      }

      ctx.artifactValidationPassedTargetFile = absolutePath;
      if (
        ctx.xiaomiArtifactTwoStage?.kind === 'breakout' &&
        ctx.xiaomiArtifactTwoStage.phase === 'enhance_pending' &&
        isSameArtifactRepairPath(ctx, absolutePath, ctx.xiaomiArtifactTwoStage.targetFile)
      ) {
        ctx.xiaomiArtifactTwoStage = {
          ...ctx.xiaomiArtifactTwoStage,
          phase: 'done',
        };
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
    logger.debug('[AgentLoop] game artifact validation skipped', {
      error: error instanceof Error ? error.message : String(error),
      filePath,
    });
  }
}

function maybeRequestXiaomiBreakoutEnhancement({
  ctx,
  contextAssembly,
  runFinalizer,
  absolutePath,
  checks,
  appendFinalHint,
}: {
  ctx: RuntimeContext;
  contextAssembly: ContextAssembly;
  runFinalizer: RunFinalizer;
  absolutePath: string;
  checks: string[];
  appendFinalHint: string | null;
}): boolean {
  const twoStage = ctx.xiaomiArtifactTwoStage;
  if (twoStage?.kind !== 'breakout' || twoStage.phase !== 'core_pending') {
    return false;
  }
  if (!isSameArtifactRepairPath(ctx, absolutePath, twoStage.targetFile)) {
    return false;
  }

  ctx.xiaomiArtifactTwoStage = {
    ...twoStage,
    phase: 'enhance_pending',
  };
  ctx.artifactValidationPassedTargetFile = undefined;
  ctx.forceFinalResponseReason = undefined;
  ctx.forceFinalResponsePrompt = undefined;
  runFinalizer.emitTaskProgress('tool_running', '核心版本已验收通过，准备二阶段体验增强...');
  contextAssembly.injectSystemMessage(
    [
      '<artifact-validation-passed kind="interactive_artifact" stage="xiaomi-core">',
      'The first-stage playable core passed validation. Do not finish the turn yet.',
      ...(appendFinalHint ? [appendFinalHint] : []),
      ...checks.map((check, index) => `${index + 1}. ${check}`),
      '</artifact-validation-passed>',
      buildXiaomiBreakoutEnhancementInstruction(absolutePath),
    ].join('\n'),
  );
  return true;
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
      ctx.artifactValidationPassedTargetFile = undefined;
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
      abortSignal: ctx.runAbortController?.signal,
      hookManager: ctx.hookManager,
    });
    ctx.onEvent({
      type: 'goal_gate',
      data: { gate: 2, pass: review.pass, reason: review.reason },
    });
    if (!review.pass) {
      ctx.artifactValidationPassedTargetFile = undefined;
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
