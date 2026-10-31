// ============================================================================
// Recent external chats batch import (N-EXTHISTORY-IMPORT-CHATS-HOST)
// ============================================================================
//
// 一次性把最近 30 天的 Claude Code / Codex CLI 会话批量导入 Neo：
// - 候选：两引擎合并、按会话 updatedAt 新→旧，单次至多 RECENT_EXTERNAL_CHATS_MAX_PER_RUN 条；
// - 去重：确定性 exportId `external-history:<engine>:<sourceSessionId>`，进 importSessionFork
//   之前先查 session_fork_portability_imports（owner/project/namespace），已导入直接
//   already_imported——importSessionFork 对同 exportId 不同 payload digest 会抛
//   SYNC_ID_DIGEST_CONFLICT，而源文件事后追加消息正是常态，不能依赖它的幂等；
// - cwd：源里记录了 cwd 且目录在盘上 → ensureProjectForWorkspace 归属该项目；目录缺失 →
//   先按 workspace key 查回既有项目查台账（已导入 → already_imported，不受目录被删影响），
//   台账未命中才 folder_missing（不抛、不写库，同批其他会话照常导入）；源里没有 cwd →
//   未分类项目；判据只用 summary.cwd，不用 workingDirectory/projectPath 兜底——后者由目录名
//   推导，换机会话目录推导出的路径在盘上不存在，会造成 folder_missing 误报；
// - 持久化：默认走 SessionHistoryAppService.importSessionFork（namespace 固定
//   external-history），不直接写 SQL；
// - 单条失败不抛：状态落 failed + reason，同批其他会话继续。

import fs from 'fs/promises';
import type { RecentExternalChatImportResult } from '../../shared/contract/agentEngine';
import type { Project } from '../../shared/contract/project';
import type { SessionExportEnvelopeV2 } from '../../shared/contract/sessionForkPortability';
import type {
  AgentEngineHistoryEngineKind,
  AgentEngineHistoryImportEnvelopeRequest,
  AgentEngineHistoryImportServiceOptions,
  AgentEngineHistorySummary,
} from '../services/agentEngine/agentEngineHistoryImport';
import { AgentEngineHistoryImportService } from '../services/agentEngine/agentEngineHistoryImport';

const RECENT_EXTERNAL_CHATS_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;
const RECENT_EXTERNAL_CHATS_MAX_PER_RUN = 50;
const EXTERNAL_HISTORY_IMPORT_NAMESPACE = 'external-history';

interface ExternalHistoryImportLedgerQuery {
  sourceExportId: string;
  ownerScopeId: string;
  projectId: string;
  namespace: string;
}

interface ExternalHistoryImportForkInput {
  envelope: SessionExportEnvelopeV2;
  targetProjectId: string;
  namespace: string;
}

export interface RecentExternalChatsImportOptions {
  /** 与 importSessionFork 的 targetOwnerScopeId 同一口径（生产侧：登录用户或本地 scope）。 */
  ownerScopeId: string;
  /** 注入时钟；缺省 Date.now。 */
  now?: () => number;
  /** 注入历史根目录；缺省走服务默认（~/.claude/projects、~/.codex/sessions）。 */
  roots?: AgentEngineHistoryImportServiceOptions['roots'];
  /** 单次导入上限；缺省 RECENT_EXTERNAL_CHATS_MAX_PER_RUN（50）。 */
  maxChats?: number;
  /** 最近窗口；缺省 RECENT_EXTERNAL_CHATS_WINDOW_MS（30 天）。 */
  windowMs?: number;
  /** 历史服务；缺省按 roots 新建。 */
  historyService?: InstanceType<typeof AgentEngineHistoryImportService>;
  /** 项目归属解析器；缺省 ensureProjectForWorkspace（缺 cwd 返回未分类项目）。 */
  resolveProject?: (cwd: string | undefined, now: number) => Promise<Project>;
  /**
   * 按 workspace 路径查既有项目（不铸造）；缺省 ProjectService.findProjectForWorkspace。
   * 目录已从盘上消失时 resolveProject 会把会话归到未分类项目，拿那个 id 查去重台账
   * 必然漏判——所以先用本查找按 workspace key 找回导入时归属的项目。
   */
  lookupProjectForWorkspace?: (cwd: string) => Promise<Project | undefined>;
  /** 已导入预检（去重闸）；缺省查 session_fork_portability_imports。 */
  hasExistingImport?: (query: ExternalHistoryImportLedgerQuery) => boolean | Promise<boolean>;
  /** 持久化端口；缺省走 SessionHistoryAppService.importSessionFork。 */
  importFork?: (input: ExternalHistoryImportForkInput) => unknown | Promise<unknown>;
}

const defaultResolveProject = async (cwd: string | undefined, now: number): Promise<Project> => {
  const { getProjectService } = await import('../services/project/projectService');
  return getProjectService().ensureProjectForWorkspace(cwd, now);
};

const defaultLookupProjectForWorkspace = async (cwd: string): Promise<Project | undefined> => {
  const { getProjectService } = await import('../services/project/projectService');
  return getProjectService().findProjectForWorkspace(cwd);
};

