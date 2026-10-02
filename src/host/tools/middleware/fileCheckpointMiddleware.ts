// src/host/tools/middleware/fileCheckpointMiddleware.ts

import { getFileCheckpointService } from '../../services/checkpoint';
import { createLogger } from '../../services/infra/logger';
import path from 'node:path';
import type { ToolDefinition } from '../../../shared/contract';
import type { WorkspaceScope } from '../../../shared/contract/project';
import { isPathWithinRoot, resolveWorkspacePath } from '../../runtime/workspaceScope';
import { declaredMcpWritePathParameters, resolveCheckpointWriteTargets, resolveToolPath } from '../writeTargets';

const logger = createLogger('FileCheckpointMiddleware');

// /dev/null 豁免与写边界闸同口径（toolExecutor 的 bash 写目标边界）：空汇无数据落盘，
// 为它落一行「原本不存在」的快照只会在回退时制造一次假删除。只豁免这一个字符设备。
const UNSNAPSHOTABLE_DEVICES = new Set(['/dev/null']);

// origin/main 检查点白名单（FILE_WRITE_TOOLS 原值照抄，返修 r5 下限）：main 按这六个
// 名字（含 snake_case 别名）取 params.file_path || params.path 建快照。r4 起判据换成
// resolveCheckpointWriteTargets 后它只认 schema 声明，而 Append（含 append_file 别名）
// 的 schema 从未声明 pathAuthority → 零目标零披露，比 main 少建快照。不变量：main 会
// 建检查点的每一种调用必须照样建，只许多不许少——命中的调用按 main 的取数方式补目标，
// 新的写目标解析只在此之上追加（Bash 单目标写入、docx 声明路径等）。判断面是
// definition.name 与 definition.aliases：registry 里 snake_case 旧名不再注册，但任何
// 旧名 surface 恢复时按别名也能落回这条下限。
const LEGACY_SNAPSHOT_TOOL_NAMES = new Set(['write_file', 'append_file', 'edit_file', 'Write', 'Append', 'Edit']);

/**
 * main 白名单下限目标（返修 r5）：白名单命中的调用按 main 的方式取目标——
 * params.file_path || params.path（相对路径锚执行基准目录）。路径归一走
 * resolveToolPath（~ 展开 + 规范化），与声明路径档同一条管线，两条来源对同一
 * 文件产出同一字符串，Set 去重后不会落两行快照。
 */
