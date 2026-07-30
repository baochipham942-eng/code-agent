// ============================================================================
// ProjectSpaceView —— 协作空间（space 视图）。
// 页头：FullScreenPageHeader variant="bar" 紧凑条（面包屑回列表 + 名称 + 状态 chip）——
// 列表/空间两档都用 bar：overlay 的 pt-7 红绿灯让位之外不再叠 page 形态的 pt-5+返回行，
// 顶部留白与能力中心页（inline，pt-4）同一紧凑水平；共享组件不动，其他全屏页不陪葬。
// tab：动态(默认)/任务/资产，本地 useState。任务 tab 直接内嵌 ProjectCollaborationPanel。
// ============================================================================

import React, { useCallback, useEffect, useState } from 'react';
import { FolderKanban, UserPlus } from 'lucide-react';
import type { ProjectDetail } from '@shared/contract/project';
import { FullScreenPageHeader } from '../shared/FullScreenPage';
import { ProjectCollaborationPanel } from '../projectCollaboration/ProjectCollaborationPanel';
import { getProjectDetail, listProjectsWithActivity, promoteToCloudSpace } from '../../../services/projectClient';
import { deriveProjectActivityStatus, type ProjectActivityStatus } from './projectSpaceData';
import { useSessionStore } from '../../../stores/sessionStore';
import { useI18n } from '../../../hooks/useI18n';
import { toast } from '../../../hooks/useToast';
import { Badge } from '../../primitives/Badge';
import { SecondaryButton } from '../../primitives/Button';
import { Modal, ModalFooter } from '../../primitives/Modal';
import { ProjectActivityFeed } from './ProjectActivityFeed';
import { ProjectArtifactsList } from './ProjectArtifactsList';
import { ProjectComposer } from './ProjectComposer';
import { ProjectConfigRail } from './ProjectConfigRail';
import { ProjectMembersCard } from './ProjectMembersCard';
import { ProjectInviteModal } from './ProjectInviteModal';
import { useProjectSpaceInvite } from './useProjectSpaceInvite';

export interface ProjectSpaceViewProps {
  projectId: string;
  onBackToList: () => void;
}

type SpaceTab = 'activity' | 'tasks' | 'assets';

