// @vitest-environment jsdom
import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render } from '@testing-library/react';
import { SidebarProjectGroup } from '../../../src/renderer/components/features/sidebar/SidebarProjectGroup';
import type { SidebarSessionItemSharedProps } from '../../../src/renderer/components/features/sidebar/SidebarSessionItem';
import { useAppStore } from '../../../src/renderer/stores/appStore';
import { useNeoWorkCardStore } from '../../../src/renderer/stores/neoWorkCardStore';
import type { NeoWorkCardDetail, NeoWorkCardStatus } from '../../../src/shared/contract/tag';

const realOpenProjectCollaborationPage = useAppStore.getState().openProjectCollaborationPage;

afterEach(() => {
  cleanup();
  useAppStore.setState({ openProjectCollaborationPage: realOpenProjectCollaborationPage });
  useNeoWorkCardStore.setState({
    detailsById: {},
    loadingConversationIds: {},
    loadingProjectIds: {},
    pendingStatusById: {},
    lastErrorByProjectId: {},
  });
  delete (window as any).domainAPI;
  delete (window as any).codeAgentDomainAPI;
});

function makeDetail(id: string, status: NeoWorkCardStatus, projectId = 'p1'): NeoWorkCardDetail {
  return {
    workCard: {
      id,
      projectId,
      sourceConversationId: 'session-1',
      sourceTurnId: `turn-${id}`,
      requesterUserId: 'user-1',
      title: id,
      status,
      currentRevisionId: `rev-${id}`,
      approvedRevisionId: null,
      createdAt: 100,
      updatedAt: 100,
    },
    currentRevision: {
      id: `rev-${id}`,
      workCardId: id,
      revisionNumber: 1,
      intent: 'plan',
      taskSummary: id,
      readScope: {
        mode: 'current_project',
        projectId,
        conversationIds: ['session-1'],
        messageIds: [],
        artifactIds: [],
        fileGlobs: [],
        memoryEntryIds: [],
        notes: [],
      },
      writeScope: {
        mode: 'none',
        projectId,
        allowedPaths: [],
        canCreateFiles: false,
        canModifyFiles: false,
        canWriteProjectMemory: false,
        externalDestinations: [],
        notes: [],
      },
      modelIntent: { mode: 'inherit_current' },
      memoryPlan: { mode: 'none', entries: [], notes: [] },
      expectedOutputs: [],
      risks: [],
      assumptions: [],
      createdByUserId: 'user-1',
      createdAt: 100,
    },
    approvedRevision: null,
    revisions: [],
    approvals: [],
    deltas: [],
    resultReviews: [],
    memoryCandidates: [],
  };
}

function sharedSessionProps(): SidebarSessionItemSharedProps {
  return {
    unreadSessionIds: new Set(),
    automationSummariesBySessionId: {},
    currentSessionId: null,
    selectedSessionIds: new Set(),
    pinnedSessionIds: new Set(),
    renamingId: null,
    sessionRuntimes: new Map(),
    backgroundTaskMap: new Map(),
    sessionStates: {},
    hasNeedsInputForSession: () => false,
    searchQuery: '',
    messageSearchHitsBySessionId: {},
    replayEvidenceBySessionId: new Map(),
    canOpenSessionReplay: true,
    reviewItemsBySessionId: {},
    trajectoryQualityBySessionId: {},
    multiSelectMode: false,
    hoveredSession: null,
    renameValue: '',
    renameInputRef: { current: null },
    setHoveredSession: vi.fn(),
    setRenameValue: vi.fn(),
    handleSelectSession: vi.fn(),
    handleContextMenu: vi.fn(),
    handleRenameSubmit: vi.fn(),
    handleRenameKeyDown: vi.fn(),
    handleDoubleClick: vi.fn(),
    handleOpenSessionReplay: vi.fn(),
    handleOpenSessionAssets: vi.fn(),
    handleOpenReplayEvidence: vi.fn(),
    handleSelectMessageSearchHit: vi.fn(),
    handleArchiveSession: vi.fn(),
  };
}

describe('SidebarProjectGroup Neo badge', () => {
  // 2026-07-02 林晨拍板：侧栏工作区分组不展示 Neo 徽标（协作面板入口走账号菜单"Neo 协同"）。
  // 即使项目有待审/待看的工作卡，分组头也不渲染徽标。
  it('does not render the Neo collab badge in the project header even when work cards exist', () => {
    const openProjectCollaborationPage = vi.fn();
    useAppStore.setState({ openProjectCollaborationPage });
    const review = makeDetail('review-card', 'needs_review');
    const result = makeDetail('result-card', 'in_result_review');
    useNeoWorkCardStore.setState({
      detailsById: {
        [review.workCard.id]: review,
        [result.workCard.id]: result,
      },
    });
    (window as any).domainAPI = {
      invoke: vi.fn(async () => ({ success: true, data: [] })),
    };

    const { queryByTestId, queryByText } = render(
      <SidebarProjectGroup
        group={{
          key: 'project:p1',
          name: 'code-agent',
          path: '/Users/linchen/Downloads/ai/code-agent',
          paths: ['/Users/linchen/Downloads/ai/code-agent'],
          projectId: 'p1',
          isUncategorized: false,
          sessions: [],
          latestActivityAt: 1700000000000,
        }}
        projectMetaById={{ p1: { name: 'code-agent' } }}
        hasSearchFilters={false}
        expandedWorkspaces={{}}
        collapsingWorkspaces={{}}
        expandedProjectDetails={{}}
        projectDrawerKey={null}
        isCreatingSession={false}
        creatingWorkspaceKey={null}
        setProjectDrawerKey={vi.fn()}
        setExpandedProjectDetails={vi.fn()}
        handleToggleWorkspaceGroup={vi.fn()}
        handleOpenWorkspaceAssets={vi.fn()}
        handleNewWorkspaceChat={vi.fn()}
        handleOpenProjectArtifactSession={vi.fn()}
        handleStartProjectGoal={vi.fn()}
        handleSelectSession={vi.fn()}
        handleRenameSidebarProject={vi.fn()}
        handleSetSidebarProjectStatus={vi.fn()}
        handleSetSidebarProjectDescription={vi.fn()}
        createWorkspaceChat={vi.fn()}
        openWorkspacePreview={vi.fn()}
        buildProjectDrawerSessions={() => []}
        sessionItemProps={sharedSessionProps()}
      />,
    );

    expect(queryByTestId('sidebar-neo-collab-entry')).toBeNull();
    expect(queryByText(/Neo \d/)).toBeNull();
  });
});
