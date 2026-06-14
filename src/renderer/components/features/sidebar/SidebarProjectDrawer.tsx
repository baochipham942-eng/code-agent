import React from 'react';
import {
  AlertTriangle,
  ArrowRight,
  CheckCircle2,
  Clock3,
  FileText,
  Folder,
  GitBranch,
  Layers3,
  MessageSquare,
  Play,
  ScrollText,
  ShieldAlert,
  Target,
  Users,
  X,
} from 'lucide-react';
import type {
  SidebarProjectArtifactMeta,
  SidebarProjectGoalMeta,
  SidebarProjectMeta,
  SidebarProjectSummary,
} from '../../../utils/sidebarProjectSummary';
import type { ProjectStatus } from '@shared/contract/project';

export interface SidebarProjectDrawerSession {
  id: string;
  title: string;
  statusLabel: string;
  statusToneClassName: string;
  showStatusBadge: boolean;
  typeLabel?: string | null;
  summary?: string;
  lastActiveLabel: string;
  workingDirectory?: string;
  gitBranch?: string;
  prLabel?: string;
  isCurrent?: boolean;
  turnCount?: number;
  messageCount?: number;
  hasDeliverySignals?: boolean;
  replayEvidenceCount?: number;
  pendingReviewCount?: number;
}

export interface SidebarProjectDrawerProps {
  title: string;
  summaryLine: string;
  paths: string[];
  meta?: SidebarProjectMeta;
  summary: SidebarProjectSummary;
  sessions: SidebarProjectDrawerSession[];
  filtered?: boolean;
  onClose: () => void;
  onOpenSession: (sessionId: string) => void | Promise<void>;
  onOpenArtifactSession?: (artifact: SidebarProjectArtifactMeta) => void | Promise<void>;
  onStartGoal?: (goal: SidebarProjectGoalMeta) => void | Promise<void>;
  onOpenGoalSession?: (sessionId: string) => void | Promise<void>;
  onOpenWorkspaceAssets?: () => void;
  onNewSession?: () => void | Promise<void>;
  onRenameProject?: (name: string) => void | Promise<void>;
  onSetProjectDescription?: (description: string | null) => void | Promise<void>;
  onSetProjectStatus?: (status: ProjectStatus) => void | Promise<void>;
}

const GOAL_STATUS_LABEL: Record<SidebarProjectGoalMeta['status'], string> = {
  active: '进行中',
  met: '已达成',
  aborted: '待处理',
  archived: '已归档',
};

const ARTIFACT_KIND_LABEL: Record<SidebarProjectArtifactMeta['kind'], string> = {
  chart: '图表',
  spreadsheet: '表格',
  document: '文档',
  generative_ui: '界面',
  mermaid: '图示',
  question_form: '表单',
  file: '文件',
  generic_html: '网页',
  web_snapshot: '网页',
  link: '链接',
};

const PROJECT_STATUS_LABEL: Record<ProjectStatus, string> = {
  active: '进行中',
  idle: '空闲',
  archived: '已归档',
};

function formatRelativeUpdatedAt(timestamp: number | undefined): string | null {
  if (!timestamp || !Number.isFinite(timestamp)) {
    return null;
  }
  return new Date(timestamp).toLocaleString();
}

function getGoalStatusIcon(status: SidebarProjectGoalMeta['status']): React.ReactNode {
  if (status === 'met') return <CheckCircle2 className="h-3.5 w-3.5 text-emerald-400" />;
  if (status === 'aborted') return <AlertTriangle className="h-3.5 w-3.5 text-amber-400" />;
  if (status === 'archived') return <Clock3 className="h-3.5 w-3.5 text-zinc-500" />;
  return <Target className="h-3.5 w-3.5 text-violet-300" />;
}

function formatArtifactMeta(artifact: SidebarProjectArtifactMeta): string {
  return [
    ARTIFACT_KIND_LABEL[artifact.kind] ?? artifact.kind,
    artifact.toolName?.trim(),
    artifact.sessionTitle?.trim(),
  ].filter(Boolean).join(' · ');
}

