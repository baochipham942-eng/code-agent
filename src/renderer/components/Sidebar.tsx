// ============================================================================
// Sidebar - Linear-style session list with grouped cards and session management
// ============================================================================

import React, { useEffect, useState, useMemo, useRef, useCallback } from 'react';
import { useSessionStore, initializeSessionStore, type SessionWithMeta } from '../stores/sessionStore';
import { useSelectionStore } from '../stores/selectionStore';
import { useSessionUIStore, type SessionFilter } from '../stores/sessionUIStore';
import { useAppStore } from '../stores/appStore';
import { useComposerStore } from '../stores/composerStore';
import { useAuthStore } from '../stores/authStore';
import { useTaskStore } from '../stores/taskStore';
import {
  MessageSquare,
  Plus,
  Archive,
  ArchiveRestore,
  Loader2,
  User,
  Settings,
  LogIn,
  LogOut,
  ChevronDown,
  CheckSquare,
  Square,
  Trash2,
  Pin,
  Search,
  X,
  FolderOpen,
} from 'lucide-react';
import { IPC_CHANNELS, IPC_DOMAINS } from '@shared/ipc';
import { IconButton, UndoToast } from './primitives';
import { createLogger } from '../utils/logger';
import { groupSessions } from '../utils/dateGrouping';
import { SessionContextMenu, type ContextMenuItem } from './features/sidebar/SessionContextMenu';
import ipcService from '../services/ipcService';
import { buildSessionSearchText, getSessionStatusPresentation } from '../utils/sessionPresentation';

const logger = createLogger('Sidebar');

// 获取相对时间
function getRelativeTime(timestamp: number, compact = false): string {
  if (!timestamp || !Number.isFinite(timestamp)) return '';
  const now = Date.now();
  const diff = now - timestamp;
  if (!Number.isFinite(diff) || diff < 0) return '';
  const minutes = Math.floor(diff / (1000 * 60));
  const hours = Math.floor(diff / (1000 * 60 * 60));
  const days = Math.floor(diff / (1000 * 60 * 60 * 24));

  if (compact) {
    if (minutes < 1) return '刚刚';
    if (minutes < 60) return `${minutes}m`;
    if (hours < 24) return `${hours}h`;
    if (days < 7) return `${days}d`;
    if (days < 30) return `${Math.floor(days / 7)}w`;
    return `${Math.floor(days / 30)}mo`;
  }

  if (minutes < 1) return '刚刚';
  if (minutes < 60) return `${minutes}分钟前`;
  if (hours < 24) return `${hours}小时前`;
  if (days < 7) return `${days}天前`;
  if (days < 30) return `${Math.floor(days / 7)}周前`;
  return `${Math.floor(days / 30)}月前`;
}

function getReusableWorkbenchDirectory(session: SessionWithMeta): string | null {
  const candidates = [
    session.workbenchProvenance?.workingDirectory,
    session.workingDirectory,
  ];

  for (const candidate of candidates) {
    const trimmed = candidate?.trim();
    if (trimmed) {
      return trimmed;
    }
  }

  return null;
}

function canReuseSessionWorkbench(session: SessionWithMeta): boolean {
  const hasWorkspace = Boolean(getReusableWorkbenchDirectory(session));
  const hasRouting =
    (session.workbenchProvenance?.routingMode === 'direct' &&
      (session.workbenchProvenance?.targetAgentIds?.length ?? 0) > 0) ||
    Boolean(
      (session.workbenchProvenance?.routingMode &&
        session.workbenchProvenance.routingMode !== 'direct') ||
      (session.workbenchSnapshot?.routingMode && session.workbenchSnapshot.routingMode !== 'direct'),
    );
  const hasBrowserSession = Boolean(session.workbenchProvenance?.executionIntent?.browserSessionMode);
  const hasCapabilities = Boolean(
    session.workbenchProvenance?.selectedSkillIds?.length ||
      session.workbenchProvenance?.selectedConnectorIds?.length ||
      session.workbenchProvenance?.selectedMcpServerIds?.length ||
      session.workbenchSnapshot?.skillIds?.length ||
      session.workbenchSnapshot?.connectorIds?.length ||
      session.workbenchSnapshot?.mcpServerIds?.length,
  );

  return hasWorkspace || hasRouting || hasBrowserSession || hasCapabilities;
}

