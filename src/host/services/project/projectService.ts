// ============================================================================
// ProjectService - 项目空间业务编排（P0-2）
// ============================================================================
//
// 薄编排层：ID/时间戳在此生成，委托 ProjectRepository 落库；接管 workspace
// 记忆 key（写 meta.json projectId，记忆文件不动）。
// 设计：内部文档 §5.2
// ============================================================================

import * as path from 'path';
import { createHash, randomUUID } from 'crypto';
import { accessSync, constants as fsConstants } from 'fs';
import { getDatabase } from '../core/databaseService';
import type { ProjectRepository } from '../core/repositories';
import { getProjectKey } from '../roleAssets/roleAssetPaths';
import { linkProjectIdToMeta } from '../roleAssets/roleAssetService';
import { createLogger } from '../infra/logger';
import { extractArtifacts } from '../../agent/artifactExtractor';
import { collectToolArtifactsFromMetadata } from '../../../shared/contract/artifactBlob';
import type { GoalRunInput } from '../../../shared/contract/appService';
import type { ToolCall } from '../../../shared/contract/tool';
import {
  UNSORTED_PROJECT_ID,
  UNSORTED_PROJECT_NAME,
  type CreateProjectGoalInput,
  type Project,
  type ProjectArtifact,
  type ProjectArtifactKind,
  type ProjectDetail,
  type ProjectGoal,
  type ProjectGoalStatus,
  type ProjectRoleLink,
  type ProjectSource,
  type ProjectSourceInput,
  type ProjectStatus,
  type UpdateProjectInput,
  type WorkspaceScope,
} from '../../../shared/contract/project';
import {
  assertNonOverlappingRoots,
  canonicalizeWorkspacePath,
  createWorkspaceScope,
  workspacePathIdentity,
  resolveWorkspacePath,
} from '../../runtime/workspaceScope';
import { evaluateFolderTrust } from '../../security/folderTrustService';
import { getProjectSourceGitStates } from '../git/gitStatusService';

const logger = createLogger('ProjectService');

const FILE_METADATA_KEYS = [
  'filePath',
  'imagePath',
  'videoPath',
  'outputPath',
  'pptxPath',
  'pdfPath',
];

const READ_ONLY_ARTIFACT_TOOL_NAMES = new Set([
  'read',
  'read_file',
  'file_read',
  'glob',
  'grep',
  'listdirectory',
  'directory_list',
  'ls',
  'readclipboard',
  'clipboard_read',
  'memoryread',
  'memory_read',
  'episodicrecall',
  'episodic_recall',
]);

type ProjectArtifactMessage = {
  id?: string;
  role: string;
  content?: string;
  timestamp: number;
  artifacts?: Array<{
    id: string;
    type: ProjectArtifactKind;
    title?: string;
    content?: string;
  }>;
  toolCalls?: ToolCall[];
};

type ProjectArtifactSession = {
  id: string;
  title: string;
  workingDirectory?: string | null;
};

function shortId(prefix: string): string {
  return `${prefix}_${randomUUID().replace(/-/g, '').slice(0, 12)}`;
}

function stableProjectArtifactId(input: string): string {
  return `part_${createHash('sha1').update(input).digest('hex').slice(0, 16)}`;
}

function isReadOnlyArtifactTool(toolName: string | undefined): boolean {
  if (!toolName) return false;
  const normalized = toolName.trim().toLowerCase().replace(/[\s-]+/g, '_');
  return READ_ONLY_ARTIFACT_TOOL_NAMES.has(normalized);
}

function resolveArtifactPath(rawPath: string | undefined, workingDirectory?: string | null): string | undefined {
  const trimmed = rawPath?.trim();
  if (!trimmed) return undefined;
  if (trimmed.startsWith('/') || trimmed.startsWith('~') || /^[a-z]+:\/\//i.test(trimmed)) {
    return trimmed;
  }
  const directory = workingDirectory?.trim();
  return directory ? path.join(directory, trimmed) : trimmed;
}

