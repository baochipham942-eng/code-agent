// ============================================================================
// ProjectListView —— 项目列表视图（项目空间页 list 档）。
// 数据：projectClient.listProjectsWithActivity()（名称/描述/状态/活跃 topic 数/最近活动）。
// proj_unsorted 是保留桶（无 workspace 存量会话归桶处），照实渲染不排除。
// 新建项目入口刻意不做：无 create IPC，项目靠 ensureProjectForWorkspace 隐式创建。
// ============================================================================

import React, { useEffect, useState } from 'react';
import { FolderKanban } from 'lucide-react';
import type { ProjectStatus, ProjectWithActivity } from '@shared/contract/project';
import { listProjectsWithActivity } from '../../../services/projectClient';
import { useI18n } from '../../../hooks/useI18n';
import { formatRelativeTime } from '../../../utils/i18nTime';
import { Badge } from '../../primitives/Badge';
import { EmptyState } from '../../primitives/EmptyState';

export interface ProjectListViewProps {
  onSelect: (projectId: string) => void;
}

const STATUS_CHIP_CLASS: Record<ProjectStatus, string> = {
  active: 'border-emerald-500/30 bg-emerald-500/10 text-emerald-300',
  idle: 'border-zinc-700 bg-zinc-800/60 text-zinc-400',
  archived: 'border-amber-500/30 bg-amber-500/10 text-amber-300',
};

export const ProjectListView: React.FC<ProjectListViewProps> = ({ onSelect }) => {
  const { t } = useI18n();
  const ps = t.projectSpace;
  const [projects, setProjects] = useState<ProjectWithActivity[] | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    listProjectsWithActivity()
      .then((list) => {
        if (!cancelled) setProjects(list);
      })
      .catch(() => {
        if (!cancelled) {
          setProjects([]);
          setLoadFailed(true);
        }
      });
    return () => {
      cancelled = true;
    };
  }, []);

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

  const statusLabel = (status: ProjectStatus) => (
    status === 'active' ? ps.statusActive : status === 'archived' ? ps.statusArchived : ps.statusIdle
  );

  return (
    <div className="grid gap-1" data-testid="project-space-list">
      {projects.map((project) => (
        <button /* ds-allow:button: 项目列表行（图标+名称/描述+右侧元信息左对齐布局），Button primitive 是居中动作按钮形状，变体不适配列表行 */
          key={project.id}
          type="button"
          onClick={() => onSelect(project.id)}
          data-testid={`project-space-list-item-${project.id}`}
          className="group flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-left transition-colors hover:bg-zinc-800/70"
        >
          <FolderKanban className="h-4 w-4 flex-shrink-0 text-zinc-500" />
          <span className="min-w-0 flex-1">
            <span className="flex min-w-0 items-center gap-2">
              <span className="truncate text-sm text-zinc-200 group-hover:text-zinc-100">{project.name}</span>
              <Badge className={`text-[11px] ${STATUS_CHIP_CLASS[project.status]}`} data-testid={`project-space-status-${project.id}`}>
                {statusLabel(project.status)}
              </Badge>
            </span>
            {project.description ? (
              <span className="mt-0.5 block truncate text-xs text-zinc-500">{project.description}</span>
            ) : null}
          </span>
          <span className="flex flex-shrink-0 items-center gap-3">
            {project.activeTopicCount > 0 && (
              <Badge className="border-violet-500/30 bg-violet-500/10 text-[11px] text-violet-300" data-testid={`project-space-topic-count-${project.id}`}>
                {ps.activeTopicBadge.replace('{count}', String(project.activeTopicCount))}
              </Badge>
            )}
            <span className="text-[11px] text-zinc-600 tabular-nums">
              {project.lastActivityAt ? formatRelativeTime(t, project.lastActivityAt) : ps.noActivity}
            </span>
          </span>
        </button>
      ))}
    </div>
  );
};

export default ProjectListView;
