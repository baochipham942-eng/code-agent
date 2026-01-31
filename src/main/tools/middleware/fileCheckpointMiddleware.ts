// src/main/tools/middleware/fileCheckpointMiddleware.ts

import { getFileCheckpointService } from '../../services/checkpoint';
import { createLogger } from '../../services/infra/logger';

const logger = createLogger('FileCheckpointMiddleware');

// 需要创建检查点的工具
const FILE_WRITE_TOOLS = ['write_file', 'edit_file'];

/**
 * 检查点上下文提供者
 */
export interface CheckpointContext {
  sessionId: string;
  messageId: string;
}

export type CheckpointContextProvider = () => CheckpointContext | null;

/**
 * 在文件写入工具执行前创建检查点
 */
export async function createFileCheckpointIfNeeded(
  toolName: string,
  params: Record<string, unknown>,
  getContext: CheckpointContextProvider
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

  const filePath = (params.file_path || params.path) as string | undefined;
  if (!filePath) {
    logger.debug('No file path in params', { toolName });
    return;
  }

  try {
    const service = getFileCheckpointService();
    await service.createCheckpoint(context.sessionId, context.messageId, filePath);
  } catch (error) {
    // 检查点失败不应阻止工具执行
    logger.error('Failed to create checkpoint', { error, toolName, filePath });
  }
}