function basenameForArtifact(value: string): string {
  const withoutQuery = value.split(/[?#]/, 1)[0] || value;
  return withoutQuery.split('/').filter(Boolean).pop() || value;
}

function projectArtifactKindForPath(filePath: string): ProjectArtifactKind {
  const ext = path.extname(filePath).replace(/^\./, '').toLowerCase();
  if (['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg'].includes(ext)) return 'image';
  if (['mp3', 'wav', 'm4a', 'aac', 'flac', 'ogg'].includes(ext)) return 'audio';
  if (['mp4', 'webm', 'mov', 'mkv', 'avi'].includes(ext)) return 'video';
  if (['zip', 'tar', 'gz', 'tgz', '7z', 'rar'].includes(ext)) return 'binary';
  if (['ppt', 'pptx'].includes(ext)) return 'document';
  if (['md', 'mdx', 'markdown', 'docx', 'pdf', 'txt'].includes(ext)) return 'document';
  if (['csv', 'tsv', 'xlsx', 'xls'].includes(ext)) return 'spreadsheet';
  if (['html', 'htm'].includes(ext)) return 'generic_html';
  return 'file';
}

function projectArtifactKindForToolArtifact(kind: string, artifactPath?: string, url?: string): ProjectArtifactKind {
  if (kind === 'web' && url && !artifactPath) return 'link';
  if (kind === 'process-output' || kind === 'process-log') return kind;
  if ([
    'chart',
    'spreadsheet',
    'document',
    'generative_ui',
    'neo_ui',
    'mermaid',
    'question_form',
    'text',
    'binary',
    'image',
    'audio',
    'video',
    'web',
    'search',
    'file',
    'generic_html',
    'web_snapshot',
    'link',
  ].includes(kind)) {
    return kind as ProjectArtifactKind;
  }
  if (artifactPath) return projectArtifactKindForPath(artifactPath);
  if (url) return 'link';
  return 'file';
}

function projectArtifactKindForPreviewKind(kind: unknown): ProjectArtifactKind {
  switch (kind) {
    case 'spreadsheet':
    case 'document':
    case 'question_form':
    case 'generic_html':
    case 'chart':
    case 'web_snapshot':
      return kind;
    case 'diagram':
      return 'mermaid';
    default:
      return 'file';
  }
}

function previewItemIdFromMetadataPreview(toolCallId: string | undefined, previewItem: unknown): string | undefined {
  if (!toolCallId || !previewItem || typeof previewItem !== 'object') return undefined;
  const raw = previewItem as { id?: unknown; kind?: unknown; title?: unknown };
  if (!raw.kind || !raw.title) return undefined;
  return typeof raw.id === 'string' && raw.id.trim()
    ? raw.id.trim()
    : `tool-preview:${toolCallId}`;
}

function collectPathMetadata(metadata?: Record<string, unknown>): string[] {
  if (!metadata) return [];
  const paths: string[] = [];
  for (const key of FILE_METADATA_KEYS) {
    const value = metadata[key];
    if (typeof value === 'string' && value.trim()) {
      paths.push(value.trim());
    }
  }
  return paths;
}

function addProjectArtifact(items: ProjectArtifact[], seen: Set<string>, item: ProjectArtifact, dedupeKey: string): void {
  if (seen.has(dedupeKey)) return;
  seen.add(dedupeKey);
  items.push(item);
}

/** 跨 session 抽取 artifact 并按内容哈希去重、时间倒序、取前 limit（纯函数，便于单测）。 */
export function buildProjectArtifacts(
  sessions: ProjectArtifactSession[],
  loadMessages: (sessionId: string) => ProjectArtifactMessage[],
  limit = 60,
): ProjectArtifact[] {
  const seen = new Set<string>();
  const items: ProjectArtifact[] = [];
  for (const session of sessions) {
    for (const msg of loadMessages(session.id)) {
      if (msg.role !== 'assistant') continue;

      for (const art of msg.artifacts ?? []) {
        const id = stableProjectArtifactId(`message-artifact:${art.id}:${art.type}:${art.content ?? art.title ?? ''}`);
        addProjectArtifact(items, seen, {
          id,
          sessionId: session.id,
          messageId: msg.id,
          sessionTitle: session.title || undefined,
          kind: art.type,
          title: art.title,
          createdAt: msg.timestamp,
          previewItemId: msg.id ? `artifact:${msg.id}:${art.id}` : undefined,
        }, `message-artifact:${id}`);
      }

      if (msg.content) {
        for (const art of extractArtifacts(msg.content)) {
          addProjectArtifact(items, seen, {
            id: art.id,
            sessionId: session.id,
            messageId: msg.id,
            sessionTitle: session.title || undefined,
            kind: art.type,
            title: art.title,
            createdAt: msg.timestamp,
            previewItemId: msg.id ? `artifact:${msg.id}:${art.id}` : undefined,
          }, `assistant-artifact:${art.id}`);
        }
      }

      for (const toolCall of msg.toolCalls ?? []) {
        const result = toolCall.result;
        if (!result || isReadOnlyArtifactTool(toolCall.name)) continue;

        const previewItemId = previewItemIdFromMetadataPreview(toolCall.id, result.metadata?.previewItem);
        if (previewItemId) {
          const rawPreview = result.metadata?.previewItem as { kind?: unknown; title?: unknown };
          addProjectArtifact(items, seen, {
            id: `tool-preview:${previewItemId}`,
            sessionId: session.id,
            messageId: msg.id,
            sessionTitle: session.title || undefined,
            kind: projectArtifactKindForPreviewKind(rawPreview.kind),
            title: typeof rawPreview.title === 'string' ? rawPreview.title : toolCall.name,
            createdAt: msg.timestamp,
            toolCallId: toolCall.id,
            toolName: toolCall.name,
            previewItemId,
          }, `previewItem:${previewItemId}`);
        }

        const rawPaths = new Set<string>();
        if (typeof result.outputPath === 'string') rawPaths.add(result.outputPath);
        for (const metadataPath of collectPathMetadata(result.metadata)) {
          rawPaths.add(metadataPath);
        }
        for (const rawPath of rawPaths) {
          const artifactPath = resolveArtifactPath(rawPath, session.workingDirectory);
          if (!artifactPath) continue;
          addProjectArtifact(items, seen, {
            id: `file:${artifactPath}`,
            sessionId: session.id,
            messageId: msg.id,
            sessionTitle: session.title || undefined,
            kind: projectArtifactKindForPath(artifactPath),
            title: basenameForArtifact(artifactPath),
            createdAt: msg.timestamp,
            path: artifactPath,
            toolCallId: toolCall.id,
            toolName: toolCall.name,
            previewItemId: `file:${artifactPath}`,
          }, `file:${artifactPath}`);
        }

        for (const artifact of collectToolArtifactsFromMetadata(result.metadata)) {
          if (artifact.kind === 'process-output' || artifact.kind === 'process-log') continue;
          const artifactPath = resolveArtifactPath(artifact.path, session.workingDirectory);
          const artifactUrl = artifact.url?.trim();
          if (!artifactPath && !artifactUrl) continue;
          const artifactKey = artifactPath
            ? `file:${artifactPath}`
            : `url:${artifactUrl}`;
          const artifactPreviewItemId = artifactPath
            ? `file:${artifactPath}`
            : `tool-artifact:${toolCall.id}:${artifact.artifactId || artifactUrl}`;
          addProjectArtifact(items, seen, {
            id: artifact.artifactId || stableProjectArtifactId(`tool-artifact:${artifact.sha256 ?? artifactPath ?? artifactUrl ?? artifact.label}`),
            sessionId: session.id,
            messageId: msg.id,
            sessionTitle: session.title || undefined,
            kind: projectArtifactKindForToolArtifact(artifact.kind, artifactPath, artifactUrl),
            title: artifact.label || artifact.name || (artifactPath ? basenameForArtifact(artifactPath) : artifactUrl),
            createdAt: msg.timestamp,
            path: artifactPath,
            url: artifactUrl,
            mimeType: artifact.mimeType,
            sizeBytes: artifact.sizeBytes,
            sha256: artifact.sha256,
            sourceTool: artifact.sourceTool || toolCall.name,
            toolCallId: toolCall.id,
            toolName: artifact.sourceTool || toolCall.name,
            previewItemId: artifactPreviewItemId,
          }, artifactKey);
        }
      }
    }
  }
  return items.sort((a, b) => b.createdAt - a.createdAt).slice(0, limit);
}

/** 由 workspace 路径构造一个新 Project 行（不落库，仅生成实体）。 */
function buildProjectRow(workspacePath: string, key: string, now: number): Project {
  return {
    id: shortId('proj'),
    name: path.basename(path.resolve(workspacePath)) || workspacePath,
    workspacePath: path.resolve(workspacePath),
    workspaceKey: key,
    status: 'active',
    createdAt: now,
    updatedAt: now,
    archivedAt: null,
    sourceRevision: 0,
  };
}

function buildSource(
  projectId: string,
  input: ProjectSourceInput,
  now: number,
  existing?: ProjectSource,
): ProjectSource {
  const canonicalPath = canonicalizeWorkspacePath(input.path);
  const identity = workspacePathIdentity(canonicalPath);
  return {
    id: input.id ?? existing?.id ?? shortId('psrc'),
    projectId,
    path: path.resolve(input.path),
    canonicalPath,
    role: input.role,
    access: input.role === 'primary' ? 'read_write' : input.access,
    trustState: input.trustState ?? existing?.trustState ?? 'blocked',
    identityDev: identity.dev,
    identityIno: identity.ino,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  };
}

export class ProjectService {
  private repo(): ProjectRepository {
    return getDatabase().getProjectRepo();
  }

  /**
   * D2 隐式懒创建：按 workspace 路径拿/建 project，并接管项目记忆 key。
   * session 创建链路调用它拿 project_id。空路径返回 UNSORTED 项目。
   */
  async ensureProjectForWorkspace(workspacePath: string | undefined, now: number): Promise<Project> {
    const dir = (workspacePath || '').trim();
    if (!dir) return this.ensureUnsorted(now);

    const key = getProjectKey(dir);
    const repo = this.repo();
    const existing = repo.getProjectByWorkspaceKey(key);
    if (existing) {
      if (repo.listSources(existing.id).length === 0) repo.backfillProjectSources(now);
      return existing;
    }

    const project = buildProjectRow(dir, key, now);
    repo.upsertProject(project);
    repo.upsertSource(buildSource(project.id, {
      path: dir,
      role: 'primary',
      access: 'read_write',
      trustState: 'trusted',
    }, now));
    // 接管项目记忆目录的 key（写 meta.json projectId，记忆文件不动）
    await linkProjectIdToMeta(dir, project.id).catch((err) =>
      logger.warn('[ProjectService] linkProjectIdToMeta failed:', err instanceof Error ? err.message : String(err)),
    );
    return project;
  }

  private ensureUnsorted(now: number): Project {
    const repo = this.repo();
    const existing = repo.getProject(UNSORTED_PROJECT_ID);
    if (existing) return existing;
    const unsorted: Project = {
      id: UNSORTED_PROJECT_ID,
      name: UNSORTED_PROJECT_NAME,
      workspacePath: null,
      workspaceKey: null,
      status: 'idle',
      createdAt: now,
      updatedAt: now,
      archivedAt: null,
      sourceRevision: 0,
    };
    repo.upsertProject(unsorted);
    return unsorted;
  }

  /** D4 启动迁移归桶：把存量无 project_id 的 session 按 workspace 自动归桶。返回归桶数。 */
  backfillSessions(now: number): number {
    const repo = this.repo();
    const count = repo.backfillSessions(now, (workspacePath, key) => buildProjectRow(workspacePath, key, now));
    repo.backfillProjectSources(now);
    return count;
  }

  listProjects(includeArchived = false): Project[] {
    return this.repo().listProjects(includeArchived);
  }

  /** 中心视图数据源：project + goals + roles + sessionIds */
  getProjectDetail(projectId: string): ProjectDetail | undefined {
    const repo = this.repo();
    const project = repo.getProject(projectId);
    if (!project) return undefined;
    const sources = repo.listSources(projectId).map((source) => {
      const identity = workspacePathIdentity(source.canonicalPath);
      const identityValid = identity.dev !== null
        && identity.ino !== null
        && identity.dev === (source.identityDev ?? null)
        && identity.ino === (source.identityIno ?? null);
      return identityValid ? source : { ...source, trustState: 'blocked' as const };
    });
    return {
      project,
      sources,
      goals: repo.listGoals(projectId),
      roles: repo.listRoles(projectId),
      sessionIds: repo.listSessionIds(projectId),
    };
  }

  listSources(projectId: string): ProjectSource[] {
    return this.repo().listSources(projectId);
  }

  getWorkspaceScope(projectId: string): WorkspaceScope | undefined {
    const project = this.repo().getProject(projectId);
    if (!project || project.id === UNSORTED_PROJECT_ID) return undefined;
    const sources = this.repo().listSources(projectId);
    if (sources.length === 0) return undefined;
    for (const source of sources) {
      const identity = workspacePathIdentity(source.canonicalPath);
      if (
        source.trustState !== 'trusted'
        || identity.dev === null
        || identity.ino === null
        || identity.dev !== (source.identityDev ?? null)
        || identity.ino !== (source.identityIno ?? null)
      ) {
        throw new Error(`Project Source trust identity changed: ${source.path}`);
      }
    }
    return createWorkspaceScope(projectId, sources.map((source) => ({
      sourceId: source.id,
      path: source.canonicalPath,
      role: source.role,
      access: source.access,
      identityDev: source.identityDev,
      identityIno: source.identityIno,
    })));
  }

  async updateProject(input: UpdateProjectInput, now: number): Promise<ProjectDetail | undefined> {
    const repo = this.repo();
    const current = repo.getProject(input.projectId);
    if (!current || current.id === UNSORTED_PROJECT_ID) return undefined;
    if (!input.name.trim()) throw new Error('Project name is required.');
    const primaryCount = input.sources.filter((source) => source.role === 'primary').length;
    if (primaryCount !== 1) throw new Error('Project requires exactly one Primary source.');

    const existingById = new Map(repo.listSources(input.projectId).map((source) => [source.id, source]));
    const sources: ProjectSource[] = [];
    for (const sourceInput of input.sources) {
      const existing = sourceInput.id ? existingById.get(sourceInput.id) : undefined;
      const source = buildSource(input.projectId, sourceInput, now, existing);
      const isUnchangedTrustedSource = !!existing
        && existing.canonicalPath === source.canonicalPath
        && existing.trustState === 'trusted'
        && existing.identityDev !== null
        && existing.identityIno !== null
        && existing.identityDev === source.identityDev
        && existing.identityIno === source.identityIno;
      if (!isUnchangedTrustedSource) {
        const trust = await evaluateFolderTrust(source.canonicalPath);
        if (trust.state !== 'trusted' || trust.identityChanged) {
          throw new Error(`Folder Trust is required for Source: ${source.path}`);
        }
      }
      source.trustState = 'trusted';
      sources.push(source);
    }
    if (new Set(sources.map((source) => source.canonicalPath)).size !== sources.length) {
      throw new Error('Duplicate Project Source path.');
    }
    assertNonOverlappingRoots(sources.map((source) => ({ sourceId: source.id, path: source.canonicalPath })));
    const retainedIds = new Set(sources.map((source) => source.id));
    const removed = Array.from(existingById.values()).filter((source) => !retainedIds.has(source.id));
    if (removed.length > 0) {
      if (repo.hasRunningSessions(input.projectId)) {
        throw new Error('Cannot remove a Project Source while this Project has a running task.');
      }
      const currentScope = this.getWorkspaceScope(input.projectId);
      const gitStates = currentScope ? await getProjectSourceGitStates(currentScope) : [];
      const dirtyRemoved = removed.find((source) =>
        gitStates.find((state) => state.sourceId === source.id)?.dirtyFiles?.length
        && !input.confirmedDirtySourceIds?.includes(source.id)
      );
      if (dirtyRemoved) {
        throw new Error(`Cannot remove Source with uncommitted changes: ${dirtyRemoved.path}`);
      }
    }
    const primary = sources.find((source) => source.role === 'primary');
    if (!primary) {
      throw new Error('Project must contain exactly one Primary Source.');
    }
    try {
      accessSync(primary.canonicalPath, fsConstants.R_OK | fsConstants.W_OK);
    } catch {
      throw new Error(`Primary Source must exist and be writable: ${primary.path}`);
    }
    const updated = repo.replaceProjectSources({
      ...current,
      name: input.name.trim(),
      description: input.description?.trim() || undefined,
      workspacePath: primary.canonicalPath,
      workspaceKey: getProjectKey(primary.canonicalPath),
      updatedAt: now,
    }, sources, input.revision);
    await linkProjectIdToMeta(primary.canonicalPath, current.id).catch((error) =>
      logger.warn('[ProjectService] linkProjectIdToMeta after Primary switch failed:', error),
    );
    return {
      project: updated,
      sources: repo.listSources(input.projectId),
      goals: repo.listGoals(input.projectId),
      roles: repo.listRoles(input.projectId),
      sessionIds: repo.listSessionIds(input.projectId),
    };
  }

  /**
   * 中心视图"产物列表"数据源：跨该项目所有 session 抽取 artifact，按内容哈希去重、时间倒序、取前 limit。
   * 产物 = assistant artifact 代码块 + 工具 previewItem / outputPath / metadata.artifact。
   */
  getProjectArtifacts(projectId: string, limit = 60): ProjectArtifact[] {
    const db = getDatabase();
    const repo = this.repo();
    if (!repo.getProject(projectId)) return [];
    const sessions = repo.listProjectSessions(projectId);
    const artifacts = buildProjectArtifacts(sessions, (sessionId) => db.getMessages(sessionId), limit);
    let scope: WorkspaceScope | undefined;
    try {
      scope = this.getWorkspaceScope(projectId);
    } catch {
      scope = undefined;
    }
    if (!scope) return artifacts;
    return artifacts.map((artifact) => {
      const artifactPath = artifact.path;
      if (!artifactPath || !path.isAbsolute(artifactPath)) return artifact;
      const source = resolveWorkspacePath(scope, artifactPath, 'read');
      return source ? { ...artifact, sourceId: source.root.sourceId } : artifact;
    });
  }

  renameProject(projectId: string, name: string, now: number): Project | undefined {
    const repo = this.repo();
    if (!repo.getProject(projectId)) return undefined;
    repo.renameProject(projectId, name, now);
    return repo.getProject(projectId);
  }

  setProjectDescription(projectId: string, description: string | null, now: number): Project | undefined {
    const repo = this.repo();
    if (!repo.getProject(projectId)) return undefined;
    repo.setProjectDescription(projectId, description?.trim() || null, now);
    return repo.getProject(projectId);
  }

  setProjectStatus(projectId: string, status: ProjectStatus, now: number): Project | undefined {
    const repo = this.repo();
    if (!repo.getProject(projectId)) return undefined;
    repo.setProjectStatus(projectId, status, now, status === 'archived' ? now : null);
    return repo.getProject(projectId);
  }

  deleteProject(projectId: string, now: number): boolean {
    if (projectId === UNSORTED_PROJECT_ID) return false;
    const repo = this.repo();
    if (!repo.getProject(projectId)) return false;
    const unsorted = this.ensureUnsorted(now);
    for (const sessionId of repo.listSessionIds(projectId)) {
      repo.assignSessionProject(sessionId, unsorted.id);
    }
    repo.deleteSources(projectId);
    return repo.softDeleteProject(projectId, now);
  }

  // --- goals ---

  addGoal(projectId: string, input: CreateProjectGoalInput, now: number): ProjectGoal | undefined {
    const repo = this.repo();
    if (!repo.getProject(projectId)) return undefined;
    const goal: ProjectGoal = {
      id: shortId('pgoal'),
      projectId,
      goal: input.goal,
      verify: input.verify ?? null,
      review: input.review ?? null,
      status: 'active',
      lastRunSessionId: null,
      createdAt: now,
      updatedAt: now,
    };
    repo.insertGoal(goal);
    repo.touchProject(projectId, now);
    return goal;
  }

  updateGoalStatus(
    goalId: string,
    status: ProjectGoalStatus,
    now: number,
    lastRunSessionId?: string | null,
  ): ProjectGoal | undefined {
    const repo = this.repo();
    const goal = repo.getGoal(goalId);
    if (!goal) return undefined;
    repo.updateGoalStatus(goalId, status, now, lastRunSessionId);
    repo.touchProject(goal.projectId, now);
    return repo.getGoal(goalId);
  }

  /**
   * §7 单向投影：把一条持久化 ProjectGoal 投影成 P4 的 GoalRunInput 交给现有 goal 链路。
   * 只读，不修改 GoalContract / GoalRunInput 契约本身。
   */
  projectGoalToRunInput(goalId: string): GoalRunInput | undefined {
    const goal = this.repo().getGoal(goalId);
    if (!goal) return undefined;
    return {
      goal: goal.goal,
      verify: goal.verify ?? undefined,
      review: goal.review ?? undefined,
    };
  }

  // --- roles（D6 角色入驻）---

  addRole(projectId: string, roleId: string, now: number): ProjectRoleLink | undefined {
    const repo = this.repo();
    if (!repo.getProject(projectId)) return undefined;
    const link: ProjectRoleLink = { projectId, roleId, joinedAt: now };
    repo.addRole(link);
    repo.touchProject(projectId, now);
    return link;
  }

  removeRole(projectId: string, roleId: string, now: number): boolean {
    const repo = this.repo();
    const ok = repo.removeRole(projectId, roleId);
    if (ok) repo.touchProject(projectId, now);
    return ok;
  }
}

let instance: ProjectService | null = null;

export function getProjectService(): ProjectService {
  if (!instance) instance = new ProjectService();
  return instance;
}
