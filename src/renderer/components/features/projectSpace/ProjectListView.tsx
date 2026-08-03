// ============================================================================
// ProjectListView —— 协作空间列表视图（协作空间页 list 档）。
// 数据：projectClient.listProjectsWithActivity(false, true)（spacesOnly——只列显式空间，
// verify-* 噪音与未分类桶天然不出现）。
// 新建入口：「新建空间」Modal，两种来源二选一——a) 选择/输入工作目录走 createSpace；
// b) 从现有未升级项目（排除 proj_unsorted）升级走 promoteToSpace。失败 toast（fail-loud）。
// 编辑：rename / setDescription（均已有 IPC）；删除：deleteProject（后果见确认文案，照实写）。
// ============================================================================

import React, { useCallback, useEffect, useState } from 'react';
import { FolderKanban, Pencil, Trash2 } from 'lucide-react';
import { FOLDER_TRUST_CONFIRM_REQUIRED_PREFIX, UNSORTED_PROJECT_ID, type ProjectWithActivity } from '@shared/contract/project';
import { IPC_DOMAINS } from '@shared/ipc';
import {
  createSpace,
  deleteProject,
  listProjectsWithActivity,
  promoteToSpace,
  renameProject,
  setProjectDescription,
} from '../../../services/projectClient';
import ipcService from '../../../services/ipcService';
import type { FolderTrustEvaluationView } from '../../FolderTrustDialog';
import { FolderTrustDangerList } from '../../FolderTrustDangerList';
import { pickNativeDirectory } from '../../../services/tauriPluginFacade';
import { toast } from '../../../hooks/useToast';
import { deriveProjectActivityStatus, type ProjectActivityStatus } from './projectSpaceData';
import { useI18n } from '../../../hooks/useI18n';
import { formatRelativeTime } from '../../../utils/i18nTime';
import { Badge } from '../../primitives/Badge';
import { SecondaryButton } from '../../primitives/Button';
import { EmptyState } from '../../primitives/EmptyState';
import { IconButton } from '../../primitives/IconButton';
import { Input } from '../../primitives/Input';
import { Modal, ModalFooter } from '../../primitives/Modal';

export interface ProjectListViewProps {
  onSelect: (projectId: string) => void;
}

/** 页头「新建空间」按钮住在 ProjectSpacePage 的 header actions 槽（规范位），经此句柄触发本组件的创建 Modal。 */
export interface ProjectListViewHandle {
  openCreate: () => void;
}

const STATUS_CHIP_CLASS: Record<ProjectActivityStatus, string> = {
  active: 'border-badge-success/30 bg-emerald-500/10 text-badge-success',
  idle: 'border-zinc-700 bg-zinc-800/60 text-zinc-400',
  archived: 'border-badge-warning/30 bg-amber-500/10 text-badge-warning',
};

type CreateSource = 'directory' | 'promote';

