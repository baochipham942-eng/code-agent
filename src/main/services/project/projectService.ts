// ============================================================================
// ProjectService - 项目空间业务编排（P0-2）
// ============================================================================
//
// 薄编排层：ID/时间戳在此生成，委托 ProjectRepository 落库；接管 workspace
// 记忆 key（写 meta.json projectId，记忆文件不动）。
// 设计：docs/designs/project-space.md §5.2
// ============================================================================

import * as path from 'path';
import { createHash, randomUUID } from 'crypto';
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
  type ProjectStatus,
} from '../../../shared/contract/project';

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
    if (existing) return existing;

    const project = buildProjectRow(dir, key, now);
    repo.upsertProject(project);
    // 接管项目记忆目录的 key（写 meta.json projectId，记忆文件不动）
    void linkProjectIdToMeta(dir, project.id).catch((err) =>
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
    };
    repo.upsertProject(unsorted);
    return unsorted;
  }

  /** D4 启动迁移归桶：把存量无 project_id 的 session 按 workspace 自动归桶。返回归桶数。 */
  backfillSessions(now: number): number {
    return this.repo().backfillSessions(now, (workspacePath, key) => buildProjectRow(workspacePath, key, now));
  }

  listProjects(includeArchived = false): Project[] {
    return this.repo().listProjects(includeArchived);
  }

  /** 中心视图数据源：project + goals + roles + sessionIds */
  getProjectDetail(projectId: string): ProjectDetail | undefined {
    const repo = this.repo();
    const project = repo.getProject(projectId);
    if (!project) return undefined;
    return {
      project,
      goals: repo.listGoals(projectId),
      roles: repo.listRoles(projectId),
      sessionIds: repo.listSessionIds(projectId),
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
    return buildProjectArtifacts(sessions, (sessionId) => db.getMessages(sessionId), limit);
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