function legacyWhitelistTargets(
  definition: ToolDefinition,
  params: Record<string, unknown>,
  workingDirectory: string,
): string[] {
  const names = [definition.name, ...(definition.aliases ?? [])];
  if (!names.some((name) => LEGACY_SNAPSHOT_TOOL_NAMES.has(name))) return [];
  const rawFilePath = params.file_path || params.path;
  if (typeof rawFilePath !== 'string' || !rawFilePath) return [];
  return [resolveToolPath(rawFilePath, workingDirectory)];
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

/** 未声明写盘披露键前缀：值是工具名（mcp__server__tool），回退时逐工具披露。 */
const UNDECLARED_TOOL_KEY_PREFIX = 'undeclared-tool:';

/** 未声明写盘披露的资格档（非 MCP 侧）；schema 的 dangerous 在 adapter 已折成 execute。 */
const UNDECLARED_QUALIFYING_LEVELS = new Set(['write', 'execute']);

/**
 * 「可能写盘但不在回退覆盖里」的资格判定（N-CHECKPOINT-MCP-WRITETARGET，编排决策：
 * 集合保持最小，编排日后可放宽）：
 * - MCP 工具（mcp__ 前缀）且非 readOnly——cua 桌面动作、无 annotations 的 MCP 写操作
 *   都算；纯只读（readOnlyHint）不算。
 * - 非 MCP 工具：permissionLevel 是 write/execute 且无 pathAuthority 声明、也不在
 *   六名下限里。纯 network 内置（http_request/jira…）不写本地盘，不披露（false noise）。
 */
function qualifiesAsUndeclaredWriteTool(definition: ToolDefinition): boolean {
  if (definition.name.startsWith('mcp__')) return definition.readOnly !== true;
  if (!UNDECLARED_QUALIFYING_LEVELS.has(definition.permissionLevel)) return false;
  if (definition.pathAuthority && definition.pathAuthority.length > 0) return false;
  const names = [definition.name, ...(definition.aliases ?? [])];
  return !names.some((name) => LEGACY_SNAPSHOT_TOOL_NAMES.has(name));
}

/**
 * 在工具执行前按**写目标**创建检查点（不枚举工具名）。
 * 判据是 resolveCheckpointWriteTargets（返修 r4 砍范围后的口径）**加上 main 白名单
 * 下限**（返修 r5，见 LEGACY_SNAPSHOT_TOOL_NAMES）：
 * - Bash / terminal_write：只从命令解析取**单目标**写入（重定向、cp 目的地、rm 目标、
 *   tee）；移动/重命名类（mv）一律不进回退——与 origin/main 一致，不建快照、回退不碰。
 * - 内置写工具：只认 schema 里声明 path / global-memory 权威的写路径字段（Write/Edit 等），
 *   白名单六名（Write/Append/Edit 及 snake 别名）即使 schema 未声明（Append）也按
 *   main 的取数方式兜底建快照。
 * - MCP 工具：只认 server 声明的 writePathParameters（决策 2026-09-30，参数名推断被
 *   永久否决）；声明的目标还要过信任边界——server 不可信，快照会把文件内容拷进本地
 *   DB，只有 run 的 workspace 范围内（无 scope 以执行基准目录为界）才建快照，界外
 *   落披露。
 * - 未声明的「可能写盘」工具（qualifiesAsUndeclaredWriteTool）：调用零目标零披露时
 *   落一条 undeclared-tool:<name> 行，回退时逐工具披露「不在回退范围」，不静默。
 * 解析不出的目标（含通配/变量的重定向）与建不出无损快照的目标（二进制/超大/读错误/
 * 目录）逐条落 uncertain 披露，回退时进 skippedFiles。本单建的每条快照都是
 * 「单文件、单行、自足可回退」——被每 session 上限逐出的行，其文件回退时不碰，
 * 不存在需要成对保持的记录（移动类支持另立单做原子成对快照）。
 * 整段 fail-open：目标解析与建行的任何异常都不阻止工具执行。
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
    const { targets, uncertain } = resolveCheckpointWriteTargets({
      definition,
      params,
      workingDirectory: effectiveWorkingDirectory,
    });
    // MCP 声明目标的信任边界（N-CHECKPOINT-MCP-WRITETARGET）：只有声明的目标才过这
    // 道闸；有 workspace scope 用 scope（read_write 根），没有以执行基准目录为界。
    // 界外不建快照（不把任意路径的文件内容拷进本地 DB），逐条按真实路径落披露。
    const declaredMcpParameters = declaredMcpWritePathParameters(definition);
    const withinMcpBoundary = (filePath: string): boolean => context.workspaceScope
      ? Boolean(resolveWorkspacePath(context.workspaceScope, filePath, 'read_write'))
      : isPathWithinRoot(filePath, effectiveWorkingDirectory);
    const outOfScopeTargets = declaredMcpParameters.length > 0
      ? targets.filter((filePath) => !withinMcpBoundary(filePath))
      : [];
    const scopedTargets = declaredMcpParameters.length > 0
      ? targets.filter((filePath) => withinMcpBoundary(filePath))
      : targets;
    const legacyTargets = legacyWhitelistTargets(definition, params, effectiveWorkingDirectory);
    // main 白名单下限在声明/命令解析**之后**并集（返修 r5）：两条来源都过同一归一
    // 管线，对同一文件只落一行快照；下限保证 Append 这类未声明 schema 的六名工具
    // 仍有 main 的快照覆盖。
    const snapshotTargets = [...new Set([
      ...scopedTargets,
      ...legacyTargets,
    ])]
      .filter((filePath) => !UNSNAPSHOTABLE_DEVICES.has(filePath))
      .sort();
    const service = getFileCheckpointService();
    for (const filePath of snapshotTargets) {
      // 无损预检（返修 r2，单目标口径）：二进制（utf-8 有损）/超大/读错误/目录建不出
      // 可安全回退的行——硬建会让回退把损坏内容写回，不建、走下面的逐条披露。
      const eligibility = await service.assessSnapshotEligibility(filePath);
      if (!eligibility.snapshotable) continue;
      const match = context.workspaceScope
        ? resolveWorkspacePath(context.workspaceScope, filePath, 'read_write')
        : undefined;
      const checkpointId = await service.createCheckpoint(context.sessionId, context.messageId, filePath, {
        sourceId: match?.root.sourceId,
        workspaceScopeVersion: context.workspaceScope?.version,
      });
      if (checkpointId) created.push({ checkpointId, filePath });
    }
    // 没落到快照行的目标（解析不出、建不出无损行、DB 层失败）不静默降级：逐条 uncertain
    // 披露，回退时进 skippedFiles（「fail-open 是行为不改变，不是失败不留痕」）
    const createdPaths = new Set(created.map((entry) => entry.filePath));
    for (const key of [...new Set([
      ...uncertain,
      ...outOfScopeTargets,
      ...snapshotTargets.filter((filePath) => !createdPaths.has(filePath)),
    ])].sort()) {
      await service.recordUncertainWriteTarget(context.sessionId, context.messageId, key, {
        workspaceScopeVersion: context.workspaceScope?.version,
      });
    }
    // 未声明写盘（N-CHECKPOINT-MCP-WRITETARGET）：这次调用零目标、零披露、零下限，
    // 而工具本身「可能写盘且不被回退覆盖」——落一条逐工具披露行，回退时告知
    // 「该工具的写入不在回退范围」。键按 (session, key, message) 去重，每轮各留一条。
    if (
      scopedTargets.length === 0 && uncertain.length === 0 && outOfScopeTargets.length === 0
      && legacyTargets.length === 0
      && qualifiesAsUndeclaredWriteTool(definition)
    ) {
      await service.recordUncertainWriteTarget(
        context.sessionId,
        context.messageId,
        `${UNDECLARED_TOOL_KEY_PREFIX}${definition.name}`,
        { workspaceScopeVersion: context.workspaceScope?.version },
      );
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
