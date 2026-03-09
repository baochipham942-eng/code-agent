// ============================================================================
// Sidebar - Linear-style session list with grouped cards and session management
// ============================================================================

import React, { useEffect, useState, useMemo, useRef, useCallback } from 'react';
import { useSessionStore, initializeSessionStore, type SessionWithMeta, type SessionFilter } from '../stores/sessionStore';
import { useAppStore } from '../stores/appStore';
import { useAuthStore } from '../stores/authStore';
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
  BookOpen,
  CheckSquare,
  Square,
  Trash2,
  Pin,
} from 'lucide-react';
import { IPC_CHANNELS } from '@shared/ipc';
import { IconButton, UndoToast } from './primitives';
import { createLogger } from '../utils/logger';
import { groupSessions, type DateGroup } from '../utils/dateGrouping';
import { SessionContextMenu, type ContextMenuItem } from './features/sidebar/SessionContextMenu';

const logger = createLogger('Sidebar');

// 获取相对时间
function getRelativeTime(timestamp: number): string {
  const now = Date.now();
  const diff = now - timestamp;
  const minutes = Math.floor(diff / (1000 * 60));
  const hours = Math.floor(diff / (1000 * 60 * 60));
  const days = Math.floor(diff / (1000 * 60 * 60 * 24));

  if (minutes < 1) return '刚刚';
  if (minutes < 60) return `${minutes}分钟`;
  if (hours < 24) return `${hours}小时`;
  if (days < 7) return `${days}天`;
  if (days < 30) return `${Math.floor(days / 7)}周`;
  return `${Math.floor(days / 30)}月`;
}