export const Sidebar: React.FC = () => {
  const { clearPlanningState, setShowSettings, setShowEvalCenter, setWorkingDirectory } = useAppStore();
  const applySessionWorkbenchPreset = useComposerStore((state) => state.applySessionWorkbenchPreset);
  const {
    sessions,
    currentSessionId,
    isLoading,
    createSession,
    switchSession,
    archiveSession,
    unarchiveSession,
    unreadSessionIds,
    sessionRuntimes,
    backgroundTasks,
    renameSession,
  } = useSessionStore();

  const {
    pinnedSessionIds,
    togglePin,
    multiSelectMode,
    toggleMultiSelect,
    selectedSessionIds,
    toggleSelection,
    clearSelection,
    batchDelete,
  } = useSelectionStore();

  const {
    filter,
    setFilter,
    searchQuery,
    setSearchQuery,
    sessionStatusFilter,
    setSessionStatusFilter,
    softDelete,
    undoDelete,
    pendingDelete,
  } = useSessionUIStore();

  const { user, isAuthenticated, setShowAuthModal, signOut } = useAuthStore();
  const sessionStates = useTaskStore((state) => state.sessionStates);

  const [hoveredSession, setHoveredSession] = useState<string | null>(null);
  const [appVersion, setAppVersion] = useState<string>('');
  const [showUserMenu, setShowUserMenu] = useState(false);
  const [isCreatingSession, setIsCreatingSession] = useState(false);
  const accountMenuRef = useRef<HTMLDivElement>(null);

  // 右键菜单状态
  const [contextMenu, setContextMenu] = useState<{
    x: number;
    y: number;
    session: SessionWithMeta;
  } | null>(null);

  // 内联重命名状态
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState('');
  const renameInputRef = useRef<HTMLInputElement>(null);

  // 初始化：加载会话列表
  useEffect(() => {
    initializeSessionStore();
  }, []);

  // 获取应用版本号
  useEffect(() => {
    const loadVersion = async () => {
      try {
        const version = await ipcService.invoke(IPC_CHANNELS.APP_GET_VERSION);
        if (version) {
          setAppVersion(version);
        }
      } catch (error) {
        logger.error('Failed to get app version', error);
      }
    };
    loadVersion();
  }, []);

  // 重命名 input 聚焦
  useEffect(() => {
    if (renamingId && renameInputRef.current) {
      renameInputRef.current.focus();
      renameInputRef.current.select();
    }
  }, [renamingId]);

  const backgroundTaskMap = useMemo(
    () => new Map(backgroundTasks.map((task) => [task.sessionId, task])),
    [backgroundTasks],
  );

  // Apply local search + minimal session-native status filter
  const filteredSessions = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    return sessions.filter((session) => {
      const status = getSessionStatusPresentation({
        backgroundTask: backgroundTaskMap.get(session.id),
        runtime: sessionRuntimes.get(session.id),
        taskState: sessionStates[session.id],
      });
      if (sessionStatusFilter === 'background' && status.kind !== 'background') {
        return false;
      }

      if (!q) {
        return true;
      }

      return buildSessionSearchText({
        session,
        snapshot: session.workbenchSnapshot,
        status,
      }).includes(q);
    });
  }, [backgroundTaskMap, searchQuery, sessionRuntimes, sessionStatusFilter, sessions, sessionStates]);

  // Group sessions by project (workingDirectory), then by date within each project
  const projectGroupedSessions = useMemo(() => {
    // Extract project name from workingDirectory (last path segment)
    const getProjectName = (dir?: string): string => {
      if (!dir) return '未分类';
      const segments = dir.replace(/\/+$/, '').split('/');
      return segments[segments.length - 1] || '未分类';
    };

    // Group by project
    const projectMap = new Map<string, SessionWithMeta[]>();
    for (const session of filteredSessions) {
      const project = getProjectName(session.workingDirectory);
      const existing = projectMap.get(project);
      if (existing) {
        existing.push(session);
      } else {
        projectMap.set(project, [session]);
      }
    }

    // Sort projects: most recently updated first
    const sorted = Array.from(projectMap.entries()).sort((a, b) => {
      const aMax = Math.max(...a[1].map((s) => s.updatedAt));
      const bMax = Math.max(...b[1].map((s) => s.updatedAt));
      return bMax - aMax;
    });

    // Within each project, group by date
    return sorted.map(([project, projectSessions]) => ({
      project,
      dateGroups: groupSessions(projectSessions, pinnedSessionIds),
    }));
  }, [filteredSessions, pinnedSessionIds]);

  // 按日期分组 (used when search is active — flat list)
  const groupedSessions = useMemo(() => {
    return groupSessions(filteredSessions, pinnedSessionIds);
  }, [filteredSessions, pinnedSessionIds]);

  const handleNewChat = async () => {
    if (isCreatingSession) {
      return;
    }

    setIsCreatingSession(true);
    try {
      await createSession('新对话');
      clearPlanningState();
    } finally {
      setIsCreatingSession(false);
    }
  };

  const handleSelectSession = async (sessionId: string) => {
    if (multiSelectMode) {
      toggleSelection(sessionId);
      return;
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

  // 右键菜单
  const handleContextMenu = useCallback((e: React.MouseEvent, session: SessionWithMeta) => {
    e.preventDefault();
    e.stopPropagation();
    setContextMenu({ x: e.clientX, y: e.clientY, session });
  }, []);

  const getContextMenuItems = useCallback((session: SessionWithMeta): ContextMenuItem[] => {
    const isPinned = pinnedSessionIds.has(session.id);
    const isArchived = !!session.isArchived;
    const reusableWorkbenchDirectory = getReusableWorkbenchDirectory(session);
    const reusableWorkbench = canReuseSessionWorkbench(session);

    return [
      {
        label: isPinned ? '取消置顶' : '置顶',
        icon: '📌',
        onClick: () => togglePin(session.id),
      },
      {
        label: '重命名',
        icon: '✏️',
        onClick: () => {
          setRenamingId(session.id);
          setRenameValue(session.title);
        },
      },
      {
        label: isArchived ? '取消归档' : '归档',
        icon: '📦',
        onClick: () => {
          if (isArchived) {
            unarchiveSession(session.id);
          } else {
            archiveSession(session.id);
          }
        },
      },
      {
        label: '删除',
        icon: '🗑',
        onClick: () => softDelete([session.id]),
        danger: true,
      },
      {
        label: '加入 Review',
        icon: '📋',
        onClick: async () => {
          try {
            await ipcService.invoke(IPC_CHANNELS.EVALUATION_REVIEW_QUEUE_ENQUEUE, {
              sessionId: session.id,
              sessionTitle: session.title,
              reason: 'manual_review',
              source: 'session_list',
            });
          } catch (error) {
            logger.error('Failed to enqueue session review', error);
          }
        },
      },
      {
        label: '打开 Replay',
        icon: '👁️',
        onClick: () => {
          setShowEvalCenter(true, undefined, session.id);
        },
      },
      {
        label: '在当前会话复用工作台',
        icon: '🧰',
        disabled: !reusableWorkbench,
        onClick: async () => {
          try {
            if (reusableWorkbenchDirectory) {
              const response = await window.domainAPI?.invoke<string | null>(
                IPC_DOMAINS.WORKSPACE,
                'setCurrent',
                { dir: reusableWorkbenchDirectory },
              );
              if (response && !response.success) {
                throw new Error(response.error?.message || 'Failed to sync workbench directory');
              }
              setWorkingDirectory(response?.data || reusableWorkbenchDirectory);
            }

            applySessionWorkbenchPreset(session);
          } catch (error) {
            logger.error('Failed to reuse session workbench preset', error);
          }
        },
      },
      {
        label: '导出 Markdown',
        icon: '📝',
        onClick: async () => {
          try {
            const response = await window.domainAPI?.invoke<{ markdown: string; suggestedFileName: string }>(
              IPC_DOMAINS.SESSION,
              'exportMarkdown',
              { sessionId: session.id },
            );
            if (!response?.success || !response.data?.markdown) {
              throw new Error(response?.error?.message || 'Failed to export markdown');
            }
            const blob = new Blob([response.data.markdown], { type: 'text/markdown;charset=utf-8' });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = response.data.suggestedFileName || `session-${session.id}.md`;
            a.click();
            URL.revokeObjectURL(url);
          } catch (error) {
            logger.error('Failed to export session markdown', error);
          }
        },
      },
      {
        label: '导出 JSON',
        icon: '📤',
        onClick: async () => {
          try {
            const response = await window.domainAPI?.invoke(IPC_DOMAINS.SESSION, 'export', {
              sessionId: session.id,
            });
            if (!response?.success) {
              throw new Error(response?.error?.message || 'Failed to export session');
            }
            const data = response.data;
            if (data) {
              const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
              const url = URL.createObjectURL(blob);
              const a = document.createElement('a');
              a.href = url;
              a.download = `session-${session.title || session.id}.json`;
              a.click();
              URL.revokeObjectURL(url);
            }
          } catch (error) {
            logger.error('Failed to export session', error);
          }
        },
      },
    ];
  }, [
    applySessionWorkbenchPreset,
    archiveSession,
    pinnedSessionIds,
    setShowEvalCenter,
    setWorkingDirectory,
    softDelete,
    togglePin,
    unarchiveSession,
  ]);

  // 双击开始重命名
  const handleDoubleClick = useCallback((e: React.MouseEvent, session: SessionWithMeta) => {
    e.preventDefault();
    e.stopPropagation();
    setRenamingId(session.id);
    setRenameValue(session.title);
  }, []);

  // 提交重命名
  const handleRenameSubmit = useCallback(() => {
    if (renamingId && renameValue.trim()) {
      renameSession(renamingId, renameValue.trim());
    }
    setRenamingId(null);
    setRenameValue('');
  }, [renamingId, renameValue, renameSession]);

  // 重命名按键
  const handleRenameKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      handleRenameSubmit();
    } else if (e.key === 'Escape') {
      setRenamingId(null);
      setRenameValue('');
    }
  }, [handleRenameSubmit]);

  // 过滤器显示文本
  const filterLabels: Record<SessionFilter, string> = {
    active: '进行中',
    archived: '已归档',
    all: '全部',
  };

  // 循环切换过滤器
  const cycleFilter = () => {
    const filters: SessionFilter[] = ['active', 'archived'];
    const currentIndex = filters.indexOf(filter);
    const nextIndex = (currentIndex + 1) % filters.length;
    setFilter(filters[nextIndex]);
  };

  const hasAnySessions = sessions.length > 0;
  const hasSearchFilters = Boolean(searchQuery.trim()) || sessionStatusFilter !== 'all';
  const isBackgroundOnly = sessionStatusFilter === 'background';

  // 渲染单个会话项
  const renderSessionItem = (session: SessionWithMeta) => {
    const isUnread = unreadSessionIds.has(session.id);
    const isSelected = currentSessionId === session.id;
    const isChecked = selectedSessionIds.has(session.id);
    const isPinned = pinnedSessionIds.has(session.id);
    const isRenaming = renamingId === session.id;
    const sessionRuntime = sessionRuntimes.get(session.id);
    const backgroundTask = backgroundTaskMap.get(session.id);
    const status = getSessionStatusPresentation({
      backgroundTask,
      runtime: sessionRuntime,
      taskState: sessionStates[session.id],
    });
    const latestActivityAt = Math.max(
      session.updatedAt || 0,
      sessionRuntime?.lastActivityAt || 0,
      backgroundTask?.backgroundedAt || 0,
    );
    const snapshotSummary = session.workbenchSnapshot?.summary || '纯对话';

    return (
      <div
        key={session.id}
        onClick={() => handleSelectSession(session.id)}
        onContextMenu={(e) => handleContextMenu(e, session)}
        onMouseEnter={() => setHoveredSession(session.id)}
        onMouseLeave={() => setHoveredSession(null)}
        className={`group relative px-3 py-2 rounded-lg cursor-pointer transition-all duration-150 ${
          isSelected && !multiSelectMode
            ? 'bg-zinc-700/60'
            : isChecked
              ? 'bg-blue-500/10 border border-blue-500/20'
              : 'hover:bg-zinc-800'
        }`}
      >
        {/* 多选模式：Checkbox */}
        {multiSelectMode && (
          <div className="flex items-center mb-1">
            {isChecked ? (
              <CheckSquare className="w-4 h-4 text-blue-400" />
            ) : (
              <Square className="w-4 h-4 text-zinc-500" />
            )}
          </div>
        )}

        {/* Line 1: status indicators + title */}
        <div className="flex items-center gap-2">
          {/* 置顶图标 */}
          {isPinned && !multiSelectMode && (
            <Pin className="w-3 h-3 text-amber-500 shrink-0 -rotate-45" />
          )}

          {/* 标题：重命名模式 vs 普通 */}
          {isRenaming ? (
            <input
              ref={renameInputRef}
              value={renameValue}
              onChange={(e) => setRenameValue(e.target.value)}
              onBlur={handleRenameSubmit}
              onKeyDown={handleRenameKeyDown}
              onClick={(e) => e.stopPropagation()}
              className="flex-1 text-sm bg-zinc-600/80 text-zinc-200 px-1.5 py-0.5 rounded border border-zinc-600 focus:border-blue-500 focus:outline-none"
            />
          ) : (
            <span
              onDoubleClick={(e) => handleDoubleClick(e, session)}
              className={`text-sm truncate font-medium flex-1 ${
                isSelected ? 'text-zinc-100' : 'text-zinc-400'
              }`}
            >
              {session.title || '未命名会话'}
            </span>
          )}

          {!multiSelectMode && !isRenaming && (
            <span className={`shrink-0 rounded-full border px-1.5 py-0.5 text-[10px] font-medium ${status.toneClassName}`}>
              {status.label}
            </span>
          )}
        </div>

        {/* Line 2: turn count + recent activity */}
        {!isRenaming && (
          <div className="mt-1 flex items-center gap-1.5 text-[11px] text-zinc-600">
            <span className="truncate flex-1">
              {session.turnCount > 0 ? `${session.turnCount} 轮` : '0 轮'}
            </span>
            <span className="text-[10px] text-zinc-600 shrink-0">
              {getRelativeTime(latestActivityAt, true)}
            </span>
          </div>
        )}

        {/* Line 3: workbench snapshot */}
        {!isRenaming && (
          <div className="mt-0.5 truncate text-[11px] text-zinc-500">
            {snapshotSummary}
          </div>
        )}

        {/* Line 4: selected session extras */}
        {isSelected && !isRenaming && (
          <div className="flex items-center gap-1.5 mt-0.5">
            {session.turnCount > 0 && (
              <span className="text-[10px] text-zinc-600 bg-zinc-800 rounded px-1">{session.turnCount} 轮</span>
            )}
            {session.modelConfig?.model && (
              <span className="text-[10px] text-zinc-600 bg-zinc-800 rounded px-1 truncate">
                {session.modelConfig.model}
              </span>
            )}
          </div>
        )}

        {/* Hover actions — absolute positioned top-right */}
        {hoveredSession === session.id && !multiSelectMode && !isRenaming && (
          <div className="absolute top-1.5 right-2 flex items-center gap-0.5">
            <IconButton
              icon={session.isArchived ? <ArchiveRestore className="w-3.5 h-3.5" /> : <Archive className="w-3.5 h-3.5" />}
              aria-label={session.isArchived ? "Unarchive session" : "Archive session"}
              onClick={(e) => handleArchiveSession(session.id, !!session.isArchived, e as unknown as React.MouseEvent)}
              variant="ghost"
              size="sm"
              className="!p-1 opacity-0 group-hover:opacity-100"
              title={session.isArchived ? "取消归档" : "归档"}
            />
          </div>
        )}

        {/* 未读指示器 */}
        {isUnread && !multiSelectMode && (
          <div className="absolute right-2 top-1/2 -translate-y-1/2 w-2 h-2 bg-purple-500 rounded-full" />
        )}
      </div>
    );
  };

  return (
    <div className="flex-1 flex flex-col bg-transparent overflow-hidden">
      {/* Header: h-12 to align with TitleBar on the right */}
      <div className="h-12 px-3 flex items-center justify-between flex-shrink-0 window-drag">
        {/* New Chat */}
        <button
          onClick={handleNewChat}
          disabled={isCreatingSession}
          className="flex items-center gap-2 text-zinc-400 hover:text-zinc-200 transition-colors disabled:opacity-50 window-no-drag"
        >
          <span className="w-6 h-6 rounded-full bg-zinc-600 flex items-center justify-center">
            {isCreatingSession ? (
              <Loader2 className="w-3.5 h-3.5 animate-spin" />
            ) : (
              <Plus className="w-3.5 h-3.5 stroke-[2]" />
            )}
          </span>
          <span className="text-sm font-normal">新会话</span>
        </button>

        <div className="flex items-center gap-2 window-no-drag">
          <button
            onClick={() => setSessionStatusFilter(isBackgroundOnly ? 'all' : 'background')}
            className={`rounded-full border px-2 py-0.5 text-[11px] transition-colors ${
              isBackgroundOnly
                ? 'border-sky-500/40 bg-sky-500/10 text-sky-200'
                : 'border-zinc-700 bg-zinc-900 text-zinc-500 hover:border-zinc-600 hover:text-zinc-300'
            }`}
            title={isBackgroundOnly ? '显示全部会话' : '仅看后台中的会话'}
          >
            后台中
          </button>
          <button
            onClick={cycleFilter}
            className="flex items-center gap-1 text-sm text-zinc-400 hover:text-zinc-200 transition-colors"
          >
            <span>{filterLabels[filter]}</span>
            <ChevronDown className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>

      {/* Search Box */}
      <div className="px-2 pb-1 flex-shrink-0">
        <div className="relative">
          <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-zinc-500" />
          <input
            type="text"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="搜索会话..."
            className="w-full pl-8 pr-7 py-1.5 text-sm bg-zinc-800 border border-zinc-700 rounded-lg text-zinc-200 placeholder-zinc-500 focus:outline-none focus:border-zinc-600 transition-colors"
          />
          {searchQuery && (
            <button
              onClick={() => setSearchQuery('')}
              className="absolute right-2 top-1/2 -translate-y-1/2 text-zinc-500 hover:text-zinc-400"
            >
              <X className="w-3.5 h-3.5" />
            </button>
          )}
        </div>
      </div>

      {/* Session List - Project Grouped */}
      <div className="flex-1 overflow-y-auto px-2 min-h-0">
        {isLoading && sessions.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-12 gap-3">
            <Loader2 className="w-6 h-6 animate-spin text-primary-400" />
            <span className="text-xs text-zinc-500">加载中...</span>
          </div>
        ) : !hasAnySessions ? (
          <div className="flex flex-col items-center justify-center h-full text-center px-4">
            <div className="w-12 h-12 rounded-2xl bg-zinc-800 flex items-center justify-center mb-3">
              <MessageSquare className="w-6 h-6 text-zinc-500" />
            </div>
            <p className="text-sm text-zinc-400 mb-1">暂无对话</p>
            <p className="text-xs text-zinc-500">开始新的对话</p>
          </div>
        ) : filteredSessions.length === 0 && hasSearchFilters ? (
          <div className="flex flex-col items-center justify-center py-12 text-center px-4">
            <Search className="w-6 h-6 text-zinc-600 mb-2" />
            <p className="text-sm text-zinc-500">
              {isBackgroundOnly && !searchQuery ? '当前没有后台中的会话' : '未找到匹配的会话'}
            </p>
          </div>
        ) : hasSearchFilters ? (
          /* When searching, show flat date-grouped list */
          <div className="py-2">
            {groupedSessions.map(({ group, label, sessions: groupSessions }) => (
              <div key={group} className="mb-2">
                <div className="sticky top-0 z-10 px-3 py-1.5 text-xs font-medium text-zinc-500 bg-zinc-900 backdrop-blur-sm">
                  {label}
                </div>
                <div className="space-y-0.5">
                  {groupSessions.map((session) => renderSessionItem(session as SessionWithMeta))}
                </div>
              </div>
            ))}
          </div>
        ) : (
          /* Default: project-grouped view */
          <div className="py-2">
            {projectGroupedSessions.map(({ project, dateGroups }) => (
              <div key={project} className="mb-3">
                {/* Project header */}
                <div className="sticky top-0 z-20 flex items-center gap-1.5 px-3 py-1.5 bg-zinc-900 backdrop-blur-sm">
                  <FolderOpen className="w-3 h-3 text-zinc-500" />
                  <span className="text-xs font-medium text-zinc-400">{project}</span>
                </div>
                {/* Date groups within project */}
                {dateGroups.map(({ group, label, sessions: groupSessions }) => (
                  <div key={`${project}-${group}`} className="mb-1">
                    <div className="px-3 py-1 text-xs text-zinc-600">
                      {label}
                    </div>
                    <div className="space-y-0.5">
                      {groupSessions.map((session) => renderSessionItem(session as SessionWithMeta))}
                    </div>
                  </div>
                ))}
              </div>
            ))}
          </div>
        )}
      </div>

      {/* 多选模式底部操作栏 */}
      {multiSelectMode && selectedSessionIds.size > 0 && (
        <div className="px-3 py-2 border-t border-zinc-700 flex items-center justify-between">
          <span className="text-xs text-zinc-400">
            已选 {selectedSessionIds.size} 个
          </span>
          <div className="flex items-center gap-2">
            <button
              onClick={clearSelection}
              className="text-xs text-zinc-500 hover:text-zinc-400 transition-colors"
            >
              取消
            </button>
            <button
              onClick={batchDelete}
              className="flex items-center gap-1 text-xs text-red-400 hover:text-red-300 transition-colors"
            >
              <Trash2 className="w-3.5 h-3.5" />
              删除
            </button>
          </div>
        </div>
      )}



      {/* Bottom: User Menu or Login */}
      <div className="p-2 relative flex-shrink-0" ref={accountMenuRef}>
        {isAuthenticated && user ? (
          <>
            <button
              onClick={() => setShowUserMenu(!showUserMenu)}
              aria-label="用户菜单"
              aria-expanded={showUserMenu}
              className="w-full flex items-center gap-3 px-3 py-2.5 rounded-xl hover:bg-white/[0.04] transition-colors"
            >
              {user.avatarUrl ? (
                <img
                  src={user.avatarUrl}
                  alt=""
                  className="w-7 h-7 rounded-full object-cover"
                />
              ) : (
                <User className="w-5 h-5 text-zinc-500" />
              )}
              <span className="flex-1 text-left text-sm font-medium text-zinc-400 truncate">
                {user.nickname || user.email?.split('@')[0]}
              </span>
              <ChevronDown className={`w-4 h-4 text-zinc-600 transition-transform ${showUserMenu ? 'rotate-180' : ''}`} />
            </button>
            {/* User Dropdown Menu */}
            {showUserMenu && (
              <div className="absolute bottom-full left-2 right-2 mb-2 bg-zinc-900 border border-zinc-700 rounded-xl shadow-xl overflow-hidden z-50">
                <button
                  onClick={() => {
                    setShowSettings(true);
                    setShowUserMenu(false);
                  }}
                  className="w-full flex items-center gap-2 px-3 py-2.5 text-sm text-zinc-400 hover:text-zinc-200 hover:bg-zinc-700 transition-colors"
                >
                  <Settings className="w-4 h-4" />
                  设置
                </button>
                <button
                  onClick={() => {
                    signOut();
                    setShowUserMenu(false);
                  }}
                  className="w-full flex items-center gap-2 px-3 py-2.5 text-sm text-zinc-400 hover:text-zinc-200 hover:bg-zinc-700 transition-colors"
                >
                  <LogOut className="w-4 h-4" />
                  退出登录
                </button>
              </div>
            )}
          </>
        ) : (
          <button
            onClick={() => setShowAuthModal(true)}
            className="w-full flex items-center justify-center gap-2 px-3 py-2.5 rounded-xl bg-white/[0.06] hover:bg-white/[0.08] border border-white/[0.06] text-zinc-400 text-sm font-medium transition-colors"
          >
            <LogIn className="w-4 h-4" />
            登录
          </button>
        )}
      </div>

      {/* 右键菜单 */}
      {contextMenu && (
        <SessionContextMenu
          x={contextMenu.x}
          y={contextMenu.y}
          items={getContextMenuItems(contextMenu.session)}
          onClose={() => setContextMenu(null)}
        />
      )}

      {/* 撤销删除 Toast */}
      {pendingDelete && (
        <UndoToast
          message={`已删除 ${pendingDelete.ids.length} 个对话`}
          onUndo={undoDelete}
          onDismiss={() => {
            // timer 已经在 softDelete 中设置了，这里是视觉消失后的回调
            // 不需要额外操作，confirmDelete 由 timer 触发
          }}
        />
      )}
    </div>
  );
};
