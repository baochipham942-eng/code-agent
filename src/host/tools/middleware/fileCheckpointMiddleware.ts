// src/host/tools/middleware/fileCheckpointMiddleware.ts

import { getFileCheckpointService } from '../../services/checkpoint';
import { createLogger } from '../../services/infra/logger';
import path from 'node:path';
import type { ToolDefinition } from '../../../shared/contract';
import type { WorkspaceScope } from '../../../shared/contract/project';
import { resolveWorkspacePath } from '../../runtime/workspaceScope';
import { assessShellMoveSources, resolveToolPath, resolveToolWriteTargets } from '../writeTargets';

const logger = createLogger('FileCheckpointMiddleware');

// /dev/null 豁免与写边界闸同口径（toolExecutor 的 bash 写目标边界）：空汇无数据落盘，
// 为它落一行「原本不存在」的快照只会在回退时制造一次假删除。只豁免这一个字符设备。
const UNSNAPSHOTABLE_DEVICES = new Set(['/dev/null']);

// MCP 移动类工具（move_file / copy_file 一族）的通用参数形状：source/from 与
// destination/dest 成对出现。destination 走通用 path-like 扫描已入快照，这里补源。
const MOVE_SOURCE_PARAMETERS = ['source', 'from'] as const;
const MOVE_DESTINATION_PARAMETERS = ['destination', 'dest'] as const;

interface MoveTargetAssessment {
  /** 移动操作的源（执行前内容也要进快照的路径），绝对路径。 */
  sources: string[];
  /** 源解析不出的移动段的目的地：这些目的地的快照必须撤下（不能只快照一半）。 */
  blockedDestinations: Set<string>;
  /** 源解析不出的移动操作的披露键。 */
  uncertain: string[];
}

function assessMoveTargets(
  definition: ToolDefinition,
  params: Record<string, unknown>,
  workingDirectory: string,
): MoveTargetAssessment {
  const sources: string[] = [];
  const blockedDestinations = new Set<string>();
  const uncertain: string[] = [];
  for (const descriptor of definition.pathAuthority ?? []) {
    if (descriptor.kind !== 'shell') continue;
    const command = params[descriptor.commandParameter];
    if (typeof command !== 'string') continue;
    const assessment = assessShellMoveSources(command, workingDirectory);
    sources.push(...assessment.sources);
    assessment.blockedDestinations.forEach((destination) => blockedDestinations.add(destination));
    uncertain.push(...assessment.uncertain);
  }
  const sourceParameter = MOVE_SOURCE_PARAMETERS.find((key) => params[key] !== undefined);
  const destinationParameter = MOVE_DESTINATION_PARAMETERS.find(
    (key) => typeof params[key] === 'string' && (params[key] as string).trim() !== '',
  );
  if (sourceParameter && destinationParameter) {
    const rawSource = params[sourceParameter];
    if (typeof rawSource === 'string' && rawSource.trim() !== '') {
      sources.push(resolveToolPath(rawSource, workingDirectory));
    } else {
      // 移动形状成立但源不是可用字符串：整个调用按 uncertain，目的地快照一并撤下
      uncertain.push(`uncertain-move:${sourceParameter}`);
      blockedDestinations.add(resolveToolPath(params[destinationParameter] as string, workingDirectory));
    }
  }
  return { sources, blockedDestinations, uncertain };
}

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
 * 记录，回退时逐条进 skippedFiles 披露。移动/重命名类操作（mv、MCP move）的
 * **源**与目的地一起入快照——源记执行前内容，回退时恢复源。
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

  const created: CreatedFileCheckpoint[] = [];
  try {
    // 写目标解析也在 try 内：符号链接环等异常不允许打断工具执行（fail-open）
    const { targets, uncertain } = resolveToolWriteTargets({
      definition,
      params,
      workingDirectory: effectiveWorkingDirectory,
    });
    // 移动/重命名类操作（Bash mv、MCP move）的源也进快照：只快照目的地，回退时目的地被
    // 恢复/删除而源无人恢复，内容会从工作区彻底消失。源解析不出的整段按 uncertain 处理
    // ——目的地快照一并撤下，回退不碰，而不是只快照一半。
    const moveTargets = assessMoveTargets(definition, params, effectiveWorkingDirectory);
    const snapshotTargets = [...new Set([...targets, ...moveTargets.sources])]
      .filter((filePath) => !moveTargets.blockedDestinations.has(filePath))
      .sort();
    const service = getFileCheckpointService();
    for (const filePath of snapshotTargets) {
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
    for (const target of [...uncertain, ...moveTargets.uncertain]) {
      await service.recordUncertainWriteTarget(context.sessionId, context.messageId, target, {
        workspaceScopeVersion: context.workspaceScope?.version,
      });
    }
  } catch (error) {
    // 检查点失败不应阻止工具执行；已建成的照常返回，供执行成功后收 digest
    logger.error('Failed to create checkpoint', {
      error,
      toolName: definition.name,
      workingDirectory: effectiveWorkingDirectory,
      createdCount: created.length,
    });
  }
  return created;
}
