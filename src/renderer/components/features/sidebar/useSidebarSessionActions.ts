import React, { useCallback, type Dispatch, type SetStateAction } from 'react';
import { useAppStore } from '../../../stores/appStore';
import type { CreateSessionOptions, SessionWithMeta } from '../../../stores/sessionStore';
import type { PendingSessionSearchJump } from '../../../stores/sessionUIStore';
import type { Session } from '@shared/contract';
import type { ProjectStatus } from '@shared/contract/project';
import { getSidebarGroupKeyForSession } from '../../../utils/workspaceGrouping';
import { buildSessionAssetsNavigation } from '../../../utils/sessionAssetsNavigation';
import {
  renameProject,
  setProjectDescription,
  setProjectStatus,
  updateProjectGoalStatus,
} from '../../../services/projectClient';
import type { SidebarGroupExpansionView } from '../../../utils/sidebarGroupExpansion';
import type { SidebarMessageSearchHit, SidebarMessageSearchHitGroup } from '../../../utils/sidebarMessageSearch';
import type {
  SidebarProjectArtifactMeta,
  SidebarProjectGoalMeta,
  SidebarProjectMeta,
} from '../../../utils/sidebarProjectSummary';

const SIDEBAR_GROUP_COLLAPSE_DELAY_MS = 160;

export interface UseSidebarSessionActionsParams {
  collapseTimersRef: React.MutableRefObject<Record<string, ReturnType<typeof setTimeout>>>;
  setCollapsingWorkspaces: Dispatch<SetStateAction<Record<string, boolean>>>;
  setWorkspaceExpanded: (workspaceKey: string, expanded: boolean) => void;
  isCreatingSession: boolean;
  creatingWorkspaceKey: string | null;
  setCreatingSessionMode: Dispatch<SetStateAction<'current' | null>>;
  setCreatingWorkspaceKey: Dispatch<SetStateAction<string | null>>;
  createSession: (title?: string, options?: CreateSessionOptions) => Promise<Session | null>;
  clearPlanningState: () => void;
  setWorkingDirectory: (dir: string) => void;
  multiSelectMode: boolean;
  toggleSelection: (sessionId: string) => void;
  searchQuery: string;
  messageSearchHitsBySessionId: Record<string, SidebarMessageSearchHitGroup>;
  setPendingSearchJump: (jump: PendingSessionSearchJump | null) => void;
  currentSessionId: string | null;
  switchSession: (sessionId: string) => Promise<void>;
  unarchiveSession: (sessionId: string) => Promise<void>;
  archiveSession: (sessionId: string) => Promise<void>;
  openWorkspacePreview: (previewItemId?: string | null) => void;
  setProjectMetaById: Dispatch<SetStateAction<Record<string, SidebarProjectMeta>>>;
}

export interface SidebarSessionActions {
  handleToggleWorkspaceGroup: (workspaceKey: string, view: SidebarGroupExpansionView) => void;
  handleNewChat: () => Promise<void>;
  createWorkspaceChat: (workspaceKey: string, workingDirectory?: string) => Promise<void>;
  handleNewWorkspaceChat: (e: React.MouseEvent, workspaceKey: string, workingDirectory?: string) => Promise<void>;
  handleSelectSession: (sessionId: string) => Promise<void>;
  handleArchiveSession: (id: string, isArchived: boolean, e: React.MouseEvent) => Promise<void>;
  handleOpenWorkspaceAssets: (e: React.MouseEvent) => void;
  handleOpenSessionAssets: (e: React.MouseEvent, session: SessionWithMeta) => Promise<void>;
  handleOpenProjectArtifactSession: (artifact: SidebarProjectArtifactMeta) => Promise<void>;
  handleStartProjectGoal: (goal: SidebarProjectGoalMeta, workspaceKey: string, workingDirectory?: string) => Promise<void>;
  handleRenameSidebarProject: (projectId: string, name: string) => Promise<void>;
  handleSetSidebarProjectStatus: (projectId: string, status: ProjectStatus) => Promise<void>;
  handleSetSidebarProjectDescription: (projectId: string, description: string | null) => Promise<void>;
  handleSelectMessageSearchHit: (e: React.MouseEvent, sessionId: string, hit: SidebarMessageSearchHit) => Promise<void>;
}

/**
 * Sidebar 会话/项目操作 handler 集合：会话新建、选择、归档、产物打开、项目目标启动、
 * 项目改名/状态/描述、消息命中跳转、工作区分组折叠。从 `Sidebar` 巨型组件抽出。
 * useState 仍留在组件，setter 经 params 注入——保持 hook 渲染顺序与原内联实现一致，零行为改动。
 */
