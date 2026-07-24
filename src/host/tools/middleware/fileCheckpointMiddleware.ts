// src/host/tools/middleware/fileCheckpointMiddleware.ts

import { getFileCheckpointService } from '../../services/checkpoint';
import { createLogger } from '../../services/infra/logger';
import path from 'node:path';
import type { WorkspaceScope } from '../../../shared/contract/project';
import { resolveWorkspacePath } from '../../runtime/workspaceScope';

const logger = createLogger('FileCheckpointMiddleware');

// 需要创建检查点的工具（含 PascalCase 别名）
const FILE_WRITE_TOOLS = ['write_file', 'append_file', 'edit_file', 'Write', 'Append', 'Edit'];

/**
 * 检查点上下文提供者
 */
export interface CheckpointContext {
  sessionId: string;
  messageId: string;
  workspaceScope?: WorkspaceScope;
}

export type CheckpointContextProvider = () => CheckpointContext | null;

/**
 * 在文件写入工具执行前创建检查点
 */
export async function createFileCheckpointIfNeeded(
  toolName: string,
  params: Record<string, unknown>,
  getContext: CheckpointContextProvider,
  workingDirectory?: string,
): Promise<void> {
  // 只对文件写入工具创建检查点
  if (!FILE_WRITE_TOOLS.includes(toolName)) {
    return;
  }

  const context = getContext();
  if (!context) {
    logger.debug('No checkpoint context available');
    return;
  }

  const rawFilePath = (params.file_path || params.path) as string | undefined;
  if (!rawFilePath) {
    logger.debug('No file path in params', { toolName });
    return;
  }
  const filePath = workingDirectory && !path.isAbsolute(rawFilePath)
    ? path.resolve(workingDirectory, rawFilePath)
    : rawFilePath;

  try {
    const service = getFileCheckpointService();
    const match = context.workspaceScope
      ? resolveWorkspacePath(context.workspaceScope, filePath, 'read_write')
      : undefined;
    await service.createCheckpoint(context.sessionId, context.messageId, filePath, {
      sourceId: match?.root.sourceId,
      workspaceScopeVersion: context.workspaceScope?.version,
    });
  } catch (error) {
    // 检查点失败不应阻止工具执行
    logger.error('Failed to create checkpoint', { error, toolName, filePath });
  }
}