export const ProjectListView = React.forwardRef<ProjectListViewHandle, ProjectListViewProps>(({ onSelect }, ref) => {
  const { t } = useI18n();
  const ps = t.projectSpace;
  const [projects, setProjects] = useState<ProjectWithActivity[] | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [editing, setEditing] = useState<ProjectWithActivity | null>(null);
  const [editName, setEditName] = useState('');
  const [editDescription, setEditDescription] = useState('');
  const [editSaving, setEditSaving] = useState(false);
  const [deleting, setDeleting] = useState<ProjectWithActivity | null>(null);
  const [deleteBusy, setDeleteBusy] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);
  const [createName, setCreateName] = useState('');
  const [createDescription, setCreateDescription] = useState('');
  const [createSource, setCreateSource] = useState<CreateSource>('directory');
  const [createWorkspacePath, setCreateWorkspacePath] = useState('');
  const [promoteCandidates, setPromoteCandidates] = useState<ProjectWithActivity[]>([]);
  const [promoteProjectId, setPromoteProjectId] = useState('');
  const [createSaving, setCreateSaving] = useState(false);
  // 创建即信任：目录含危险项时存评估结果，同一 Modal 切确认步（非 null 即确认步）
  const [trustConfirm, setTrustConfirm] = useState<FolderTrustEvaluationView | null>(null);

  const loadList = useCallback(() => {
    listProjectsWithActivity(false, true)
      .then((list) => setProjects(list))
      .catch(() => {
        setProjects([]);
        setLoadFailed(true);
      });
  }, []);

  useEffect(() => {
    loadList();
  }, [loadList]);

  const openEdit = (project: ProjectWithActivity) => {
    setEditing(project);
    setEditName(project.name);
    setEditDescription(project.description ?? '');
  };

  const openCreate = () => {
    setCreateName('');
    setCreateDescription('');
    setCreateSource('directory');
    setCreateWorkspacePath('');
    setPromoteProjectId('');
    setTrustConfirm(null);
    setCreateOpen(true);
    // 升级候选：全部项目里未升级的（排除 proj_unsorted 保留桶）
    listProjectsWithActivity(false, false)
      .then((list) => setPromoteCandidates(
        list.filter((item) => item.id !== UNSORTED_PROJECT_ID && !item.spacePromotedAt),
      ))
      .catch(() => setPromoteCandidates([]));
  };

  React.useImperativeHandle(ref, () => ({ openCreate }));

  const handlePickDirectory = async () => {
    const picked = await pickNativeDirectory({ title: ps.chooseDirectory });
    if (picked) setCreateWorkspacePath(picked);
  };

  // 预检：目录未信任且含危险项 → 同一 Modal 切确认步并拦截提交；预检失败不拦，host 信任门是最终兜底
  const requestTrustConfirmIfNeeded = async (workspacePath: string): Promise<boolean> => {
    try {
      const evaluation = await ipcService.invokeDomain<FolderTrustEvaluationView>(
        IPC_DOMAINS.FOLDER_TRUST,
        'get',
        { workingDirectory: workspacePath },
      );
      if (evaluation && evaluation.state !== 'trusted' && (evaluation.dangerousItems?.length ?? 0) > 0) {
        setTrustConfirm(evaluation);
        return true;
      }
    } catch {
      // 评估失败（如路径不存在）：放行，由 host 侧决定
    }
    return false;
  };

  const handleCreate = async (trustAcknowledged = false) => {
    if (createSaving) return;
    const name = createName.trim();
    if (!name) return;
    if (createSource === 'promote' && !promoteProjectId) return;
    const promoteCandidate = createSource === 'promote'
      ? promoteCandidates.find((item) => item.id === promoteProjectId)
      : undefined;
    const workspacePath = createSource === 'promote'
      ? promoteCandidate?.workspacePath?.trim() ?? ''
      : createWorkspacePath.trim();
    setCreateSaving(true);
    try {
      if (!trustAcknowledged && workspacePath && await requestTrustConfirmIfNeeded(workspacePath)) return;
      if (createSource === 'promote') {
        if (trustAcknowledged) {
          await promoteToSpace(promoteProjectId, { trustAcknowledged: true });
        } else {
          await promoteToSpace(promoteProjectId);
        }
      } else {
        const description = createDescription.trim();
        await createSpace({
          name,
          ...(description ? { description } : {}),
          ...(workspacePath ? { workspacePath } : {}),
          ...(trustAcknowledged ? { trustAcknowledged: true } : {}),
        });
      }
      setCreateOpen(false);
      setTrustConfirm(null);
      loadList();
    } catch (error) {
      // 竞态兜底：host 在提交瞬间发现危险项 → 重新评估并进同一确认步，不 toast 报错
      if (
        error instanceof Error
        && error.message.startsWith(FOLDER_TRUST_CONFIRM_REQUIRED_PREFIX)
        && workspacePath
        && await requestTrustConfirmIfNeeded(workspacePath)
      ) return;
      toast.error(`${ps.createFailed}: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      setCreateSaving(false);
    }
  };

  const handleSaveEdit = async () => {
    if (!editing || editSaving) return;
    const name = editName.trim();
    if (!name) return;
    const description = editDescription.trim();
    setEditSaving(true);
    try {
      if (name !== editing.name) {
        await renameProject(editing.id, name);
      }
      if (description !== (editing.description ?? '')) {
        await setProjectDescription(editing.id, description || null);
      }
      setEditing(null);
      loadList();
    } finally {
      setEditSaving(false);
    }
  };

  const handleConfirmDelete = async () => {
    if (!deleting || deleteBusy) return;
    setDeleteBusy(true);
    try {
      await deleteProject(deleting.id);
      setDeleting(null);
      loadList();
    } finally {
      setDeleteBusy(false);
    }
  };

  const statusLabel = (status: ProjectActivityStatus) => (
    status === 'active' ? ps.statusActive : status === 'archived' ? ps.statusArchived : ps.statusIdle
  );

  let content: React.ReactNode;
  if (projects === null) {
    content = <div className="py-10 text-center text-sm text-zinc-600">{t.common.loading}</div>;
  } else if (projects.length === 0) {
    content = (
      <EmptyState
        variant="panel"
        icon={FolderKanban}
        text={loadFailed ? ps.listLoadFailed : ps.listEmpty}
      />
    );
  } else {
    content = (
      <div className="grid gap-1" data-testid="project-space-list">
        {projects.map((project) => {
          const activityStatus = deriveProjectActivityStatus(project);
          const isUnsorted = project.id === UNSORTED_PROJECT_ID;
          return (
          <div
            key={project.id}
            className="group flex w-full min-w-0 items-center gap-1 rounded-lg transition-colors hover:bg-zinc-800/70"
          >
            <button /* ds-allow:button: 协作空间列表行（图标+名称/描述+右侧元信息左对齐布局），Button primitive 是居中动作按钮形状，变体不适配列表行 */
              type="button"
              onClick={() => onSelect(project.id)}
              data-testid={`project-space-list-item-${project.id}`}
              className="flex min-w-0 flex-1 items-center gap-3 px-3 py-2.5 text-left"
            >
              <FolderKanban className="h-4 w-4 flex-shrink-0 text-zinc-500" />
              <span className="min-w-0 flex-1">
                <span className="flex min-w-0 items-center gap-2">
                  <span className="truncate text-sm text-zinc-200 group-hover:text-zinc-100">{project.name}</span>
                  {project.cloudProjectId ? (
                    <Badge className="border-badge-accent/30 bg-violet-500/10 text-[11px] text-badge-accent" data-testid={`project-space-cloud-badge-${project.id}`}>
                      {ps.cloudBadge}
                    </Badge>
                  ) : null}
                  <Badge className={`text-[11px] ${STATUS_CHIP_CLASS[activityStatus]}`} data-testid={`project-space-status-${project.id}`}>
                    {statusLabel(activityStatus)}
                  </Badge>
                </span>
                {project.description ? (
                  <span className="mt-0.5 block truncate text-xs text-zinc-500">{project.description}</span>
                ) : !isUnsorted ? (
                  <span className="mt-0.5 block truncate text-xs text-zinc-600" data-testid={`project-space-description-placeholder-${project.id}`}>
                    {ps.descriptionPlaceholder}
                  </span>
                ) : null}
              </span>
              <span className="flex flex-shrink-0 items-center gap-3">
                {project.activeTopicCount > 0 && (
                  <Badge className="border-badge-accent/30 bg-violet-500/10 text-[11px] text-badge-accent" data-testid={`project-space-topic-count-${project.id}`}>
                    {ps.activeTopicBadge.replace('{count}', String(project.activeTopicCount))}
                  </Badge>
                )}
                {/* 固定宽右对齐：有无徽标时间列都对齐（爸抓的时间列不齐） */}
                <span className="w-16 text-right text-[11px] text-zinc-600 tabular-nums">
                  {project.lastActivityAt ? formatRelativeTime(t, project.lastActivityAt) : ps.noActivity}
                </span>
              </span>
            </button>
            {/* 动作列固定宽：未分类无按钮也占同宽空位，时间列各行右缘对齐 */}
            {isUnsorted ? (
              <span className="w-[60px] flex-shrink-0" aria-hidden="true" />
            ) : (
              <span className="flex w-[60px] flex-shrink-0 items-center justify-end gap-0.5 pr-2 opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100">
                <IconButton
                  size="sm"
                  variant="ghost"
                  icon={<Pencil className="h-3.5 w-3.5" />}
                  aria-label={ps.editSpace}
                  title={ps.editSpace}
                  data-testid={`project-space-edit-${project.id}`}
                  onClick={() => openEdit(project)}
                />
                <IconButton
                  size="sm"
                  variant="danger"
                  icon={<Trash2 className="h-3.5 w-3.5" />}
                  aria-label={ps.deleteSpace}
                  title={ps.deleteSpace}
                  data-testid={`project-space-delete-${project.id}`}
                  onClick={() => setDeleting(project)}
                />
              </span>
            )}
          </div>
          );
        })}
      </div>
    );
  }

  return (
    <div>
      {content}
      <Modal
        isOpen={createOpen}
        onClose={() => { setCreateOpen(false); setTrustConfirm(null); }}
        title={ps.createTitle}
        size="sm"
        footer={(
          <ModalFooter
            onCancel={() => { setCreateOpen(false); setTrustConfirm(null); }}
            onConfirm={() => { void handleCreate(trustConfirm !== null); }}
            confirmText={ps.createSubmit}
            confirmDisabled={createSaving || !createName.trim() || (createSource === 'promote' && !promoteProjectId)}
          />
        )}
      >
        {trustConfirm ? (
          <div className="grid gap-3" data-testid="project-space-create-trust-confirm">
            <p className="text-sm leading-6 text-zinc-400">{ps.trustConfirmHint}</p>
            <p className="font-mono text-xs text-zinc-100 break-all">{trustConfirm.displayPath}</p>
            <FolderTrustDangerList items={trustConfirm.dangerousItems} />
          </div>
        ) : (
        <div className="grid gap-3" data-testid="project-space-create-modal">
          <label className="grid gap-1.5">
            <span className="text-xs text-zinc-500">{ps.nameLabel}</span>
            <Input
              value={createName}
              onChange={(event) => setCreateName(event.target.value)}
              placeholder={ps.namePlaceholder}
              data-testid="project-space-create-name"
            />
          </label>
          <label className="grid gap-1.5">
            <span className="text-xs text-zinc-500">{ps.descriptionLabel}</span>
            <Input
              value={createDescription}
              onChange={(event) => setCreateDescription(event.target.value)}
              placeholder={ps.descriptionPlaceholder}
              data-testid="project-space-create-description"
            />
          </label>
          <div className="grid gap-1.5">
            <div className="flex gap-3">
              <label className="flex items-center gap-1.5 text-xs text-zinc-400">
                <input
                  type="radio"
                  name="project-space-create-source"
                  checked={createSource === 'directory'}
                  onChange={() => setCreateSource('directory')}
                  data-testid="project-space-create-source-directory"
                />
                {ps.sourceDirectory}
              </label>
              <label className="flex items-center gap-1.5 text-xs text-zinc-400">
                <input
                  type="radio"
                  name="project-space-create-source"
                  checked={createSource === 'promote'}
                  onChange={() => setCreateSource('promote')}
                  data-testid="project-space-create-source-promote"
                />
                {ps.sourcePromote}
              </label>
            </div>
            {createSource === 'directory' ? (
              <div className="flex gap-2">
                <Input
                  value={createWorkspacePath}
                  onChange={(event) => setCreateWorkspacePath(event.target.value)}
                  placeholder={ps.directoryPlaceholder}
                  data-testid="project-space-create-workspace"
                />
                <SecondaryButton
                  size="sm"
                  className="shrink-0"
                  onClick={() => { void handlePickDirectory(); }}
                  data-testid="project-space-create-pick-directory"
                >
                  {ps.chooseDirectory}
                </SecondaryButton>
              </div>
            ) : (
              <label className="grid gap-1.5">
                <span className="text-xs text-zinc-500">{ps.promoteLabel}</span>
                <select
                  value={promoteProjectId}
                  onChange={(event) => setPromoteProjectId(event.target.value)}
                  data-testid="project-space-create-promote-select"
                  className="w-full rounded-lg border border-zinc-700 bg-zinc-800 px-3 py-2 text-sm text-zinc-200 focus:outline-hidden"
                >
                  <option value="">{ps.promotePlaceholder}</option>
                  {promoteCandidates.map((candidate) => (
                    <option key={candidate.id} value={candidate.id}>{candidate.name}</option>
                  ))}
                </select>
                {promoteCandidates.length === 0 && (
                  <span className="text-xs text-zinc-600">{ps.promoteEmpty}</span>
                )}
              </label>
            )}
          </div>
        </div>
        )}
      </Modal>
      <Modal
        isOpen={editing !== null}
        onClose={() => setEditing(null)}
        title={ps.editTitle}
        size="sm"
        footer={(
          <ModalFooter
            onCancel={() => setEditing(null)}
            onConfirm={() => { void handleSaveEdit(); }}
            confirmText={ps.save}
            confirmDisabled={editSaving || !editName.trim()}
          />
        )}
      >
        <div className="grid gap-3" data-testid="project-space-edit-modal">
          <label className="grid gap-1.5">
            <span className="text-xs text-zinc-500">{ps.nameLabel}</span>
            <Input
              value={editName}
              onChange={(event) => setEditName(event.target.value)}
              placeholder={ps.namePlaceholder}
              data-testid="project-space-edit-name"
            />
          </label>
          <label className="grid gap-1.5">
            <span className="text-xs text-zinc-500">{ps.descriptionLabel}</span>
            <Input
              value={editDescription}
              onChange={(event) => setEditDescription(event.target.value)}
              placeholder={ps.descriptionPlaceholder}
              data-testid="project-space-edit-description"
            />
          </label>
        </div>
      </Modal>
      <Modal
        isOpen={deleting !== null}
        onClose={() => setDeleting(null)}
        title={ps.deleteTitle}
        size="sm"
        footer={(
          <ModalFooter
            onCancel={() => setDeleting(null)}
            onConfirm={() => { void handleConfirmDelete(); }}
            confirmText={ps.deleteSpace}
            confirmDisabled={deleteBusy}
            confirmColorClass="bg-red-600 hover:bg-red-500"
          />
        )}
      >
        <p className="text-sm leading-6 text-zinc-400" data-testid="project-space-delete-modal">
          {ps.deleteConfirm.replace('{name}', deleting?.name ?? '')}
        </p>
      </Modal>
    </div>
  );
});
ProjectListView.displayName = 'ProjectListView';
