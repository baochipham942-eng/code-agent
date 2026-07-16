import React from 'react';
import { CheckCircle2, Clock3, FileText, Layers3, Play, Target, Users, XCircle } from 'lucide-react';
import type {
  SidebarProjectArtifactMeta,
  SidebarProjectGoalMeta,
  SidebarProjectMeta,
} from '../../../utils/sidebarProjectSummary';

export interface SidebarProjectDetailProps {
  meta?: SidebarProjectMeta;
  fallbackSessionCount: number;
  onOpenArtifactSession?: (artifact: SidebarProjectArtifactMeta) => void | Promise<void>;
  onStartGoal?: (goal: SidebarProjectGoalMeta) => void | Promise<void>;
}

function formatList(items: string[] | undefined, fallback: string): string {
  const visibleItems = (items ?? [])
    .map((item) => item.trim())
    .filter(Boolean)
    .slice(0, 3);

  return visibleItems.length > 0 ? visibleItems.join(' · ') : fallback;
}

const GOAL_STATUS_LABEL: Record<SidebarProjectGoalMeta['status'], string> = {
  active: '进行中',
  met: '已达成',
  aborted: '已终止',
  archived: '已归档',
};

const ARTIFACT_KIND_LABEL: Record<SidebarProjectArtifactMeta['kind'], string> = {
  chart: '图表',
  spreadsheet: '表格',
  document: '文档',
  generative_ui: '界面',
  neo_ui: '交互界面',
  mermaid: '图示',
  question_form: '表单',
  file: '文件',
  generic_html: '网页',
  web_snapshot: '网页',
  link: '链接',
  text: '文本',
  binary: '二进制',
  image: '图片',
  audio: '音频',
  video: '视频',
  web: '网页',
  search: '搜索',
  'process-output': '输出',
  'process-log': '日志',
};

function getGoalStatusIcon(status: SidebarProjectGoalMeta['status']): React.ReactNode {
  if (status === 'met') return <CheckCircle2 className="h-3 w-3 text-emerald-500" />;
  if (status === 'aborted') return <XCircle className="h-3 w-3 text-rose-500" />;
  return <Clock3 className="h-3 w-3 text-amber-500" />;
}

function getGoalCounts(goals: SidebarProjectGoalMeta[] | undefined): Record<SidebarProjectGoalMeta['status'], number> {
  const counts: Record<SidebarProjectGoalMeta['status'], number> = {
    active: 0,
    met: 0,
    aborted: 0,
    archived: 0,
  };
  for (const goal of goals ?? []) {
    counts[goal.status] += 1;
  }
  return counts;
}

function formatRecentArtifactLine(artifact: SidebarProjectArtifactMeta): string {
  const parts = [ARTIFACT_KIND_LABEL[artifact.kind] ?? artifact.kind];
  if (artifact.toolName?.trim()) {
    parts.push(artifact.toolName.trim());
  }
  if (artifact.sessionTitle?.trim()) {
    parts.push(artifact.sessionTitle.trim());
  }
  return parts.join(' · ');
}

