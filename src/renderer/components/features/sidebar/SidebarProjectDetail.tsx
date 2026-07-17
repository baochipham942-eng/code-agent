import React from 'react';
import { CheckCircle2, Clock3, FileText, Layers3, Play, Target, Users, XCircle } from 'lucide-react';
import type {
  SidebarProjectArtifactMeta,
  SidebarProjectGoalMeta,
  SidebarProjectMeta,
} from '../../../utils/sidebarProjectSummary';
import { useI18n } from '../../../hooks/useI18n';
import type { Translations } from '../../../i18n';

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

function getGoalStatusLabel(status: SidebarProjectGoalMeta['status'], t: Translations): string {
  const p = t.sidebarProject;
  switch (status) {
    case 'met':
      return p.goalStatusMet;
    case 'aborted':
      return p.goalStatusTerminated;
    case 'archived':
      return p.goalStatusArchived;
    default:
      return p.goalStatusActive;
  }
}

function getArtifactKindLabel(kind: SidebarProjectArtifactMeta['kind'], t: Translations): string {
  const k = t.sidebarProject.artifactKind;
  switch (kind) {
    case 'process-output':
      return k.processOutput;
    case 'process-log':
      return k.processLog;
    default:
      return k[kind] ?? kind;
  }
}

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

function formatRecentArtifactLine(artifact: SidebarProjectArtifactMeta, t: Translations): string {
  const parts = [getArtifactKindLabel(artifact.kind, t)];
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
  const { t } = useI18n();
  const p = t.sidebarProject;
  const sessionCount = meta?.sessionCount ?? fallbackSessionCount;
  const goalFallback = meta ? p.goalCountFallback.replace('{count}', String(meta.goalCount ?? 0)) : p.detailLoading;
  const artifactFallback = meta ? p.artifactCountFallback.replace('{count}', String(meta.artifactCount ?? 0)) : p.detailLoading;
  const goalCounts = getGoalCounts(meta?.goals);
  const visibleGoals = meta?.goals?.slice(0, 4) ?? [];
  const visibleArtifacts = meta?.recentArtifacts?.slice(0, 4) ?? [];
  const visibleRoles = meta?.roleIds?.slice(0, 4) ?? [];

  return (
    <div className="mx-3 mb-1 rounded-md border border-zinc-800/80 bg-zinc-950/35 px-2.5 py-2 text-[11px] text-zinc-500">
      <div className="flex items-center justify-between gap-2 border-b border-zinc-800/70 pb-2">
        <div className="min-w-0">
          <div className="truncate text-xs font-medium text-zinc-300">
            {meta?.name ?? p.projectDetailTitle}
          </div>
          <div className="mt-0.5 truncate text-[10px] text-zinc-600">
            {meta?.description?.trim() || p.sessionArtifactSummary.replace('{sessions}', String(sessionCount)).replace('{artifacts}', String(meta?.artifactCount ?? 0))}
          </div>
        </div>
        {meta?.status && (
          <span className="shrink-0 rounded border border-zinc-800 bg-zinc-900/70 px-1.5 py-0.5 text-[10px] text-zinc-400">
            {meta.status === 'active' ? p.statusActive : meta.status === 'archived' ? p.statusArchived : p.statusIdle}
          </span>
        )}
      </div>

      <div className="mt-2 grid gap-2">
        <section className="grid gap-1">
          <div className="flex min-w-0 items-center gap-1.5">
            <Target className="h-3 w-3 shrink-0 text-zinc-600" />
            <span className="shrink-0 text-zinc-500">{p.goals}</span>
            <span className="min-w-0 flex-1 truncate text-zinc-600">
              {meta
                ? p.goalCountsLine
                    .replace('{active}', String(goalCounts.active))
                    .replace('{met}', String(goalCounts.met))
                    .replace('{aborted}', String(goalCounts.aborted))
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
                    <span className="shrink-0 text-[10px] text-zinc-600">{p.goalStarted}</span>
                  )}
                  <span className="shrink-0 text-[10px] text-zinc-600">{getGoalStatusLabel(goal.status, t)}</span>
                  {onStartGoal && goal.status === 'active' && (
                    <button
                      type="button"
                      onClick={(event) => {
                        event.preventDefault();
                        event.stopPropagation();
                        void onStartGoal(goal);
                      }}
                      aria-label={p.newSessionFromGoal.replace('{title}', goal.title)}
                      title={p.newSessionFromGoal.replace('{title}', goal.title)}
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
            <span className="shrink-0 text-zinc-500">{p.artifacts}</span>
            <span className="min-w-0 flex-1 truncate text-zinc-600">
              {meta ? p.artifactCountFallback.replace('{count}', String(meta.artifactCount ?? 0)) : artifactFallback}
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
                      {formatRecentArtifactLine(artifact, t)}
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
                      aria-label={p.openArtifactSource.replace('{title}', artifact.title)}
                      title={p.openArtifactSource.replace('{title}', artifact.title)}
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
            <span className="shrink-0 text-zinc-500">{p.context}</span>
            <span className="min-w-0 flex-1 truncate text-zinc-600">
              {meta
                ? p.roleSessionSummary.replace('{roles}', String(meta.roleCount ?? 0)).replace('{sessions}', String(sessionCount))
                : p.sessionCountLabel.replace('{sessions}', String(sessionCount))}
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
