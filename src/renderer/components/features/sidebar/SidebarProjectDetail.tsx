import React, { useCallback, useMemo, useState } from 'react';
import {
  Archive,
  CheckCircle2,
  Clock3,
  FileText,
  Layers3,
  Pencil,
  Play,
  Plus,
  Target,
  UserPlus,
  Users,
  X,
  XCircle,
} from 'lucide-react';
import { IPC_DOMAINS } from '@shared/ipc';
import type { RolePanelEntry } from '@shared/contract/roleAssets';
import type {
  SidebarProjectArtifactMeta,
  SidebarProjectGoalMeta,
  SidebarProjectMeta,
} from '../../../utils/sidebarProjectSummary';
import { useI18n } from '../../../hooks/useI18n';
import type { Translations } from '../../../i18n';
import ipcService from '../../../services/ipcService';
import {
  addProjectGoal,
  addProjectRole,
  removeProjectRole,
  renameProject,
  setProjectStatus,
} from '../../../services/projectClient';

export interface SidebarProjectDetailProps {
  projectId?: string;
  meta?: SidebarProjectMeta;
  fallbackSessionCount: number;
  onOpenArtifactSession?: (artifact: SidebarProjectArtifactMeta) => void | Promise<void>;
  onStartGoal?: (goal: SidebarProjectGoalMeta) => void | Promise<void>;
  onMetaChange?: (
    update: (current: SidebarProjectMeta | undefined) => SidebarProjectMeta | undefined,
  ) => void;
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
  projectId,
  meta,
  fallbackSessionCount,
  onOpenArtifactSession,
  onStartGoal,
  onMetaChange,
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
  const [editingName, setEditingName] = useState(false);
  const [nameDraft, setNameDraft] = useState('');
  const [addingGoal, setAddingGoal] = useState(false);
  const [goalDraft, setGoalDraft] = useState('');
  const [rolePickerOpen, setRolePickerOpen] = useState(false);
  const [roleOptions, setRoleOptions] = useState<RolePanelEntry[]>([]);
  const [actionError, setActionError] = useState<string | null>(null);
  const [busyAction, setBusyAction] = useState<string | null>(null);
  const joinedRoleIds = useMemo(() => new Set(meta?.roleIds ?? []), [meta?.roleIds]);
  const pickableRoles = roleOptions.filter((role) => !joinedRoleIds.has(role.roleId));

  const mutateMeta = useCallback((
    update: (current: SidebarProjectMeta | undefined) => SidebarProjectMeta | undefined,
  ) => {
    onMetaChange?.(update);
  }, [onMetaChange]);

  const handleRename = useCallback(async () => {
    const name = nameDraft.trim();
    if (!projectId || !name) return;
    setBusyAction('rename');
    setActionError(null);
    try {
      const updated = await renameProject(projectId, name);
      mutateMeta((current) => ({ ...current, name: updated.name }));
      setEditingName(false);
    } catch {
      setActionError(p.renameFailed);
    } finally {
      setBusyAction(null);
    }
  }, [mutateMeta, nameDraft, p.renameFailed, projectId]);

  const handleToggleArchive = useCallback(async () => {
    if (!projectId || !meta?.status) return;
    const nextStatus = meta.status === 'archived' ? 'active' : 'archived';
    setBusyAction('status');
    setActionError(null);
    try {
      const updated = await setProjectStatus(projectId, nextStatus);
      mutateMeta((current) => ({ ...current, status: updated.status }));
    } catch {
      setActionError(p.statusChangeFailed);
    } finally {
      setBusyAction(null);
    }
  }, [meta?.status, mutateMeta, p.statusChangeFailed, projectId]);

  const handleAddGoal = useCallback(async () => {
    const goal = goalDraft.trim();
    if (!projectId || !goal) return;
    setBusyAction('goal');
    setActionError(null);
    try {
      const created = await addProjectGoal(projectId, goal);
      mutateMeta((current) => {
        const goals = current?.goals ?? [];
        return {
          ...current,
          goalCount: (current?.goalCount ?? goals.length) + 1,
          activeGoalTitles: [created.goal, ...(current?.activeGoalTitles ?? [])],
          goals: [{
            id: created.id,
            title: created.goal,
            verify: created.verify,
            review: created.review,
            status: created.status,
            updatedAt: created.updatedAt,
            lastRunSessionId: created.lastRunSessionId,
          }, ...goals],
        };
      });
      setGoalDraft('');
      setAddingGoal(false);
    } catch {
      setActionError(p.addGoalFailed);
    } finally {
      setBusyAction(null);
    }
  }, [goalDraft, mutateMeta, p.addGoalFailed, projectId]);

