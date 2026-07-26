import type { ToolCall, ToolResult } from '../../../shared/contract';
import type { ToolExecutionResult } from '../../tools/types';
import type { RuntimeContext } from './runtimeContext';
import { isSameArtifactRepairPath } from './artifactRepairGuard';
import { getModifiedFilePath, isFileMutationTool } from './toolArtifactRepairPolicy';

type TrackFileMutationSideEffectsArgs = {
  ctx: RuntimeContext;
  toolCall: ToolCall;
  normalizedResult: ToolExecutionResult;
  toolResult: ToolResult;
};

/**
 * 工具执行成功后的文件改动副作用跟踪（P3 Nudge 完成度跟踪）。
 * 纯副作用、不影响控制流；从 executeSingleTool 内联块抽取，行为保持不变。
 */
export async function trackFileMutationSideEffects({
  ctx,
  toolCall,
  normalizedResult,
  toolResult,
}: TrackFileMutationSideEffectsArgs): Promise<void> {
  // P3 Nudge: Track modified files for completion checking
  if (isFileMutationTool(toolCall.name) && normalizedResult.success) {
    const filePath = getModifiedFilePath(toolCall);
    if (filePath) {
      ctx.nudgeManager.trackModifiedFile(filePath);

      // Mark as agent-modified to avoid false external change alerts
      try {
        const { getFileWatcherService } = await import('../../services/git/fileWatcherService');
        const path = await import('path');
        const absolutePath = path.default.isAbsolute(filePath)
          ? filePath
          : path.default.resolve(ctx.workingDirectory || process.cwd(), filePath);
        getFileWatcherService().markAsAgentModified(absolutePath);
      } catch { /* ignore */ }

      if (
        ctx.artifact.repairGuard?.targetFile &&
        isSameArtifactRepairPath(ctx, filePath, ctx.artifact.repairGuard.targetFile)
      ) {
        if (toolResult.success !== false) {
          ctx.artifact.markTargetPatched();
        }
      }
    }
  }
}
