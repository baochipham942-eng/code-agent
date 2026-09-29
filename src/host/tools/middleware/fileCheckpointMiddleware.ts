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
// 判据是启发式（审查 Nit）：参数名成对不保证语义真是移动——copy 类工具不动源，
// 多快照一个 digest 不变的文件，回退时原样重写，无害且保守，不做工具声明级区分。
const MOVE_SOURCE_PARAMETERS = ['source', 'from'] as const;
const MOVE_DESTINATION_PARAMETERS = ['destination', 'dest'] as const;

interface MoveTargetAssessment {
  /** 移动操作的源（执行前内容也要进快照的路径），绝对路径。 */
  sources: string[];
  /** 干净解析出的移动目的地（与写目标同一条词法），绝对路径：配对判据用。 */
  destinations: string[];
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
  const destinations: string[] = [];
  const blockedDestinations = new Set<string>();
  const uncertain: string[] = [];
  for (const descriptor of definition.pathAuthority ?? []) {
    if (descriptor.kind !== 'shell') continue;
    const command = params[descriptor.commandParameter];
    if (typeof command !== 'string') continue;
    const assessment = assessShellMoveSources(command, workingDirectory);
    sources.push(...assessment.sources);
    destinations.push(...assessment.destinations);
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
      destinations.push(resolveToolPath(params[destinationParameter] as string, workingDirectory));
    } else {
      // 移动形状成立但源不是可用字符串：整个调用按 uncertain，目的地快照一并撤下
      uncertain.push(`uncertain-move:${sourceParameter}`);
      blockedDestinations.add(resolveToolPath(params[destinationParameter] as string, workingDirectory));
    }
  }
  return { sources, destinations, blockedDestinations, uncertain };
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
 * **源**与目的地一起入快照——源记执行前内容，回退时恢复源；两侧必须成对建出
 * **无损**快照，任何一侧建不出（解析不出 / 超大 / 读错误 / 二进制），整次调用
 * 不进回退，全部目标逐条 uncertain 披露（返修 r2）。
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
      .filter((filePath) => !moveTargets.blockedDestinations.has(filePath)
        && !UNSNAPSHOTABLE_DEVICES.has(filePath))
      .sort();
    // 一次移动操作的源与目的地快照必须**成对成功**（返修 r2）：任何一侧建不出无损快照
    // （超大、读错误、二进制——createCheckpoint 对它们返 null 或按 utf-8 有损存入），
    // 留下的目的地快照会让回退把目的地删掉 / 换成损坏内容，而源无人恢复——文件永久
    // 丢失。此时丢弃这次调用里所有相关快照，整次调用不进回退（与 main 一致）。
    const movePairPaths = new Set(
      [...moveTargets.sources, ...moveTargets.destinations]
        .filter((filePath) => !moveTargets.blockedDestinations.has(filePath)
          && !UNSNAPSHOTABLE_DEVICES.has(filePath)),
    );
    const service = getFileCheckpointService();
    // 资格预检（成对成功的第一道）：逐目标问 service 能否无损快照
    let pairBroken = false;
    const snapshotableTargets: string[] = [];
    for (const filePath of snapshotTargets) {
      const eligibility = await service.assessSnapshotEligibility(filePath);
      if (!eligibility.eligible && movePairPaths.has(filePath)) pairBroken = true;
      if (eligibility.snapshotable) snapshotableTargets.push(filePath);
    }
    const discloseWholeCall = async (): Promise<CreatedFileCheckpoint[]> => {
      // 全部目标逐条落 uncertain 披露：回退时进 skippedFiles（「无法安全快照」），不碰文件
      const keys = [...new Set([...uncertain, ...moveTargets.uncertain, ...snapshotTargets])].sort();
      for (const key of keys) {
        await service.recordUncertainWriteTarget(context.sessionId, context.messageId, key, {
          workspaceScopeVersion: context.workspaceScope?.version,
        });
      }
      return [];
    };
    if (pairBroken) return await discloseWholeCall();
    // 配对成员先建：资格通过后 createCheckpoint 仍可能失败（DB 层错误），任何一侧没
    // 建成，这次调用已建成的行整单撤下——不允许半对快照留在回退窗口里。
    const orderedTargets = [
      ...snapshotableTargets.filter((filePath) => movePairPaths.has(filePath)),
      ...snapshotableTargets.filter((filePath) => !movePairPaths.has(filePath)),
    ];
    for (const filePath of orderedTargets) {
      const match = context.workspaceScope
        ? resolveWorkspacePath(context.workspaceScope, filePath, 'read_write')
        : undefined;
      const checkpointId = await service.createCheckpoint(context.sessionId, context.messageId, filePath, {
        sourceId: match?.root.sourceId,
        workspaceScopeVersion: context.workspaceScope?.version,
      });
      if (checkpointId) {
        created.push({ checkpointId, filePath });
      } else if (movePairPaths.has(filePath)) {
        const removed = service.deleteCheckpoints(created.map((entry) => entry.checkpointId));
        if (removed < created.length) {
          logger.error('Failed to retract checkpoints after a broken move pair', {
            toolName: definition.name,
            createdCount: created.length,
            removed,
          });
        }
        return await discloseWholeCall();
      }
    }
    // 没落到快照行的目标（目录这类建不出行的、资格外的）不静默降级：逐条 uncertain 披露
    const createdPaths = new Set(created.map((entry) => entry.filePath));
    for (const key of [
      ...new Set([
        ...uncertain,
        ...moveTargets.uncertain,
        ...snapshotTargets.filter((filePath) => !createdPaths.has(filePath)),
      ]),
    ].sort()) {
      await service.recordUncertainWriteTarget(context.sessionId, context.messageId, key, {
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
