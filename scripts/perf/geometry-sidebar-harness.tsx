import React from 'react';
import { createRoot } from 'react-dom/client';
import { SidebarSessionList } from '@renderer/components/features/sidebar/SidebarSessionList';
import '@renderer/styles/global.css';

const params = new URLSearchParams(window.location.search);
const theme = params.get('theme') === 'light' ? 'light' : 'dark';
document.documentElement.dataset.theme = theme;
document.documentElement.className = theme;

const noop = () => undefined;

function session(id: string) {
  return {
    id,
    title: id,
    type: 'chat',
    status: 'interrupted',
    projectId: undefined,
    workingDirectory: null,
    createdAt: 1,
    updatedAt: 2,
    messageCount: 1,
    turnCount: 1,
    modelConfig: { provider: 'openai', model: 'gpt-5' },
  };
}

const groups = [{
  key: '__chats__',
  name: 'quick',
  paths: [],
  isUncategorized: true,
  sessions: Array.from({ length: 24 }, (_, index) => session(`session-${String(index + 1).padStart(2, '0')}`)),
  latestActivityAt: 1,
}];

const sessionItemProps = {
  unreadSessionIds: new Set<string>(),
  automationSummariesBySessionId: {},
  currentSessionId: null,
  selectedSessionIds: new Set<string>(),
  pinnedSessionIds: new Set<string>(),
  renamingId: null,
  sessionRuntimes: new Map(),
  backgroundSessionMap: new Map(),
  sessionStates: {},
  hasNeedsInputForSession: () => false,
  searchQuery: '',
  messageSearchHitsBySessionId: {},
  replayEvidenceBySessionId: new Map(),
  reviewItemsBySessionId: {},
  trajectoryQualityBySessionId: {},
  multiSelectMode: false,
  hoveredSession: null,
  renameValue: '',
  renameInputRef: React.createRef<HTMLInputElement>(),
  setHoveredSession: noop,
  setRenameValue: noop,
  handleSelectSession: noop,
  handleContextMenu: noop,
  handleRenameSubmit: noop,
  handleRenameKeyDown: noop,
  handleDoubleClick: noop,
  handleOpenReplayEvidence: noop,
  handleSelectMessageSearchHit: noop,
  handleArchiveSession: noop,
};

const props = {
  groups,
  isLoading: false,
  hasAnySessions: true,
  filteredSessionsEmpty: false,
  messageSearchLoading: false,
  searchQuery: '',
  sessionStatusFilter: 'all',
  activeStatusFilterLabel: '',
  hasSearchFilters: false,
  projectMetaById: {},
  setProjectMetaById: noop,
  expandedWorkspaces: {},
  collapsingWorkspaces: {},
  expandedProjectDetails: {},
  projectDrawerKey: null,
  isCreatingSession: false,
  creatingWorkspaceKey: null,
  setProjectDrawerKey: noop,
  setExpandedProjectDetails: noop,
  handleToggleWorkspaceGroup: noop,
  handleOpenWorkspaceAssets: noop,
  handleNewWorkspaceChat: noop,
  handleOpenProjectArtifactSession: noop,
  handleStartProjectGoal: noop,
  handleSelectSession: noop,
  handleRenameSidebarProject: noop,
  handleSetSidebarProjectStatus: noop,
  handleSetSidebarProjectDescription: noop,
  createWorkspaceChat: noop,
  openWorkspacePreview: noop,
  sessionItemProps,
  cloudBadge: false,
  handleNewChat: noop,
  handleNewIndependentSpace: noop,
};

function SidebarGeometryPage() {
  return (
    <div className="flex h-screen w-[240px] flex-col bg-zinc-950 text-zinc-200">
      <div className="flex min-h-0 flex-1 flex-col overflow-hidden px-[var(--scrollbar-size)]">
        <div className="flex-shrink-0 px-1 pb-2" data-testid="sidebar-capability-zone">
          <div className="rounded-lg px-1.5 py-1.5 text-sm">能力中心</div>
          <div className="rounded-lg px-1.5 py-1.5 text-sm">资料库</div>
          <div className="rounded-lg px-1.5 py-1.5 text-sm">自动化</div>
        </div>
        <SidebarSessionList {...(props as unknown as React.ComponentProps<typeof SidebarSessionList>)} />
        <div className="relative flex-shrink-0 px-1 py-1.5" data-testid="sidebar-account-row">
          <div className="flex w-full items-center gap-2.5 px-1.5 py-2 text-sm">账号</div>
        </div>
      </div>
    </div>
  );
}

createRoot(document.getElementById('root')!).render(<SidebarGeometryPage />);