export function useSidebarSessionActions(
  params: UseSidebarSessionActionsParams,
): SidebarSessionActions {
  const {
    collapseTimersRef,
    setCollapsingWorkspaces,
    setWorkspaceExpanded,
    isCreatingSession,
    creatingWorkspaceKey,
    setCreatingSessionMode,
    setCreatingWorkspaceKey,
    createSession,
    clearPlanningState,
    setWorkingDirectory,
    multiSelectMode,
    toggleSelection,
    searchQuery,
    messageSearchHitsBySessionId,
    setPendingSearchJump,
    currentSessionId,
    switchSession,
    unarchiveSession,
    archiveSession,
    openWorkspacePreview,
    setProjectMetaById,
  } = params;

  const handleToggleWorkspaceGroup = useCallback((workspaceKey: string, view: SidebarGroupExpansionView) => {
    if (view.forceExpanded) {
      return;
    }

    const existingTimer = collapseTimersRef.current[workspaceKey];
    if (existingTimer) {
      clearTimeout(existingTimer);
      delete collapseTimersRef.current[workspaceKey];
    }

    if (view.isVisibleExpanded) {
      setCollapsingWorkspaces((previous) => ({ ...previous, [workspaceKey]: true }));
      collapseTimersRef.current[workspaceKey] = setTimeout(() => {
        setWorkspaceExpanded(workspaceKey, false);
        setCollapsingWorkspaces((previous) => {
          const next = { ...previous };
          delete next[workspaceKey];
          return next;
        });
        delete collapseTimersRef.current[workspaceKey];
      }, SIDEBAR_GROUP_COLLAPSE_DELAY_MS);
      return;
    }

    setCollapsingWorkspaces((previous) => {
      if (!previous[workspaceKey]) {
        return previous;
      }
      const next = { ...previous };
      delete next[workspaceKey];
      return next;
    });
    setWorkspaceExpanded(workspaceKey, true);
  }, [collapseTimersRef, setCollapsingWorkspaces, setWorkspaceExpanded]);

  // D-11: 顶部「新会话」默认为纯 chat，不继承项目上下文（workingDirectory: null）。
  // 需要项目上下文的会话改由各项目组 header 的 + 按钮（createWorkspaceChat）创建。
  // 原独立「空白」入口已下线。
  const handleNewChat = async () => {
    if (isCreatingSession || creatingWorkspaceKey) {
      return;
    }

    setCreatingSessionMode('current');
    try {
      const session = await createSession('新对话', { workingDirectory: null });
      if (session) {
        setWorkspaceExpanded(getSidebarGroupKeyForSession(session), true);
      }
      clearPlanningState();
    } finally {
      setCreatingSessionMode(null);
    }
  };

  const createWorkspaceChat = useCallback(async (
    workspaceKey: string,
    workingDirectory?: string,
  ) => {
    const directory = workingDirectory?.trim();
    if (!directory || isCreatingSession || creatingWorkspaceKey) {
      return;
    }

    setCreatingWorkspaceKey(workspaceKey);
    try {
      const session = await createSession('新对话', { workingDirectory: directory });
      if (session) {
        setWorkingDirectory(directory);
        setWorkspaceExpanded(workspaceKey, true);
        clearPlanningState();
      }
    } finally {
      setCreatingWorkspaceKey(null);
    }
  }, [
    clearPlanningState,
    createSession,
    creatingWorkspaceKey,
    isCreatingSession,
    setCreatingWorkspaceKey,
    setWorkspaceExpanded,
    setWorkingDirectory,
  ]);

  const handleNewWorkspaceChat = async (
    e: React.MouseEvent,
    workspaceKey: string,
    workingDirectory?: string,
  ) => {
    e.preventDefault();
    e.stopPropagation();
    await createWorkspaceChat(workspaceKey, workingDirectory);
  };

  const handleSelectSession = async (sessionId: string) => {
    if (multiSelectMode) {
      toggleSelection(sessionId);
      return;
    }
    const messageSearchHitGroup = searchQuery.trim() ? messageSearchHitsBySessionId[sessionId] : undefined;
    if (messageSearchHitGroup?.bestHit) {
      setPendingSearchJump({
        sessionId,
        messageId: messageSearchHitGroup.bestHit.messageId,
        messageIndex: messageSearchHitGroup.bestHit.messageIndex,
        turnNumber: messageSearchHitGroup.bestHit.turnNumber,
        matchOffset: messageSearchHitGroup.bestHit.matchOffset,
        query: searchQuery.trim(),
        createdAt: Date.now(),
      });
    }
    if (sessionId !== currentSessionId) {
      await switchSession(sessionId);
    }
  };

  const handleArchiveSession = async (id: string, isArchived: boolean, e: React.MouseEvent) => {
    e.stopPropagation();
    if (isArchived) {
      await unarchiveSession(id);
    } else {
      await archiveSession(id);
    }
  };

  const handleOpenWorkspaceAssets = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    openWorkspacePreview();
  }, [openWorkspacePreview]);

  const handleOpenSessionAssets = useCallback(async (e: React.MouseEvent, session: SessionWithMeta) => {
    e.preventDefault();
    e.stopPropagation();
    const navigation = buildSessionAssetsNavigation(currentSessionId, session.id);
    if (!navigation) {
      return;
    }
    if (navigation.shouldSwitchSession) {
      await switchSession(navigation.targetSessionId);
    }
    openWorkspacePreview();
  }, [currentSessionId, openWorkspacePreview, switchSession]);

  const handleOpenProjectArtifactSession = useCallback(async (artifact: SidebarProjectArtifactMeta) => {
    if (!artifact.sessionId) {
      return;
    }
    const navigation = buildSessionAssetsNavigation(currentSessionId, artifact.sessionId, {
      artifactId: artifact.id,
      messageId: artifact.messageId,
      path: artifact.path,
      previewItemId: artifact.previewItemId,
    });
    if (!navigation) {
      return;
    }
    if (navigation.shouldSwitchSession) {
      await switchSession(navigation.targetSessionId);
    }
    openWorkspacePreview(navigation.workspacePreviewItemId);
  }, [currentSessionId, openWorkspacePreview, switchSession]);

  const handleStartProjectGoal = useCallback(async (
    goal: SidebarProjectGoalMeta,
    workspaceKey: string,
    workingDirectory?: string,
  ) => {
    const directory = workingDirectory?.trim() || null;
    const title = goal.title.length > 42 ? `目标：${goal.title.slice(0, 39)}…` : `目标：${goal.title}`;
    const session = await createSession(title, { workingDirectory: directory });
    if (!session) {
      return;
    }
    useAppStore.getState().setPendingProjectGoalChatSeed({
      sessionId: session.id,
      content: goal.title,
      goal: {
        goal: goal.title,
        verify: goal.verify ?? undefined,
        review: goal.review ?? undefined,
      },
    });
    if (directory) {
      setWorkingDirectory(directory);
    }
    setWorkspaceExpanded(getSidebarGroupKeyForSession(session) || workspaceKey, true);
    await updateProjectGoalStatus(goal.id, goal.status, { lastRunSessionId: session.id });
    setProjectMetaById((previous) => {
      const next = { ...previous };
      for (const [projectId, meta] of Object.entries(next)) {
        if (!meta.goals?.some((item) => item.id === goal.id)) continue;
        next[projectId] = {
          ...meta,
          goals: meta.goals.map((item) =>
            item.id === goal.id
              ? { ...item, lastRunSessionId: session.id }
              : item
          ),
        };
      }
      return next;
    });
    clearPlanningState();
  }, [clearPlanningState, createSession, setProjectMetaById, setWorkspaceExpanded, setWorkingDirectory]);

  const handleRenameSidebarProject = useCallback(async (projectId: string, name: string) => {
    const updated = await renameProject(projectId, name);
    setProjectMetaById((previous) => {
      const current = previous[projectId];
      if (!current) {
        return previous;
      }
      return {
        ...previous,
        [projectId]: {
          ...current,
          name: updated.name,
          status: updated.status,
          description: updated.description,
          updatedAt: updated.updatedAt,
        },
      };
    });
  }, [setProjectMetaById]);

  const handleSetSidebarProjectStatus = useCallback(async (projectId: string, status: ProjectStatus) => {
    const updated = await setProjectStatus(projectId, status);
    setProjectMetaById((previous) => {
      const current = previous[projectId];
      if (!current) {
        return previous;
      }
      return {
        ...previous,
        [projectId]: {
          ...current,
          name: updated.name,
          status: updated.status,
          description: updated.description,
          updatedAt: updated.updatedAt,
        },
      };
    });
  }, [setProjectMetaById]);

  const handleSetSidebarProjectDescription = useCallback(async (
    projectId: string,
    description: string | null,
  ) => {
    const updated = await setProjectDescription(projectId, description);
    setProjectMetaById((previous) => {
      const current = previous[projectId];
      if (!current) {
        return previous;
      }
      return {
        ...previous,
        [projectId]: {
          ...current,
          name: updated.name,
          status: updated.status,
          description: updated.description,
          updatedAt: updated.updatedAt,
        },
      };
    });
  }, [setProjectMetaById]);

  const handleSelectMessageSearchHit = useCallback(async (
    e: React.MouseEvent,
    sessionId: string,
    hit: SidebarMessageSearchHit,
  ) => {
    e.preventDefault();
    e.stopPropagation();
    setPendingSearchJump({
      sessionId,
      messageId: hit.messageId,
      messageIndex: hit.messageIndex,
      turnNumber: hit.turnNumber,
      matchOffset: hit.matchOffset,
      query: searchQuery.trim(),
      createdAt: Date.now(),
    });
    if (sessionId !== currentSessionId) {
      await switchSession(sessionId);
    }
  }, [currentSessionId, searchQuery, setPendingSearchJump, switchSession]);

  return {
    handleToggleWorkspaceGroup,
    handleNewChat,
    createWorkspaceChat,
    handleNewWorkspaceChat,
    handleSelectSession,
    handleArchiveSession,
    handleOpenWorkspaceAssets,
    handleOpenSessionAssets,
    handleOpenProjectArtifactSession,
    handleStartProjectGoal,
    handleRenameSidebarProject,
    handleSetSidebarProjectStatus,
    handleSetSidebarProjectDescription,
    handleSelectMessageSearchHit,
  };
}
