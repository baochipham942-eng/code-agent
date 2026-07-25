// ============================================================================
// request_directory — agent 中途申请把工作区外的一个目录加为 Project Source
// ============================================================================
//
// 复用 B2 停车挂起机制（pending_approvals，kind='directory_access'）：
// canUseTool() 桥接到 AgentOrchestrator.requestPermission()，该方法对
// type==='directory_access' 一律走停车挂起（不论 attended/unattended，
// 见 agentOrchestrator.ts 的 requestPermission 分支），用户在收件箱/会话卡
// 批准或拒绝。批准后本工具自己完成授权落地（folder trust + Project Source），
// 与 ProjectSettingsDialog 手动加目录走的是同一条 ProjectService.updateProject
// 路径——orchestrator 侧的停车挂起机制保持对 kind 无感知，不耦合项目服务。
//
// 生效范围：WorkspaceScope 在每个 run 开始时从 ProjectService 重新读取一次并
// 冻结（见 runContext.ts），当前 run 中途拿到的授权不会回填本轮已冻结的
// scope——从下一条消息开始的新 run 才会看到新增的 Project Source。
// ============================================================================

import path from 'node:path';
import { stat } from 'node:fs/promises';
import type {
  ToolHandler,
  ToolModule,
  ToolContext,
  CanUseToolFn,
  ToolProgressFn,
  ToolResult,
} from '../../../protocol/tools';
import { resolveWorkspacePath, canonicalizeWorkspacePath } from '../../../runtime/workspaceScope';
import { getProjectService } from '../../../services/project/projectService';
import { setFolderTrust } from '../../../security/folderTrustService';
import type { ProjectSourceInput, ProjectSourceAccess } from '../../../../shared/contract/project';
import { requestDirectorySchema as schema } from './requestDirectory.schema';

async function executeRequestDirectory(
  args: Record<string, unknown>,
  ctx: ToolContext,
  canUseTool: CanUseToolFn,
  onProgress?: ToolProgressFn,
): Promise<ToolResult<string>> {
  const rawPath = args.path;
  const reason = args.reason;
  const access: ProjectSourceAccess = args.access === 'read_write' ? 'read_write' : 'read_only';

  if (typeof rawPath !== 'string' || !rawPath.trim()) {
    return { ok: false, error: 'path must be a non-empty string', code: 'INVALID_ARGS' };
  }
  if (typeof reason !== 'string' || !reason.trim()) {
    return { ok: false, error: 'reason must be a non-empty string', code: 'INVALID_ARGS' };
  }

  const resolvedPath = path.isAbsolute(rawPath) ? path.resolve(rawPath) : path.resolve(ctx.workingDir, rawPath);

  let stats;
  try {
    stats = await stat(resolvedPath);
  } catch {
    return { ok: false, error: `Directory does not exist: ${resolvedPath}`, code: 'NOT_FOUND' };
  }
  if (!stats.isDirectory()) {
    return { ok: false, error: `Not a directory: ${resolvedPath}`, code: 'INVALID_ARGS' };
  }

  // 已在可访问范围内（含已满足所需档位）→ 无需申请，直接放行。
  if (ctx.workspaceScope && resolveWorkspacePath(ctx.workspaceScope, resolvedPath, access)) {
    return { ok: true, output: `已经可以访问 ${resolvedPath}，无需申请。` };
  }

  const projectId = ctx.workspaceScope?.projectId;
  if (!projectId) {
    return {
      ok: false,
      error: '当前会话未绑定 Project（多目录容器），无法新增 Project Source。请先在项目设置里建立 Project。',
      code: 'NO_PROJECT',
    };
  }

  const permit = await canUseTool(schema.name, args, reason, {
    type: 'directory_access',
    tool: schema.name,
    sessionId: ctx.sessionId,
    reason,
    details: { path: resolvedPath, requestedAccess: access },
  });
  if (!permit.allow) {
    return { ok: false, error: `目录访问被拒绝：${resolvedPath}（${permit.reason}）`, code: 'PERMISSION_DENIED' };
  }
  if (ctx.abortSignal.aborted) {
    return { ok: false, error: 'aborted', code: 'ABORTED' };
  }

  onProgress?.({ stage: 'starting', detail: schema.name });

  try {
    const canonicalPath = canonicalizeWorkspacePath(resolvedPath);
    await setFolderTrust(canonicalPath, 'trusted', 'request_directory');

    const detail = getProjectService().getProjectDetail(projectId);
    if (!detail) {
      return { ok: false, error: `Project 不存在或不支持多目录：${projectId}`, code: 'NO_PROJECT' };
    }
    // 已被其他并发请求加过（同一 canonicalPath）→ 视为成功，不重复写入。
    if (detail.sources.some((source) => source.canonicalPath === canonicalPath)) {
      return { ok: true, output: `已获得 ${canonicalPath} 的访问权限，从下一条消息开始对本次对话生效。` };
    }
    const sources: ProjectSourceInput[] = [
      ...detail.sources.map((source) => ({
        id: source.id,
        path: source.path,
        role: source.role,
        access: source.access,
        trustState: source.trustState,
      })),
      { path: canonicalPath, role: 'additional' as const, access, trustState: 'trusted' as const },
    ];
    const updated = await getProjectService().updateProject({
      projectId,
      revision: detail.project.sourceRevision ?? 0,
      name: detail.project.name,
      description: detail.project.description ?? null,
      sources,
    }, Date.now());
    if (!updated) {
      return { ok: false, error: '授权写入失败：Project 状态已变化，请重试。', code: 'UPDATE_FAILED' };
    }

    ctx.logger.info('request_directory granted', { projectId, path: canonicalPath, access });
    const accessLabel = access === 'read_write' ? '读写' : '只读';
    return {
      ok: true,
      output: `已获得对 "${canonicalPath}" 的${accessLabel}访问权限。这个授权从下一条消息开始对本次对话生效——请告知用户已获得访问权限，并在收到下一条消息后再实际读写该目录。`,
      meta: { projectId, path: canonicalPath, access },
    };
  } catch (error) {
    return {
      ok: false,
      error: `目录授权失败：${error instanceof Error ? error.message : String(error)}`,
      code: 'GRANT_FAILED',
    };
  }
}

class RequestDirectoryHandler implements ToolHandler<Record<string, unknown>, string> {
  readonly schema = schema;
  execute(
    args: Record<string, unknown>,
    ctx: ToolContext,
    canUseTool: CanUseToolFn,
    onProgress?: ToolProgressFn,
  ): Promise<ToolResult<string>> {
    return executeRequestDirectory(args, ctx, canUseTool, onProgress);
  }
}

export const requestDirectoryModule: ToolModule<Record<string, unknown>, string> = {
  schema,
  createHandler() {
    return new RequestDirectoryHandler();
  },
};