export const SidebarProjectDetail: React.FC<SidebarProjectDetailProps> = ({
  meta,
  fallbackSessionCount,
  onOpenArtifactSession,
  onStartGoal,
}) => {
  const sessionCount = meta?.sessionCount ?? fallbackSessionCount;
  const goalFallback = meta ? `${meta.goalCount ?? 0} 个目标` : '项目详情加载中';
  const artifactFallback = meta ? `${meta.artifactCount ?? 0} 个产物` : '项目详情加载中';
  const goalCounts = getGoalCounts(meta?.goals);
  const visibleGoals = meta?.goals?.slice(0, 4) ?? [];
  const visibleArtifacts = meta?.recentArtifacts?.slice(0, 4) ?? [];
  const visibleRoles = meta?.roleIds?.slice(0, 4) ?? [];

  return (
    <div className="mx-3 mb-1 rounded-md border border-zinc-800/80 bg-zinc-950/35 px-2.5 py-2 text-[11px] text-zinc-500">
      <div className="flex items-center justify-between gap-2 border-b border-zinc-800/70 pb-2">
        <div className="min-w-0">
          <div className="truncate text-xs font-medium text-zinc-300">
            {meta?.name ?? '项目详情'}
          </div>
          <div className="mt-0.5 truncate text-[10px] text-zinc-600">
            {meta?.description?.trim() || `${sessionCount} 会话 · ${meta?.artifactCount ?? 0} 产物`}
          </div>
        </div>
        {meta?.status && (
          <span className="shrink-0 rounded border border-zinc-800 bg-zinc-900/70 px-1.5 py-0.5 text-[10px] text-zinc-400">
            {meta.status === 'active' ? '进行中' : meta.status === 'archived' ? '已归档' : '空闲'}
          </span>
        )}
      </div>

      <div className="mt-2 grid gap-2">
        <section className="grid gap-1">
          <div className="flex min-w-0 items-center gap-1.5">
            <Target className="h-3 w-3 shrink-0 text-zinc-600" />
            <span className="shrink-0 text-zinc-500">目标</span>
            <span className="min-w-0 flex-1 truncate text-zinc-600">
              {meta
                ? `${goalCounts.active} 进行中 · ${goalCounts.met} 已达成 · ${goalCounts.aborted} 待处理`
                : goalFallback}
            </span>
          </div>
          {visibleGoals.length > 0 ? (
            <div className="grid gap-1 pl-4">
              {visibleGoals.map((goal) => (
                <div key={`${goal.status}:${goal.title}`} className="flex min-w-0 items-center gap-1.5">
                  {getGoalStatusIcon(goal.status)}
                  <span className="min-w-0 flex-1 truncate text-zinc-400">{goal.title}</span>
                  {goal.lastRunSessionId && (
                    <span className="shrink-0 text-[10px] text-zinc-600">已启动</span>
                  )}
                  <span className="shrink-0 text-[10px] text-zinc-600">{GOAL_STATUS_LABEL[goal.status]}</span>
                  {onStartGoal && goal.status === 'active' && (
                    <button
                      type="button"
                      onClick={(event) => {
                        event.preventDefault();
                        event.stopPropagation();
                        void onStartGoal(goal);
                      }}
                      aria-label={`从目标 ${goal.title} 新建项目会话`}
                      title={`从目标 ${goal.title} 新建项目会话`}
                      className="shrink-0 rounded p-0.5 text-zinc-600 transition-colors hover:bg-zinc-800 hover:text-zinc-200"
                    >
                      <Play className="h-3 w-3" />
                    </button>
                  )}
                </div>
              ))}
            </div>
          ) : (
            <div className="flex min-w-0 items-center gap-1.5 pl-4">
              <span className="truncate text-zinc-400">
                {formatList(meta?.activeGoalTitles, goalFallback)}
              </span>
            </div>
          )}
        </section>

        <section className="grid gap-1">
          <div className="flex min-w-0 items-center gap-1.5">
            <FileText className="h-3 w-3 shrink-0 text-zinc-600" />
            <span className="shrink-0 text-zinc-500">产物</span>
            <span className="min-w-0 flex-1 truncate text-zinc-600">
              {meta ? `${meta.artifactCount ?? 0} 个产物` : artifactFallback}
            </span>
          </div>
          {visibleArtifacts.length > 0 ? (
            <div className="grid gap-1 pl-4">
              {visibleArtifacts.map((artifact) => {
                const canOpenSource = Boolean(onOpenArtifactSession && artifact.sessionId);
                const className = "flex min-w-0 items-center gap-1.5 rounded-md px-1 py-0.5 text-left";
                const content = (
                  <>
                    <Layers3 className="h-3 w-3 shrink-0 text-zinc-600" />
                    <span className="min-w-0 flex-1 truncate text-zinc-400">{artifact.title}</span>
                    <span className="shrink-0 truncate text-[10px] text-zinc-600">
                      {formatRecentArtifactLine(artifact)}
                    </span>
                  </>
                );
                if (canOpenSource) {
                  return (
                    <button
                      key={`${artifact.sessionId}:${artifact.kind}:${artifact.title}:${artifact.createdAt}`}
                      type="button"
                      onClick={(event) => {
                        event.preventDefault();
                        event.stopPropagation();
                        void onOpenArtifactSession?.(artifact);
                      }}
                      aria-label={`打开产物 ${artifact.title} 的来源会话`}
                      title={`打开产物 ${artifact.title} 的来源会话`}
                      className={`${className} transition-colors hover:bg-zinc-800/70 hover:text-zinc-200`}
                    >
                      {content}
                    </button>
                  );
                }
                return (
                  <div key={`${artifact.kind}:${artifact.title}:${artifact.createdAt}`} className={className}>
                    {content}
                  </div>
                );
              })}
            </div>
          ) : (
            <div className="flex min-w-0 items-center gap-1.5 pl-4">
              <span className="truncate text-zinc-400">
                {formatList(meta?.recentArtifactTitles, artifactFallback)}
              </span>
            </div>
          )}
        </section>

        <section className="grid gap-1">
          <div className="flex min-w-0 items-center gap-1.5">
            <Users className="h-3 w-3 shrink-0 text-zinc-600" />
            <span className="shrink-0 text-zinc-500">上下文</span>
            <span className="min-w-0 flex-1 truncate text-zinc-600">
              {meta ? `${meta.roleCount ?? 0} 角色 · ${sessionCount} 会话` : `${sessionCount} 会话`}
            </span>
          </div>
          {visibleRoles.length > 0 && (
            <div className="flex flex-wrap gap-1 pl-4">
              {visibleRoles.map((roleId) => (
                <span key={roleId} className="rounded border border-zinc-800 bg-zinc-900/70 px-1.5 py-0.5 text-[10px] text-zinc-500">
                  {roleId}
                </span>
              ))}
            </div>
          )}
        </section>
      </div>
    </div>
  );
};

export default SidebarProjectDetail;
