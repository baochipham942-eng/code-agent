import type { RuntimeContext } from './runtimeContext';
import { ARTIFACT_REPAIR_STOP_PREFIXES } from './artifactRepairAdmission';

// Surface an artifact-repair force-stop to the UI as an error event. Handles
// unavailable-tool spam and attempt-limit exhaustion without changing run state.
export function emitArtifactRepairStopError(ctx: RuntimeContext, stopReason: string): void {
  const targetFile = ctx.artifact.repairGuard?.targetFile ?? '目标文件';
  const unavailablePrefix = ARTIFACT_REPAIR_STOP_PREFIXES['unavailable-tool'];
  const attemptsPrefix = ARTIFACT_REPAIR_STOP_PREFIXES['attempts-exhausted'];
  if (stopReason.startsWith(unavailablePrefix)) {
    const detail = stopReason.slice(unavailablePrefix.length).trim();
    ctx.onEvent({
      type: 'error',
      data: {
        message: `产物修复终止:模型反复请求不可用工具 ${detail},已停止本轮尝试`,
        code: 'artifact_repair_admission_stop',
        suggestion: `目标文件 ${targetFile} 仍需要应用修复变更。建议重新发起任务,或检查目标文件当前状态后再继续。`,
        details: { targetFile, blockedTool: detail },
      },
    });
  } else if (stopReason.startsWith(attemptsPrefix)) {
    const detail = stopReason.slice(attemptsPrefix.length).trim();
    ctx.onEvent({
      type: 'error',
      data: {
        message: `产物修复终止:修复尝试达到上限(${detail}),已停止本轮尝试`,
        code: 'artifact_repair_admission_stop',
        suggestion: `目标文件 ${targetFile} 仍未通过校验。建议重新发起任务,或检查目标文件当前状态后再继续。`,
        details: { targetFile, attempts: detail },
      },
    });
  }
}