function getPrimaryPath(paths: string[]): string {
  const primary = paths.find((path) => path.trim());
  return primary || '未绑定工作区';
}

export const SidebarProjectDrawer: React.FC<SidebarProjectDrawerProps> = ({
  title,
  summaryLine,
  paths,
  meta,
  summary,
  sessions,
  filtered = false,
  onClose,
  onOpenSession,
  onOpenArtifactSession,
  onStartGoal,
  onOpenGoalSession,
  onOpenWorkspaceAssets,
  onNewSession,
  onRenameProject,
  onSetProjectDescription,
  onSetProjectStatus,
}) => {
  const [editingProject, setEditingProject] = React.useState(false);
  const [draftName, setDraftName] = React.useState(title);
  const [draftDescription, setDraftDescription] = React.useState(meta?.description ?? '');
  const [draftStatus, setDraftStatus] = React.useState<ProjectStatus>(meta?.status ?? 'active');
  const [savingProject, setSavingProject] = React.useState(false);
  const [editError, setEditError] = React.useState<string | null>(null);
  const visibleGoals = meta?.goals?.filter((goal) => goal.status !== 'archived').slice(0, 8) ?? [];
  const visibleArtifacts = meta?.recentArtifacts?.slice(0, 8) ?? [];
  const visibleRoles = meta?.roleIds?.slice(0, 12) ?? [];
  const updatedAt = formatRelativeUpdatedAt(meta?.updatedAt ?? summary.latestActivityAt);
  const activeGoalCount = visibleGoals.filter((goal) => goal.status === 'active').length;
  const drawerSessionLabel = filtered ? '当前筛选会话' : '最近会话';
  const canEditProject = Boolean(onRenameProject || onSetProjectDescription || onSetProjectStatus);

  React.useEffect(() => {
    setDraftName(title);
    setDraftDescription(meta?.description ?? '');
    setDraftStatus(meta?.status ?? 'active');
    setEditError(null);
  }, [meta?.description, meta?.status, title]);

  const handleCancelEdit = (): void => {
    setDraftName(title);
    setDraftDescription(meta?.description ?? '');
    setDraftStatus(meta?.status ?? 'active');
    setEditError(null);
    setEditingProject(false);
  };

  const handleSaveProject = async (): Promise<void> => {
    const nextName = draftName.trim();
    if (!nextName) {
      setEditError('项目名不能为空');
      return;
    }
    setSavingProject(true);
    setEditError(null);
    try {
      if (onRenameProject && nextName !== title) {
        await onRenameProject(nextName);
      }
      const currentDescription = meta?.description?.trim() ?? '';
      const nextDescription = draftDescription.trim();
      if (onSetProjectDescription && nextDescription !== currentDescription) {
        await onSetProjectDescription(nextDescription || null);
      }
      if (onSetProjectStatus && draftStatus !== (meta?.status ?? 'active')) {
        await onSetProjectStatus(draftStatus);
      }
      setEditingProject(false);
    } catch (error) {
      setEditError(error instanceof Error ? error.message : '保存项目失败');
    } finally {
      setSavingProject(false);
    }
  };

  return (
    <div className="fixed inset-0 z-[9998] flex justify-end bg-black/45" role="dialog" aria-modal="true" aria-label={`${title} 项目控制台`}>
      <button
        type="button"
        aria-label="关闭项目控制台背景"
        className="absolute inset-0 cursor-default"
        onClick={onClose}
      />
      <aside className="relative flex h-full w-full max-w-[460px] flex-col border-l border-zinc-800 bg-zinc-950 shadow-2xl">
        <div className="border-b border-zinc-800 px-4 py-3">
          <div className="flex items-start gap-3">
            <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md border border-zinc-800 bg-zinc-900/80">
              <Folder className="h-4 w-4 text-zinc-400" />
            </div>
            <div className="min-w-0 flex-1">
              {editingProject ? (
                <div className="grid gap-1.5">
                  <div className="flex min-w-0 items-center gap-1.5">
                    <input
                      value={draftName}
                      onChange={(event) => setDraftName(event.target.value)}
                      aria-label="项目名称"
                      className="min-w-0 flex-1 rounded-md border border-zinc-700 bg-zinc-900 px-2 py-1 text-sm font-medium text-zinc-100 outline-hidden focus:border-violet-500/60"
                    />
                    <select
                      value={draftStatus}
                      onChange={(event) => setDraftStatus(event.target.value as ProjectStatus)}
                      aria-label="项目状态"
                      className="shrink-0 rounded-md border border-zinc-700 bg-zinc-900 px-1.5 py-1 text-[11px] text-zinc-300 outline-hidden focus:border-violet-500/60"
                    >
                      <option value="active">进行中</option>
                      <option value="idle">空闲</option>
                      <option value="archived">已归档</option>
                    </select>
                  </div>
                  <textarea
                    value={draftDescription}
                    onChange={(event) => setDraftDescription(event.target.value)}
                    aria-label="项目描述"
                    rows={2}
                    className="min-h-[52px] resize-none rounded-md border border-zinc-700 bg-zinc-900 px-2 py-1 text-[11px] leading-5 text-zinc-300 outline-hidden focus:border-violet-500/60"
                    placeholder="项目描述"
                  />
                  <div className="flex items-center gap-1.5">
                    <button
                      type="button"
                      disabled={savingProject}
                      onClick={() => { void handleSaveProject(); }}
                      className="rounded-md border border-violet-500/30 bg-violet-500/10 px-2 py-0.5 text-[11px] font-medium text-violet-200 transition-colors hover:bg-violet-500/20 disabled:cursor-not-allowed disabled:opacity-50"
                    >
                      {savingProject ? '保存中' : '保存'}
                    </button>
                    <button
                      type="button"
                      disabled={savingProject}
                      onClick={handleCancelEdit}
                      className="rounded-md border border-zinc-700 bg-zinc-900 px-2 py-0.5 text-[11px] text-zinc-400 transition-colors hover:bg-zinc-800 hover:text-zinc-200 disabled:cursor-not-allowed disabled:opacity-50"
                    >
                      取消
                    </button>
                    {editError && <span className="min-w-0 truncate text-[10px] text-rose-300">{editError}</span>}
                  </div>
                </div>
              ) : (
                <>
                  <div className="flex min-w-0 items-center gap-2">
                    <h2 className="truncate text-sm font-semibold text-zinc-100">{title}</h2>
                    {meta?.status && (
                      <span className="shrink-0 rounded border border-zinc-700 bg-zinc-900 px-1.5 py-0.5 text-[10px] text-zinc-400">
                        {PROJECT_STATUS_LABEL[meta.status]}
                      </span>
                    )}
                  </div>
                  <p className="mt-0.5 truncate text-[11px] text-zinc-500">{meta?.description?.trim() || summaryLine}</p>
                </>
              )}
              <p className="mt-0.5 truncate text-[10px] text-zinc-600">{getPrimaryPath(paths)}</p>
            </div>
            {canEditProject && !editingProject && (
              <button
                type="button"
                aria-label={`编辑 ${title} 项目`}
                onClick={() => setEditingProject(true)}
                className="rounded-md border border-zinc-700 bg-zinc-900 px-2 py-1 text-[11px] text-zinc-400 transition-colors hover:bg-zinc-800 hover:text-zinc-200"
              >
                编辑
              </button>
            )}
            <button
              type="button"
              aria-label="关闭项目控制台"
              onClick={onClose}
              className="rounded-md p-1 text-zinc-500 transition-colors hover:bg-zinc-800 hover:text-zinc-200"
            >
              <X className="h-4 w-4" />
            </button>
          </div>

          <div className="mt-3 grid grid-cols-5 gap-1.5 text-center text-[10px]">
            <div className="rounded-md border border-zinc-800 bg-zinc-900/55 px-1.5 py-1.5">
              <div className="text-zinc-500">会话</div>
              <div className="mt-0.5 text-xs font-medium text-zinc-200">{summary.sessionCount}</div>
            </div>
            <div className="rounded-md border border-zinc-800 bg-zinc-900/55 px-1.5 py-1.5">
              <div className="text-zinc-500">未完成</div>
              <div className="mt-0.5 text-xs font-medium text-amber-300">{summary.unfinishedCount}</div>
            </div>
            <div className="rounded-md border border-zinc-800 bg-zinc-900/55 px-1.5 py-1.5">
              <div className="text-zinc-500">目标</div>
              <div className="mt-0.5 text-xs font-medium text-violet-200">{summary.goalCount ?? visibleGoals.length}</div>
            </div>
            <div className="rounded-md border border-zinc-800 bg-zinc-900/55 px-1.5 py-1.5">
              <div className="text-zinc-500">产物</div>
              <div className="mt-0.5 text-xs font-medium text-cyan-200">{summary.artifactCount ?? visibleArtifacts.length}</div>
            </div>
            <div className="rounded-md border border-zinc-800 bg-zinc-900/55 px-1.5 py-1.5">
              <div className="text-zinc-500">待审</div>
              <div className="mt-0.5 text-xs font-medium text-amber-200">{summary.reviewIssueCount}</div>
            </div>
          </div>

          <div className="mt-3 flex flex-wrap items-center gap-1.5">
            {onNewSession && (
              <button
                type="button"
                onClick={() => { void onNewSession(); }}
                className="inline-flex items-center gap-1 rounded-md border border-zinc-700 bg-zinc-900 px-2 py-1 text-[11px] text-zinc-300 transition-colors hover:bg-zinc-800 hover:text-zinc-100"
              >
                <MessageSquare className="h-3.5 w-3.5" />
                新建项目会话
              </button>
            )}
            {onOpenWorkspaceAssets && (
              <button
                type="button"
                onClick={onOpenWorkspaceAssets}
                className="inline-flex items-center gap-1 rounded-md border border-zinc-700 bg-zinc-900 px-2 py-1 text-[11px] text-zinc-300 transition-colors hover:bg-zinc-800 hover:text-zinc-100"
              >
                <ScrollText className="h-3.5 w-3.5" />
                打开项目产物
              </button>
            )}
          </div>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
          <section>
            <div className="mb-1.5 flex items-center justify-between gap-2">
              <div className="flex items-center gap-1.5 text-xs font-medium text-zinc-300">
                <Target className="h-3.5 w-3.5 text-zinc-500" />
                目标
              </div>
              <span className="text-[10px] text-zinc-600">{activeGoalCount} 进行中</span>
            </div>
            {visibleGoals.length > 0 ? (
              <div className="grid gap-1.5">
                {visibleGoals.map((goal) => (
                  <div key={goal.id} className="rounded-md border border-zinc-800 bg-zinc-900/45 px-2.5 py-2">
                    <div className="flex items-start gap-2">
                      <span className="mt-0.5 shrink-0">{getGoalStatusIcon(goal.status)}</span>
                      <div className="min-w-0 flex-1">
                        <div className="truncate text-xs font-medium text-zinc-200">{goal.title}</div>
                        <div className="mt-0.5 flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-[10px] text-zinc-600">
                          <span>{GOAL_STATUS_LABEL[goal.status]}</span>
                          {goal.lastRunSessionId && <span>已有启动会话</span>}
                        </div>
                      </div>
                      {goal.lastRunSessionId && onOpenGoalSession && (
                        <button
                          type="button"
                          aria-label={`打开目标 ${goal.title} 的上次会话`}
                          onClick={() => { void onOpenGoalSession(goal.lastRunSessionId as string); }}
                          className="shrink-0 rounded p-1 text-zinc-500 transition-colors hover:bg-zinc-800 hover:text-zinc-200"
                        >
                          <ArrowRight className="h-3.5 w-3.5" />
                        </button>
                      )}
                      {goal.status === 'active' && onStartGoal && (
                        <button
                          type="button"
                          aria-label={`从目标 ${goal.title} 新建项目会话`}
                          onClick={() => { void onStartGoal(goal); }}
                          className="shrink-0 rounded p-1 text-zinc-500 transition-colors hover:bg-zinc-800 hover:text-zinc-200"
                        >
                          <Play className="h-3.5 w-3.5" />
                        </button>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <div className="rounded-md border border-zinc-800 bg-zinc-900/35 px-2.5 py-2 text-xs text-zinc-500">
                这个项目暂未暴露目标
              </div>
            )}
          </section>

          <section className="mt-4">
            <div className="mb-1.5 flex items-center gap-1.5 text-xs font-medium text-zinc-300">
              <FileText className="h-3.5 w-3.5 text-zinc-500" />
              产物
            </div>
            {visibleArtifacts.length > 0 ? (
              <div className="grid gap-1.5">
                {visibleArtifacts.map((artifact) => {
                  const canOpen = Boolean(artifact.sessionId && onOpenArtifactSession);
                  return (
                    <button
                      key={`${artifact.sessionId}:${artifact.id}:${artifact.createdAt}`}
                      type="button"
                      disabled={!canOpen}
                      aria-label={canOpen ? `打开产物 ${artifact.title} 的来源会话` : undefined}
                      onClick={() => {
                        if (canOpen) void onOpenArtifactSession?.(artifact);
                      }}
                      className="rounded-md border border-zinc-800 bg-zinc-900/45 px-2.5 py-2 text-left transition-colors enabled:hover:bg-zinc-800/70 disabled:cursor-default"
                    >
                      <div className="flex min-w-0 items-center gap-2">
                        <Layers3 className="h-3.5 w-3.5 shrink-0 text-cyan-300/70" />
                        <span className="min-w-0 flex-1 truncate text-xs font-medium text-zinc-200">{artifact.title}</span>
                        {canOpen && <ArrowRight className="h-3.5 w-3.5 shrink-0 text-zinc-600" />}
                      </div>
                      <div className="mt-0.5 truncate pl-5 text-[10px] text-zinc-600">{formatArtifactMeta(artifact)}</div>
                    </button>
                  );
                })}
              </div>
            ) : (
              <div className="rounded-md border border-zinc-800 bg-zinc-900/35 px-2.5 py-2 text-xs text-zinc-500">
                这个项目暂未发现产物
              </div>
            )}
          </section>

          <section className="mt-4">
            <div className="mb-1.5 flex items-center justify-between gap-2">
              <div className="flex items-center gap-1.5 text-xs font-medium text-zinc-300">
                <MessageSquare className="h-3.5 w-3.5 text-zinc-500" />
                {drawerSessionLabel}
              </div>
              <span className="text-[10px] text-zinc-600">{sessions.length} 条</span>
            </div>
            {sessions.length > 0 ? (
              <div className="grid gap-1.5">
                {sessions.slice(0, 12).map((session) => (
                  <button
                    key={session.id}
                    type="button"
                    aria-label={`打开项目会话 ${session.title}`}
                    onClick={() => { void onOpenSession(session.id); }}
                    className={`rounded-md border px-2.5 py-2 text-left transition-colors hover:bg-zinc-800/70 ${
                      session.isCurrent
                        ? 'border-violet-500/30 bg-violet-500/10'
                        : 'border-zinc-800 bg-zinc-900/45'
                    }`}
                  >
                    <div className="flex min-w-0 items-center gap-2">
                      <span className="min-w-0 flex-1 truncate text-xs font-medium text-zinc-200">{session.title}</span>
                      {session.typeLabel && (
                        <span className="shrink-0 rounded border border-zinc-700 bg-zinc-950/60 px-1.5 py-0.5 text-[10px] text-zinc-500">
                          {session.typeLabel}
                        </span>
                      )}
                      {session.showStatusBadge && (
                        <span className={`shrink-0 rounded border px-1.5 py-0.5 text-[10px] font-medium ${session.statusToneClassName}`}>
                          {session.statusLabel}
                        </span>
                      )}
                    </div>
                    <div className="mt-0.5 flex min-w-0 items-center gap-1.5 text-[10px] text-zinc-600">
                      <span className="min-w-0 flex-1 truncate">
                        {session.summary || session.workingDirectory || `${session.messageCount ?? 0} 消息`}
                      </span>
                      <span className="shrink-0">{session.lastActiveLabel}</span>
                    </div>
                    <div className="mt-1 flex min-w-0 flex-wrap items-center gap-1">
                      {session.gitBranch && (
                        <span className="inline-flex items-center gap-1 rounded border border-zinc-800 bg-zinc-950/50 px-1.5 py-0.5 text-[10px] text-zinc-500">
                          <GitBranch className="h-3 w-3" />
                          {session.gitBranch}
                        </span>
                      )}
                      {session.prLabel && (
                        <span className="rounded border border-zinc-800 bg-zinc-950/50 px-1.5 py-0.5 text-[10px] text-zinc-500">
                          {session.prLabel}
                        </span>
                      )}
                      {session.hasDeliverySignals && (
                        <span className="rounded border border-cyan-500/20 bg-cyan-500/10 px-1.5 py-0.5 text-[10px] text-cyan-300">
                          交付线索
                        </span>
                      )}
                      {session.replayEvidenceCount ? (
                        <span className="rounded border border-violet-500/20 bg-violet-500/10 px-1.5 py-0.5 text-[10px] text-violet-300">
                          Replay {session.replayEvidenceCount}
                        </span>
                      ) : null}
                      {session.pendingReviewCount ? (
                        <span className="inline-flex items-center gap-1 rounded border border-amber-500/20 bg-amber-500/10 px-1.5 py-0.5 text-[10px] text-amber-300">
                          <ShieldAlert className="h-3 w-3" />
                          待审 {session.pendingReviewCount}
                        </span>
                      ) : null}
                    </div>
                  </button>
                ))}
                {sessions.length > 12 && (
                  <div className="px-1 text-[10px] text-zinc-600">另有 {sessions.length - 12} 条会话未展示</div>
                )}
              </div>
            ) : (
              <div className="rounded-md border border-zinc-800 bg-zinc-900/35 px-2.5 py-2 text-xs text-zinc-500">
                当前没有可展示会话
              </div>
            )}
          </section>

          <section className="mt-4">
            <div className="mb-1.5 flex items-center gap-1.5 text-xs font-medium text-zinc-300">
              <Users className="h-3.5 w-3.5 text-zinc-500" />
              项目上下文
            </div>
            <div className="grid gap-1.5">
              {paths.length > 0 && (
                <div className="rounded-md border border-zinc-800 bg-zinc-900/35 px-2.5 py-2">
                  <div className="text-[10px] font-medium text-zinc-500">工作区</div>
                  <div className="mt-1 grid gap-1">
                    {paths.slice(0, 6).map((path) => (
                      <div key={path} className="truncate text-[11px] text-zinc-400">{path}</div>
                    ))}
                  </div>
                </div>
              )}
              {visibleRoles.length > 0 && (
                <div className="rounded-md border border-zinc-800 bg-zinc-900/35 px-2.5 py-2">
                  <div className="text-[10px] font-medium text-zinc-500">角色</div>
                  <div className="mt-1 flex flex-wrap gap-1">
                    {visibleRoles.map((roleId) => (
                      <span key={roleId} className="rounded border border-zinc-800 bg-zinc-950/50 px-1.5 py-0.5 text-[10px] text-zinc-500">
                        {roleId}
                      </span>
                    ))}
                  </div>
                </div>
              )}
              {updatedAt && (
                <div className="flex items-center gap-1.5 text-[10px] text-zinc-600">
                  <Clock3 className="h-3 w-3" />
                  最近活动 {updatedAt}
                </div>
              )}
            </div>
          </section>
        </div>
      </aside>
    </div>
  );
};

export default SidebarProjectDrawer;