const defaultHasExistingImport = async (
  query: ExternalHistoryImportLedgerQuery,
): Promise<boolean> => {
  const { getDatabase } = await import('../services/core/databaseService');
  return getDatabase().hasSessionForkImport(query);
};

const defaultImportFork = async (input: ExternalHistoryImportForkInput): Promise<unknown> => {
  const [{ SessionHistoryAppService }, { getTaskManager }] = await Promise.all([
    import('../app/sessionHistoryAppService'),
    import('../task/TaskManager'),
  ]);
  return new SessionHistoryAppService(getTaskManager).importSessionFork({
    envelope: input.envelope,
    targetProjectId: input.targetProjectId,
    namespace: input.namespace,
  });
};

function externalHistoryExportId(
  engine: AgentEngineHistoryEngineKind,
  sourceSessionId: string,
): string {
  return `${EXTERNAL_HISTORY_IMPORT_NAMESPACE}:${engine}:${sourceSessionId}`;
}

async function isDirectoryOnDisk(dir: string): Promise<boolean> {
  try {
    return (await fs.stat(dir)).isDirectory();
  } catch {
    return false;
  }
}

function failureReason(summary: AgentEngineHistorySummary): string {
  const diagnostic = summary.diagnostics[0];
  return diagnostic ? `${diagnostic.code}: ${diagnostic.message}` : 'history session is not importable';
}

export async function importRecentExternalChats(
  options: RecentExternalChatsImportOptions,
): Promise<RecentExternalChatImportResult[]> {
  const now = options.now ?? Date.now;
  const windowMs = options.windowMs ?? RECENT_EXTERNAL_CHATS_WINDOW_MS;
  const maxChats = options.maxChats ?? RECENT_EXTERNAL_CHATS_MAX_PER_RUN;
  const historyService = options.historyService
    ?? new AgentEngineHistoryImportService({ roots: options.roots });
  const resolveProject = options.resolveProject ?? defaultResolveProject;
  const lookupProjectForWorkspace = options.lookupProjectForWorkspace ?? defaultLookupProjectForWorkspace;
  const hasExistingImport = options.hasExistingImport ?? defaultHasExistingImport;
  const importFork = options.importFork ?? defaultImportFork;
  const at = now();
  const candidates = await historyService.listRecentHistory({
    sinceMs: at - windowMs,
    limit: maxChats,
  });
  const results: RecentExternalChatImportResult[] = [];
  for (const summary of candidates) {
    const base = {
      engine: summary.engineKind,
      sourceSessionId: summary.externalSessionId,
      title: summary.title,
    };
    try {
      const cwd = summary.cwd;
      // 去重台账先于 folder_missing 判：已导入的会话哪怕原目录后来被删，也必须报
      // already_imported（第二击全 already_imported 的用户路径靠它）。目录已不在盘上时
      // resolveProject 会把会话归到未分类项目，拿那个 id 查台账必漏——改按 workspace key
      // 查回导入时归属的项目（不铸造）；连项目都查不到（从没导入过）才落 folder_missing。
      const dirOnDisk = !cwd || (await isDirectoryOnDisk(cwd));
      const ghostProject = cwd && !dirOnDisk ? await lookupProjectForWorkspace(cwd) : undefined;
      if (!dirOnDisk && !ghostProject) {
        results.push({
          ...base,
          status: 'folder_missing',
          reason: `workspace directory is not on disk: ${cwd}`,
        });
        continue;
      }
      const project = ghostProject ?? await resolveProject(cwd, at);
      const sourceExportId = externalHistoryExportId(summary.engineKind, summary.externalSessionId);
      const ledgerQuery: ExternalHistoryImportLedgerQuery = {
        sourceExportId,
        ownerScopeId: options.ownerScopeId,
        projectId: project.id,
        namespace: EXTERNAL_HISTORY_IMPORT_NAMESPACE,
      };
      if (await hasExistingImport(ledgerQuery)) {
        results.push({ ...base, status: 'already_imported' });
        continue;
      }
      if (!dirOnDisk) {
        // 目录缺失且台账未命中：restore 后重新点击即可导入，本轮不写库。
        results.push({
          ...base,
          status: 'folder_missing',
          reason: `workspace directory is not on disk: ${cwd}`,
        });
        continue;
      }
      if (!summary.canImport) {
        results.push({ ...base, status: 'failed', reason: failureReason(summary) });
        continue;
      }
      const request: AgentEngineHistoryImportEnvelopeRequest = {
        engine: summary.engineKind,
        sourcePath: summary.sourcePath,
        ownerScopeId: options.ownerScopeId,
        projectId: project.id,
        exportId: sourceExportId,
      };
      const { envelope } = await historyService.mapHistoryForImport(request);
      await importFork({
        envelope,
        targetProjectId: project.id,
        namespace: EXTERNAL_HISTORY_IMPORT_NAMESPACE,
      });
      results.push({ ...base, status: 'imported' });
    } catch (error) {
      results.push({
        ...base,
        status: 'failed',
        reason: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return results;
}
