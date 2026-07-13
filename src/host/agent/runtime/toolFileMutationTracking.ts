import type { ToolCall, ToolResult } from '../../../shared/contract';
import type { ToolExecutionResult } from '../../tools/types';
import { createLogger } from '../../services/infra/logger';
import { getDiffTracker } from '../../services/diff/diffTracker';
import type { RuntimeContext } from './runtimeContext';
import { isSameArtifactRepairPath } from './artifactRepairGuard';
import { getModifiedFilePath, isFileMutationTool } from './toolArtifactRepairPolicy';

const logger = createLogger('AgentLoop');

type TrackFileMutationSideEffectsArgs = {
  ctx: RuntimeContext;
  toolCall: ToolCall;
  normalizedResult: ToolExecutionResult;
  toolResult: ToolResult;
};

/**
 * 工具执行成功后的文件改动副作用跟踪（P3 Nudge 完成度跟踪 + E3 diff 计算）。
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

      // E3: Diff tracking - compute and emit diff_computed event
      if (ctx.sessionId) {
        try {
          const diffTracker = getDiffTracker();
          const fs = await import('fs/promises');
          const path = await import('path');
          const absolutePath = path.default.isAbsolute(filePath)
            ? filePath
            : path.default.resolve(ctx.workingDirectory || process.cwd(), filePath);
          // Read current file content (after write/edit)
          let afterContent: string | null = null;
          try {
            afterContent = await fs.default.readFile(absolutePath, 'utf-8');
          } catch {
            // File may not exist after failed write
          }
          // before content is captured by FileCheckpointService - we use null here
          // The diff shows the full file as "added" for new files
          const messageId = toolCall.id;
          const diff = diffTracker.computeAndStore(
            ctx.sessionId,
            messageId,
            toolCall.id,
            absolutePath,
            null, // before state is in checkpoint
            afterContent
          );
          ctx.onEvent({ type: 'diff_computed', data: diff });
        } catch (error) {
          logger.debug('Failed to compute diff:', error);
        }
      }

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