  const handleToggleRolePicker = useCallback(async () => {
    const nextOpen = !rolePickerOpen;
    setRolePickerOpen(nextOpen);
    if (!nextOpen || roleOptions.length > 0) return;
    setActionError(null);
    try {
      const roles = await ipcService.invokeDomain<RolePanelEntry[]>(IPC_DOMAINS.ROLES, 'list');
      setRoleOptions(roles);
    } catch {
      setActionError(p.loadRolesFailed);
    }
  }, [p.loadRolesFailed, roleOptions.length, rolePickerOpen]);

  const handleAddRole = useCallback(async (roleId: string) => {
    if (!projectId) return;
    setBusyAction(`role:${roleId}`);
    setActionError(null);
    try {
      const created = await addProjectRole(projectId, roleId);
      mutateMeta((current) => {
        const roleIds = current?.roleIds ?? [];
        if (roleIds.includes(created.roleId)) return current;
        return {
          ...current,
          roleCount: (current?.roleCount ?? roleIds.length) + 1,
          roleIds: [...roleIds, created.roleId],
        };
      });
      setRolePickerOpen(false);
    } catch {
      setActionError(p.addRoleFailed);
    } finally {
      setBusyAction(null);
    }
  }, [mutateMeta, p.addRoleFailed, projectId]);

  const handleRemoveRole = useCallback(async (roleId: string) => {
    if (!projectId) return;
    setBusyAction(`role:${roleId}`);
    setActionError(null);
    try {
      await removeProjectRole(projectId, roleId);
      mutateMeta((current) => {
        const roleIds = current?.roleIds ?? [];
        if (!roleIds.includes(roleId)) return current;
        return {
          ...current,
          roleCount: Math.max((current?.roleCount ?? roleIds.length) - 1, 0),
          roleIds: roleIds.filter((id) => id !== roleId),
        };
      });
    } catch {
      setActionError(p.removeRoleFailed);
    } finally {
      setBusyAction(null);
    }
  }, [mutateMeta, p.removeRoleFailed, projectId]);