export const Sidebar: React.FC = () => {
  const { clearPlanningState, setShowSettings, setShowCapturePanel } = useAppStore();
  const {
    sessions,
    currentSessionId,
    isLoading,
    createSession,
    switchSession,
    archiveSession,
    unarchiveSession,
    unreadSessionIds,
    filter,
    setFilter,
    pinnedSessionIds,
    togglePin,
    multiSelectMode,
    toggleMultiSelect,
    selectedSessionIds,
    toggleSelection,
    clearSelection,
    batchDelete,
    softDelete,
    undoDelete,
    pendingDelete,
    renameSession,
  } = useSessionStore();

  const { user, isAuthenticated, setShowAuthModal, signOut } = useAuthStore();

  const [hoveredSession, setHoveredSession] = useState<string | null>(null);
  const [appVersion, setAppVersion] = useState<string>('');
  const [showUserMenu, setShowUserMenu] = useState(false);
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
        const version = await window.electronAPI?.invoke(IPC_CHANNELS.APP_GET_VERSION);
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

  // 按日期分组
  const groupedSessions = useMemo(() => {
    return groupSessions(sessions, pinnedSessionIds);
  }, [sessions, pinnedSessionIds]);

  const handleNewChat = async () => {
    await createSession('新对话');
    clearPlanningState();
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
        label: '导出',
        icon: '📤',
        onClick: async () => {
          try {
            const data = await window.electronAPI?.invoke(IPC_CHANNELS.SESSION_EXPORT, session.id);
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
  }, [pinnedSessionIds, togglePin, archiveSession, unarchiveSession, softDelete]);

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

  // 渲染单个会话项
  const renderSessionItem = (session: SessionWithMeta) => {
    const isUnread = unreadSessionIds.has(session.id);
    const isSelected = currentSessionId === session.id;
    const isChecked = selectedSessionIds.has(session.id);
    const isPinned = pinnedSessionIds.has(session.id);
    const isRenaming = renamingId === session.id;

    return (
      <div
        key={session.id}
        onClick={() => handleSelectSession(session.id)}
        onContextMenu={(e) => handleContextMenu(e, session)}
        onMouseEnter={() => setHoveredSession(session.id)}
        onMouseLeave={() => setHoveredSession(null)}
        className={`group relative flex items-center px-3 py-2.5 rounded-lg cursor-pointer transition-all duration-150 ${
          isSelected && !multiSelectMode
            ? 'bg-zinc-700/60'
            : isChecked
              ? 'bg-blue-500/10 border border-blue-500/20'
              : 'hover:bg-zinc-800'
        }`}
      >
        {/* 多选模式：Checkbox */}
        {multiSelectMode && (
          <div className="mr-2 shrink-0">
            {isChecked ? (
              <CheckSquare className="w-4 h-4 text-blue-400" />
            ) : (
              <Square className="w-4 h-4 text-zinc-500" />
            )}
          </div>
        )}

        {/* 内容区域 */}
        <div className="flex-1 min-w-0">
          <div className="flex items-center justify-between gap-2">
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
                  isSelected ? 'text-zinc-200' : 'text-zinc-400'
                }`}
              >
                {session.title}
              </span>
            )}

            {/* 时间 + 操作按钮 */}
            {!isRenaming && (
              <>
                <span className="text-xs text-zinc-500 shrink-0">
                  {getRelativeTime(session.updatedAt)}
                </span>
                {hoveredSession === session.id && !multiSelectMode && (
                  <IconButton
                    icon={session.isArchived ? <ArchiveRestore className="w-3.5 h-3.5" /> : <Archive className="w-3.5 h-3.5" />}
                    aria-label={session.isArchived ? "Unarchive session" : "Archive session"}
                    onClick={(e) => handleArchiveSession(session.id, !!session.isArchived, e as unknown as React.MouseEvent)}
                    variant="ghost"
                    size="sm"
                    className="!p-1 opacity-0 group-hover:opacity-100"
                    title={session.isArchived ? "取消归档" : "归档"}
                  />
                )}
              </>
            )}
          </div>
        </div>

        {/* 未读指示器 */}
        {isUnread && !multiSelectMode && (
          <div className="absolute right-2 top-1/2 -translate-y-1/2 w-2 h-2 bg-purple-500 rounded-full" />
        )}
      </div>
    );
  };

  return (
    <div className="flex-1 flex flex-col bg-transparent overflow-hidden">
      {/* Header: New Chat + Multi-select + Filter */}
      <div className="px-3 py-3 flex items-center justify-between flex-shrink-0">
        {/* New Chat */}
        <button
          onClick={handleNewChat}
          disabled={isLoading}
          className="flex items-center gap-2 text-zinc-400 hover:text-zinc-200 transition-colors disabled:opacity-50"
        >
          <span className="w-6 h-6 rounded-full bg-zinc-600 flex items-center justify-center">
            {isLoading ? (
              <Loader2 className="w-3.5 h-3.5 animate-spin" />
            ) : (
              <Plus className="w-3.5 h-3.5 stroke-[2]" />
            )}
          </span>
          <span className="text-sm font-normal">新会话</span>
        </button>

        <div className="flex items-center gap-2">
          {/* 多选模式切换 */}
          {hasAnySessions && (
            <button
              onClick={toggleMultiSelect}
              className={`p-1.5 transition-colors rounded-md ${
                multiSelectMode
                  ? 'text-blue-400 bg-blue-500/10'
                  : 'text-zinc-500 hover:text-zinc-400 hover:bg-zinc-800'
              }`}
              title={multiSelectMode ? '退出多选' : '多选'}
            >
              <CheckSquare className="w-3.5 h-3.5" />
            </button>
          )}

          {/* Knowledge Base */}
          <button
            onClick={() => setShowCapturePanel(true)}
            className="p-1.5 text-zinc-500 hover:text-cyan-400 transition-colors rounded-md hover:bg-zinc-800"
            title="知识库"
          >
            <BookOpen className="w-3.5 h-3.5" />
          </button>
          {/* Filter Dropdown */}
          <button
            onClick={cycleFilter}
            className="flex items-center gap-1 text-sm text-zinc-400 hover:text-zinc-200 transition-colors"
          >
            <span>{filterLabels[filter]}</span>
            <ChevronDown className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>

      {/* Session List - Grouped */}
      <div className="flex-1 overflow-y-auto px-2 min-h-0">
        {isLoading && sessions.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-12 gap-3">
            <Loader2 className="w-6 h-6 animate-spin text-primary-400" />
            <span className="text-xs text-zinc-500">加载中...</span>
          </div>
        ) : !hasAnySessions ? (
          <div className="flex flex-col items-center justify-center py-12 text-center px-4">
            <div className="w-12 h-12 rounded-2xl bg-zinc-800 flex items-center justify-center mb-3">
              <MessageSquare className="w-6 h-6 text-zinc-500" />
            </div>
            <p className="text-sm text-zinc-400 mb-1">暂无对话</p>
            <p className="text-xs text-zinc-500">开始新的对话</p>
          </div>
        ) : (
          <div className="py-2">
            {groupedSessions.map(({ group, label, sessions: groupSessions }) => (
              <div key={group} className="mb-2">
                {/* 分组标题 - sticky header */}
                <div className="sticky top-0 z-10 px-3 py-1.5 text-xs font-medium text-zinc-500 bg-zinc-900 backdrop-blur-sm">
                  {label}
                </div>
                {/* 分组内容 */}
                <div className="space-y-0.5">
                  {groupSessions.map((session) => renderSessionItem(session as SessionWithMeta))}
                </div>
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
              <div className="absolute bottom-full left-2 right-2 mb-2 bg-zinc-900 border border-zinc-700 rounded-xl shadow-xl overflow-hidden">
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