const STATUS_CHIP_CLASS: Record<ProjectActivityStatus, string> = {
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
  // 页头 chip 与列表页同一套活跃度派生（listWithActivity 单 SQL 聚合，取本项目那行）
  const [activityRow, setActivityRow] = useState<{ activeTopicCount: number; lastActivityAt: number | null } | null>(null);
  useEffect(() => {
    let cancelled = false;
    listProjectsWithActivity()
      .then((rows) => {
        if (cancelled) return;
        const row = rows.find((item) => item.id === projectId);
        setActivityRow(row ? { activeTopicCount: row.activeTopicCount, lastActivityAt: row.lastActivityAt } : null);
      })
      .catch(() => undefined);
    return () => { cancelled = true; };
  }, [projectId]);

  const refreshDetail = useCallback(() => {
    getProjectDetail(projectId)
      .then((next) => setDetail(next))
      .catch(() => setDetail(null));
  }, [projectId]);

  useEffect(() => {
    setDetail(null);
    refreshDetail();
  }, [refreshDetail]);

  // 邀请码 Modal：页头「邀请」按钮与右栏成员卡「邀请」入口共用同一实例（别复制两份逻辑）
  const inviteModal = useProjectSpaceInvite();
  // 升级确认弹层（cloudProjectId 为空时页头按钮文案「升级为协同空间」）
  const [promoteConfirmOpen, setPromoteConfirmOpen] = useState(false);
  const [promoteBusy, setPromoteBusy] = useState(false);
  const handlePromoteToCloud = async () => {
    if (promoteBusy) return;
    setPromoteBusy(true);
    try {
      await promoteToCloudSpace(projectId);
      setPromoteConfirmOpen(false);
      toast.success(ps.promoteSuccess);
      refreshDetail();
    } catch (error) {
      // fail-loud：host 返回的 error.message 已是人话，toast 直接展示真因
      toast.error(error instanceof Error ? error.message : String(error));
    } finally {
      setPromoteBusy(false);
    }
  };

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
  const activityStatus = project
    ? deriveProjectActivityStatus({
      status: project.status,
      activeTopicCount: activityRow?.activeTopicCount ?? 0,
      lastActivityAt: activityRow?.lastActivityAt ?? null,
    })
    : null;
  const statusChip = project && activityStatus ? (
    <span className="flex items-center gap-1.5">
      {project.cloudProjectId ? (
        <Badge className="border-violet-500/30 bg-violet-500/10 text-[11px] text-violet-300" data-testid="project-space-header-cloud-badge">
          {ps.cloudBadge}
        </Badge>
      ) : null}
      <Badge className={`text-[11px] ${STATUS_CHIP_CLASS[activityStatus]}`} data-testid="project-space-header-status">
        {activityStatus === 'active' ? ps.statusActive : activityStatus === 'archived' ? ps.statusArchived : ps.statusIdle}
      </Badge>
    </span>
  ) : null;

  const tabs: Array<{ key: SpaceTab; label: string }> = [
    { key: 'activity', label: ps.tabActivity },
    { key: 'tasks', label: ps.tabTasks },
    { key: 'assets', label: ps.tabAssets },
  ];

  return (
    <>
      <FullScreenPageHeader
        variant="bar"
        icon={<FolderKanban className="h-4 w-4 text-violet-300" />}
        title={project?.name ?? projectId}
        description={project?.description || undefined}
        badge={statusChip}
        onClose={onBackToList}
        closeLabel={ps.backToList}
        actions={project ? (
          <SecondaryButton
            size="sm"
            leftIcon={<UserPlus className="h-3.5 w-3.5" />}
            data-testid="project-space-invite-open"
            onClick={() => {
              if (project.cloudProjectId) {
                inviteModal.open(projectId);
              } else {
                setPromoteConfirmOpen(true);
              }
            }}
          >
            {project.cloudProjectId ? ps.invite : ps.promoteToCloud}
          </SecondaryButton>
        ) : undefined}
      />
      {/* min-w-0 + overflow-hidden：窄窗下内容列收缩、行内截断，禁止把页面撑出横向滚动（房规：宽内容在自身容器内滚） */}
      <div className="flex min-h-0 min-w-0 flex-1 overflow-hidden">
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
          <div className="min-h-0 min-w-0 flex-1 overflow-y-auto overflow-x-hidden px-6 py-2">
            {tab === 'activity' && (
              <ProjectActivityFeed
                projectId={projectId}
                onOpenSession={openSession}
                onOpenTopic={openTopic}
                onOpenArtifact={openArtifact}
              />
            )}
            {tab === 'tasks' && <ProjectCollaborationPanel projectId={projectId} embedded />}
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
        <ProjectConfigRail
          projectId={projectId}
          project={project}
          detail={detail}
          onRefreshDetail={refreshDetail}
          // 成员第五卡仅云空间注入（卡位约定：membersContent 为空则不渲染成员卡）
          membersContent={project?.cloudProjectId ? (
            <ProjectMembersCard projectId={projectId} onInvite={() => inviteModal.open(projectId)} />
          ) : undefined}
        />
      </div>
      <ProjectInviteModal state={inviteModal.state} isOpen={inviteModal.isOpen} onClose={inviteModal.close} />
      <Modal
        isOpen={promoteConfirmOpen}
        onClose={() => setPromoteConfirmOpen(false)}
        title={ps.promoteTitle}
        size="sm"
        footer={(
          <ModalFooter
            onCancel={() => setPromoteConfirmOpen(false)}
            onConfirm={() => { void handlePromoteToCloud(); }}
            confirmText={ps.promoteSubmit}
            confirmDisabled={promoteBusy}
          />
        )}
      >
        <p className="text-sm leading-6 text-zinc-400" data-testid="project-space-invite-promote-modal">
          {ps.promoteConfirm}
        </p>
      </Modal>
    </>
  );
};