  return (
    <div className="mx-3 mb-1 rounded-md border border-zinc-800/80 bg-zinc-950/35 px-2.5 py-2 text-[11px] text-zinc-500">
      <div className="flex items-center justify-between gap-2 border-b border-zinc-800/70 pb-2">
        <div className="min-w-0">
          {editingName ? (
            <input
              autoFocus
              value={nameDraft}
              onChange={(event) => setNameDraft(event.target.value)}
              onKeyDown={(event) => {
                if (event.nativeEvent.isComposing || event.keyCode === 229) return;
                if (event.key === 'Enter') void handleRename();
                if (event.key === 'Escape') setEditingName(false);
              }}
              aria-label={p.renameProject}
              className="w-full rounded border border-zinc-700 bg-zinc-900 px-1.5 py-0.5 text-xs text-zinc-200 outline-none"
            />
          ) : (
            <div className="flex min-w-0 items-center gap-1">
              <div className="truncate text-xs font-medium text-zinc-300">
                {meta?.name ?? p.projectDetailTitle}
              </div>
              {projectId && meta?.name && (
                <button
                  type="button"
                  onClick={() => {
                    setNameDraft(meta.name ?? '');
                    setEditingName(true);
                  }}
                  aria-label={p.renameProject}
                  title={p.renameProject}
                  className="shrink-0 rounded p-0.5 text-zinc-600 hover:bg-zinc-800 hover:text-zinc-300"
                >
                  <Pencil className="h-3 w-3" />
                </button>
              )}
            </div>
          )}
          <div className="mt-0.5 truncate text-[10px] text-zinc-600">
            {meta?.description?.trim() || p.sessionArtifactSummary.replace('{sessions}', String(sessionCount)).replace('{artifacts}', String(meta?.artifactCount ?? 0))}
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          {meta?.status && (
            <span className="rounded border border-zinc-800 bg-zinc-900/70 px-1.5 py-0.5 text-[10px] text-zinc-400">
              {meta.status === 'active' ? p.statusActive : meta.status === 'archived' ? p.statusArchived : p.statusIdle}
            </span>
          )}
          {projectId && meta?.status && (
            <button
              type="button"
              disabled={busyAction === 'status'}
              onClick={() => void handleToggleArchive()}
              aria-label={meta.status === 'archived' ? p.restoreProject : p.archiveProject}
              title={meta.status === 'archived' ? p.restoreProject : p.archiveProject}
              className="rounded p-0.5 text-zinc-600 hover:bg-zinc-800 hover:text-zinc-300 disabled:opacity-50"
            >
              <Archive className="h-3 w-3" />
            </button>
          )}
        </div>
      </div>

      {actionError && (
        <div role="alert" className="mt-2 rounded border border-rose-500/20 bg-rose-500/10 px-2 py-1 text-[10px] text-rose-300">
          {actionError}
        </div>
      )}

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
            {projectId && (
              <button
                type="button"
                onClick={() => setAddingGoal((current) => !current)}
                aria-label={p.addGoal}
                title={p.addGoal}
                className="shrink-0 rounded p-0.5 text-zinc-600 hover:bg-zinc-800 hover:text-zinc-300"
              >
                <Plus className="h-3 w-3" />
              </button>
            )}
          </div>
          {addingGoal && (
            <div className="flex items-center gap-1 pl-4">
              <input
                autoFocus
                value={goalDraft}
                onChange={(event) => setGoalDraft(event.target.value)}
                onKeyDown={(event) => {
                  if (event.nativeEvent.isComposing || event.keyCode === 229) return;
                  if (event.key === 'Enter') void handleAddGoal();
                  if (event.key === 'Escape') setAddingGoal(false);
                }}
                placeholder={p.goalInputPlaceholder}
                className="min-w-0 flex-1 rounded border border-zinc-700 bg-zinc-900 px-1.5 py-1 text-[11px] text-zinc-200 outline-none"
              />
              <button
                type="button"
                disabled={!goalDraft.trim() || busyAction === 'goal'}
                onClick={() => void handleAddGoal()}
                className="rounded px-1.5 py-1 text-[10px] text-zinc-400 hover:bg-zinc-800 disabled:opacity-40"
              >
                {p.add}
              </button>
            </div>
          )}
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
            {projectId && (
              <button
                type="button"
                onClick={() => void handleToggleRolePicker()}
                aria-label={p.addRole}
                title={p.addRole}
                className="shrink-0 rounded p-0.5 text-zinc-600 hover:bg-zinc-800 hover:text-zinc-300"
              >
                <UserPlus className="h-3 w-3" />
              </button>
            )}
          </div>
          {visibleRoles.length > 0 && (
            <div className="flex flex-wrap gap-1 pl-4">
              {visibleRoles.map((roleId) => (
                <span key={roleId} className="flex items-center gap-1 rounded border border-zinc-800 bg-zinc-900/70 px-1.5 py-0.5 text-[10px] text-zinc-500">
                  {roleId}
                  {projectId && (
                    <button
                      type="button"
                      disabled={busyAction === `role:${roleId}`}
                      onClick={() => void handleRemoveRole(roleId)}
                      aria-label={p.removeRole.replace('{role}', roleId)}
                      title={p.removeRole.replace('{role}', roleId)}
                      className="shrink-0 rounded text-zinc-600 hover:text-rose-400 disabled:opacity-50"
                    >
                      <X className="h-2.5 w-2.5" />
                    </button>
                  )}
                </span>
              ))}
            </div>
          )}
          {rolePickerOpen && (
            <div className="ml-4 max-h-32 overflow-y-auto rounded border border-zinc-800 bg-zinc-900/80 p-1">
              {pickableRoles.length === 0 ? (
                <div className="px-1.5 py-1 text-[10px] text-zinc-600">{p.noRolesAvailable}</div>
              ) : (
                pickableRoles.map((role) => (
                  <button
                    key={role.roleId}
                    type="button"
                    disabled={busyAction === `role:${role.roleId}`}
                    onClick={() => void handleAddRole(role.roleId)}
                    className="flex w-full items-center gap-1.5 rounded px-1.5 py-1 text-left hover:bg-zinc-800 disabled:opacity-50"
                  >
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-[11px] text-zinc-300">{role.roleId}</span>
                      {role.description?.trim() && (
                        <span className="block truncate text-[10px] text-zinc-600">{role.description}</span>
                      )}
                    </span>
                  </button>
                ))
              )}
            </div>
          )}
        </section>
      </div>
    </div>
  );
};

export default SidebarProjectDetail;
