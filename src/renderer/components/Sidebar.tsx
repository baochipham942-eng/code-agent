// ============================================================================
// Sidebar - Linear-style session list with dual-line cards and account menu
// ============================================================================

import React, { useEffect, useState, useMemo, useRef } from 'react';
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
  ChevronDown,
} from 'lucide-react';
import { IPC_CHANNELS } from '@shared/ipc';
import { IconButton } from './primitives';
import { createLogger } from '../utils/logger';

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
  const { clearChat, setShowSettings } = useAppStore();
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
  } = useSessionStore();

  const { user, isAuthenticated, setShowAuthModal } = useAuthStore();

  const [hoveredSession, setHoveredSession] = useState<string | null>(null);
  const [appVersion, setAppVersion] = useState<string>('');
  const accountMenuRef = useRef<HTMLDivElement>(null);

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

  // 过滤会话
  const filteredSessions = useMemo(() => {
    // Sort by updatedAt desc
    return [...sessions].sort((a, b) => b.updatedAt - a.updatedAt);
  }, [sessions]);

  const handleNewChat = async () => {
    await createSession('新对话');
    clearChat();
  };

  const handleSelectSession = async (sessionId: string) => {
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

  // 过滤器显示文本（只保留进行中和已归档）
  const filterLabels: Record<SessionFilter, string> = {
    active: '进行中',
    archived: '已归档',
    all: '全部',
  };

  // 循环切换过滤器（只在进行中和已归档之间切换）
  const cycleFilter = () => {
    const filters: SessionFilter[] = ['active', 'archived'];
    const currentIndex = filters.indexOf(filter);
    const nextIndex = (currentIndex + 1) % filters.length;
    setFilter(filters[nextIndex]);
  };

  const hasAnySessions = sessions.length > 0;

  return (
    <div className="flex-1 flex flex-col bg-transparent overflow-hidden">
      {/* Header: New Chat + Filter */}
      <div className="px-3 py-3 flex items-center justify-between">
        {/* New Chat - icon + text style (Claude Code style) */}
        <button
          onClick={handleNewChat}
          disabled={isLoading}
          className="flex items-center gap-2 text-zinc-400 hover:text-zinc-200 transition-colors disabled:opacity-50"
        >
          {isLoading ? (
            <Loader2 className="w-4 h-4 animate-spin" />
          ) : (
            <Plus className="w-4 h-4 stroke-[1.5]" />
          )}
          <span className="text-sm font-normal">New session</span>
        </button>

        {/* Filter Dropdown */}
        <div className="relative">
          <button
            onClick={cycleFilter}
            className="flex items-center gap-1 text-sm text-zinc-400 hover:text-zinc-200 transition-colors"
          >
            <span>{filterLabels[filter]}</span>
            <ChevronDown className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>

      {/* Session List - Flat list, no grouping */}
      <div className="flex-1 overflow-y-auto px-2">
        {isLoading && sessions.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-12 gap-3">
            <Loader2 className="w-6 h-6 animate-spin text-primary-400" />
            <span className="text-xs text-zinc-500">加载中...</span>
          </div>
        ) : !hasAnySessions ? (
          <div className="flex flex-col items-center justify-center py-12 text-center px-4">
            <div className="w-12 h-12 rounded-2xl bg-zinc-800/50 flex items-center justify-center mb-3">
              <MessageSquare className="w-6 h-6 text-zinc-500" />
            </div>
            <p className="text-sm text-zinc-400 mb-1">暂无对话</p>
            <p className="text-xs text-zinc-500">开始新的对话</p>
          </div>
        ) : (
          <div className="space-y-1 py-2">
            {filteredSessions.map((session) => {
              const isUnread = unreadSessionIds.has(session.id);
              const isSelected = currentSessionId === session.id;

              return (
                <div
                  key={session.id}
                  onClick={() => handleSelectSession(session.id)}
                  onMouseEnter={() => setHoveredSession(session.id)}
                  onMouseLeave={() => setHoveredSession(null)}
                  className={`group relative flex flex-col px-3 py-2.5 rounded-lg cursor-pointer transition-all duration-150 ${
                    isSelected
                      ? 'bg-zinc-800/60'
                      : 'hover:bg-zinc-800/40'
                  }`}
                >
                  {/* Single row: Title + Time + Archive icon */}
                  <div className="flex items-center justify-between gap-2">
                    <span className={`text-sm truncate font-medium flex-1 ${
                      isSelected ? 'text-zinc-100' : 'text-zinc-300'
                    }`}>
                      {session.title}
                    </span>
                    <span className="text-xs text-zinc-500 shrink-0">
                      {getRelativeTime(session.updatedAt)}
                    </span>
                    {hoveredSession === session.id && (
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
                  </div>

                  {/* Unread indicator */}
                  {isUnread && (
                    <div className="absolute right-2 top-1/2 -translate-y-1/2 w-2 h-2 bg-purple-500 rounded-full" />
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* Bottom: Settings or Login - no border */}
      <div className="p-2" ref={accountMenuRef}>
        {isAuthenticated && user ? (
          <button
            onClick={() => setShowSettings(true)}
            className="w-full flex items-center gap-3 px-3 py-2.5 rounded-xl hover:bg-white/[0.04] transition-colors"
          >
            {user.avatarUrl ? (
              <img
                src={user.avatarUrl}
                alt=""
                className="w-7 h-7 rounded-full object-cover"
              />
            ) : (
              /* Simple user icon - no background */
              <User className="w-5 h-5 text-zinc-500" />
            )}
            <span className="flex-1 text-left text-sm font-medium text-zinc-400 truncate">
              {user.nickname || user.email?.split('@')[0]}
            </span>
            <Settings className="w-4 h-4 text-zinc-600" />
          </button>
        ) : (
          <button
            onClick={() => setShowAuthModal(true)}
            className="w-full flex items-center justify-center gap-2 px-3 py-2.5 rounded-xl bg-white/[0.06] hover:bg-white/[0.08] border border-white/[0.06] text-zinc-300 text-sm font-medium transition-colors"
          >
            <LogIn className="w-4 h-4" />
            登录
          </button>
        )}
      </div>
    </div>
  );
};
