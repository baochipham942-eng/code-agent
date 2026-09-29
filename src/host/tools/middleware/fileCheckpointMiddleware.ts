// src/host/tools/middleware/fileCheckpointMiddleware.ts

import { getFileCheckpointService } from '../../services/checkpoint';
import { createLogger } from '../../services/infra/logger';
import path from 'node:path';
import type { ToolDefinition } from '../../../shared/contract';
import type { WorkspaceScope } from '../../../shared/contract/project';
import { resolveWorkspacePath } from '../../runtime/workspaceScope';
import { resolveToolWriteTargets } from '../writeTargets';

const logger = createLogger('FileCheckpointMiddleware');

// /dev/null 豁免与写边界闸同口径（toolExecutor 的 bash 写目标边界）：空汇无数据落盘，
// 为它落一行「原本不存在」的快照只会在回退时制造一次假删除。只豁免这一个字符设备。
const UNSNAPSHOTABLE_DEVICES = new Set(['/dev/null']);

/**
 * 检查点上下文提供者
 */
export interface CheckpointContext {
  sessionId: string;
  messageId: string;
  workspaceScope?: WorkspaceScope;
}

export type CheckpointContextProvider = () => CheckpointContext | null;

export interface CreatedFileCheckpoint {
  checkpointId: string;
  filePath: string;
}

/**
 * 在工具执行前按**写目标**创建检查点（不枚举工具名）。
 * 判据是 resolveToolWriteTargets：Bash 重定向、MCP、文档类写盘工具都按各自
 * 声明/暴露的目标入快照；解析不出的目标（含通配/变量的重定向）落 uncertain
 * 记录，回退时逐条进 skippedFiles 披露。
 */
export async function createFileCheckpointIfNeeded(
  definition: ToolDefinition,
  params: Record<string, unknown>,
  getContext: CheckpointContextProvider,
  workingDirectory: string,
): Promise<CreatedFileCheckpoint[]> {
  // 只读工具没有写目标可快照
  if (definition.permissionLevel === 'read') {
    return [];
  }

  const context = getContext();
  if (!context) {
    logger.debug('No checkpoint context available');
    return [];
  }

  // 相对目标锚调用自身的执行基准：带 working_directory 的调用（Bash）以其为锚
  // （bindRunScopedParams 已把它约束进 scope 并规范化成绝对路径），其余锚会话 cwd。
  const effectiveWorkingDirectory = typeof params.working_directory === 'string'
    && params.working_directory.trim()
    ? path.resolve(workingDirectory, params.working_directory)
    : workingDirectory;

  const { targets, uncertain } = resolveToolWriteTargets({
    definition,
    params,
    workingDirectory: effectiveWorkingDirectory,
  });

  const created: CreatedFileCheckpoint[] = [];
  try {
    const service = getFileCheckpointService();
    for (const filePath of targets) {
      if (UNSNAPSHOTABLE_DEVICES.has(filePath)) continue;
      const match = context.workspaceScope
        ? resolveWorkspacePath(context.workspaceScope, filePath, 'read_write')
        : undefined;
      const checkpointId = await service.createCheckpoint(context.sessionId, context.messageId, filePath, {
        sourceId: match?.root.sourceId,
        workspaceScopeVersion: context.workspaceScope?.version,
      });
      if (checkpointId) created.push({ checkpointId, filePath });
    }
    for (const target of uncertain) {
      await service.recordUncertainWriteTarget(context.sessionId, context.messageId, target, {
        workspaceScopeVersion: context.workspaceScope?.version,
      });
    }
  } catch (error) {
    // 检查点失败不应阻止工具执行；已建成的照常返回，供执行成功后收 digest
    logger.error('Failed to create checkpoint', { error, toolName: definition.name, targets });
  }
  return created;
}
