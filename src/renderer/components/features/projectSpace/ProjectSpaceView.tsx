// ============================================================================
// ProjectSpaceView —— 项目协作空间（space 视图）。
// 页头：面包屑「项目 / <名称>」（FullScreenPageHeader 的 back 即面包屑回列表）+ 状态 chip。
// tab：动态(默认)/任务/资产，本地 useState。任务 tab 直接内嵌 ProjectCollaborationPanel。
// ============================================================================

import React, { useEffect, useState } from 'react';
import { FolderKanban } from 'lucide-react';
import type { ProjectDetail, ProjectStatus } from '@shared/contract/project';
import { FullScreenPageHeader } from '../shared/FullScreenPage';
import { ProjectCollaborationPanel } from '../projectCollaboration/ProjectCollaborationPanel';
import { getProjectDetail } from '../../../services/projectClient';
import { useSessionStore } from '../../../stores/sessionStore';
import { useI18n } from '../../../hooks/useI18n';
import { Badge } from '../../primitives/Badge';
import { ProjectActivityFeed } from './ProjectActivityFeed';
import { ProjectArtifactsList } from './ProjectArtifactsList';
import { ProjectComposer } from './ProjectComposer';

export interface ProjectSpaceViewProps {
  projectId: string;
  onBackToList: () => void;
}

type SpaceTab = 'activity' | 'tasks' | 'assets';

const STATUS_CHIP_CLASS: Record<ProjectStatus, string> = {
  active: 'border-emerald-500/30 bg-emerald-500/10 text-emerald-300',
  idle: 'border-zinc-700 bg-zinc-800/60 text-zinc-400',
  archived: 'border-amber-500/30 bg-amber-500/10 text-amber-300',
};

export const ProjectSpaceView: React.FC<ProjectSpaceViewProps> = ({ projectId, onBackToList }) => {
  const { t } = useI18n();
  const ps = t.projectSpace;
  const [detail, setDetail] = useState<ProjectDetail | null>(null);
  const [tab, setTab] = useState<SpaceTab>('activity');
  const [highlightArtifactId, setHighlightArtifactId] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setDetail(null);
    getProjectDetail(projectId)
      .then((next) => {
        if (!cancelled) setDetail(next);
      })
      .catch(() => {
        if (!cancelled) setDetail(null);
      });
    return () => {
      cancelled = true;
    };
  }, [projectId]);

  // 跳到源会话：switchSession 内部会 closeSecondaryPages()，本页随二级页一起让位
  const openSession = (sessionId: string) => {
    void useSessionStore.getState().switchSession(sessionId);
  };
  // topic 跳源 = 切任务 tab。ProjectCollaborationPanel 目前没有 initialExpand/选中行 props，
  // 只能切 tab 不带定位（后续面板加选中 prop 再把 entry.id 传下去）。
  const openTopic = (_cardId: string) => {
    setTab('tasks');
  };
  const openArtifact = (artifactId: string) => {
    setHighlightArtifactId(artifactId);
    setTab('assets');
  };

  const project = detail?.project ?? null;
  const statusChip = project ? (
    <Badge className={`text-[11px] ${STATUS_CHIP_CLASS[project.status]}`} data-testid="project-space-header-status">
      {project.status === 'active' ? ps.statusActive : project.status === 'archived' ? ps.statusArchived : ps.statusIdle}
    </Badge>
  ) : null;

  const tabs: Array<{ key: SpaceTab; label: string }> = [
    { key: 'activity', label: ps.tabActivity },
    { key: 'tasks', label: ps.tabTasks },
    { key: 'assets', label: ps.tabAssets },
  ];

  return (
    <>
      <FullScreenPageHeader
        icon={<FolderKanban className="h-4 w-4 text-violet-300" />}
        title={project?.name ?? projectId}
        description={project?.description || undefined}
        badge={statusChip}
        onClose={onBackToList}
        closeLabel={ps.backToList}
      />
      <div className="flex min-h-0 flex-1">
        <div className="flex min-w-0 flex-1 flex-col">
          <nav className="flex shrink-0 items-center gap-1 px-6 pb-2" role="tablist" aria-label={project?.name ?? projectId}>
            {tabs.map(({ key, label }) => (
              <button /* ds-allow:button: 项目空间主导航 pill（role=tab），Button primitive 无 tab 语义变体 */
                key={key}
                type="button"
                role="tab"
                aria-selected={tab === key}
                data-testid={`project-space-tab-${key}`}
                onClick={() => setTab(key)}
                className={`flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-sm transition-colors ${
                  tab === key
                    ? 'bg-zinc-800 text-zinc-100'
                    : 'text-zinc-500 hover:bg-zinc-800/60 hover:text-zinc-300'
                }`}
              >
                {label}
              </button>
            ))}
          </nav>
          <div className="min-h-0 flex-1 overflow-y-auto px-6 py-2">
            {tab === 'activity' && (
              <ProjectActivityFeed
                projectId={projectId}
                onOpenSession={openSession}
                onOpenTopic={openTopic}
                onOpenArtifact={openArtifact}
              />
            )}
            {tab === 'tasks' && <ProjectCollaborationPanel projectId={projectId} />}
            {tab === 'assets' && (
              <ProjectArtifactsList
                projectId={projectId}
                highlightId={highlightArtifactId}
                onOpenSession={openSession}
              />
            )}
          </div>
          <ProjectComposer project={project} />
        </div>
      </div>
    </>
  );
};

export default ProjectSpaceView;
