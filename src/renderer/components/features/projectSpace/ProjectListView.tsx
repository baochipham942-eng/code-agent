// ============================================================================
// ProjectListView —— 协作空间列表视图（协作空间页 list 档）。
// 数据：projectClient.listProjectsWithActivity()（名称/描述/状态/活跃 topic 数/最近活动）。
// proj_unsorted 是保留桶（无 workspace 存量会话归桶处），照实渲染但不给编辑/删除。
// 新建入口刻意不做：无 create IPC，空间靠 ensureProjectForWorkspace 隐式创建。
// 编辑：rename / setDescription（均已有 IPC）；删除：deleteProject（后果见确认文案，照实写）。
// ============================================================================

import React, { useCallback, useEffect, useState } from 'react';
import { FolderKanban, Pencil, Trash2 } from 'lucide-react';
import { UNSORTED_PROJECT_ID, type ProjectWithActivity } from '@shared/contract/project';
import { deleteProject, listProjectsWithActivity, renameProject, setProjectDescription } from '../../../services/projectClient';
import { deriveProjectActivityStatus, type ProjectActivityStatus } from './projectSpaceData';
import { useI18n } from '../../../hooks/useI18n';
import { formatRelativeTime } from '../../../utils/i18nTime';
import { Badge } from '../../primitives/Badge';
import { EmptyState } from '../../primitives/EmptyState';
import { IconButton } from '../../primitives/IconButton';
import { Input } from '../../primitives/Input';
import { Modal, ModalFooter } from '../../primitives/Modal';

export interface ProjectListViewProps {
  onSelect: (projectId: string) => void;
}

const STATUS_CHIP_CLASS: Record<ProjectActivityStatus, string> = {
  active: 'border-emerald-500/30 bg-emerald-500/10 text-emerald-300',
  idle: 'border-zinc-700 bg-zinc-800/60 text-zinc-400',
  archived: 'border-amber-500/30 bg-amber-500/10 text-amber-300',
};

export const ProjectListView: React.FC<ProjectListViewProps> = ({ onSelect }) => {
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

  const loadList = useCallback(() => {
    listProjectsWithActivity()
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

  if (projects === null) {
    return <div className="py-10 text-center text-sm text-zinc-600">{t.common.loading}</div>;
  }

  if (projects.length === 0) {
    return (
      <EmptyState
        variant="panel"
        icon={FolderKanban}
        text={loadFailed ? ps.listLoadFailed : ps.listEmpty}
      />
    );
  }

  const statusLabel = (status: ProjectActivityStatus) => (
    status === 'active' ? ps.statusActive : status === 'archived' ? ps.statusArchived : ps.statusIdle
  );

  return (
    <div className="grid gap-1" data-testid="project-space-list">
      {projects.map((project) => {
        const activityStatus = deriveProjectActivityStatus(project);
        const isUnsorted = project.id === UNSORTED_PROJECT_ID;
        return (
        <div
          key={project.id}
          className="group flex w-full items-center gap-1 rounded-lg transition-colors hover:bg-zinc-800/70"
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
                <Badge className="border-violet-500/30 bg-violet-500/10 text-[11px] text-violet-300" data-testid={`project-space-topic-count-${project.id}`}>
                  {ps.activeTopicBadge.replace('{count}', String(project.activeTopicCount))}
                </Badge>
              )}
              {/* 固定宽右对齐：有无徽标时间列都对齐（爸抓的时间列不齐） */}
              <span className="w-16 text-right text-[11px] text-zinc-600 tabular-nums">
                {project.lastActivityAt ? formatRelativeTime(t, project.lastActivityAt) : ps.noActivity}
              </span>
            </span>
          </button>
          {!isUnsorted && (
            <span className="flex flex-shrink-0 items-center gap-0.5 pr-2 opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100">
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
};
