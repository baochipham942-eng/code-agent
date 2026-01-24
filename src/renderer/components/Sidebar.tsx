// ============================================================================
// Sidebar - Linear-style session list with dual-line cards and account menu
// ============================================================================

import React, { useEffect, useState, useMemo, useRef } from 'react';
import { useSessionStore, initializeSessionStore, type SessionWithMeta } from '../stores/sessionStore';
import { useAppStore } from '../stores/appStore';
import { useAuthStore } from '../stores/authStore';
import {
  MessageSquare,
  Plus,
  Archive,
  Loader2,
  User,
  Settings,
  LogOut,
  LogIn,
  ChevronUp,
  Filter,
} from 'lucide-react';
import { IPC_CHANNELS } from '@shared/ipc';
import { Button, IconButton } from './primitives';
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

// 获取会话预览（最后一条消息内容）
function getSessionPreview(session: SessionWithMeta): string {
  // If we have preview content stored, use it
  // For now, return placeholder
  return '好的，我来帮你处理...';
}

// Filter type
type FilterType = 'active' | 'archived';

export const Sidebar: React.FC = () => {
  const { clearChat, setShowSettings } = useAppStore();
  const {
    sessions,
    currentSessionId,
    isLoading,
    createSession,
    switchSession,
    unreadSessionIds,
  } = useSessionStore();

  const { user, isAuthenticated, signOut, setShowAuthModal } = useAuthStore();

  const [hoveredSession, setHoveredSession] = useState<string | null>(null);
  const [appVersion, setAppVersion] = useState<string>('');
  const [showAccountMenu, setShowAccountMenu] = useState(false);
  const [filter, setFilter] = useState<FilterType>('active');
  const [showFilterDropdown, setShowFilterDropdown] = useState(false);
  const accountMenuRef = useRef<HTMLDivElement>(null);
  const filterRef = useRef<HTMLDivElement>(null);

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

  // Close menus when clicking outside
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (accountMenuRef.current && !accountMenuRef.current.contains(event.target as Node)) {
        setShowAccountMenu(false);
      }
      if (filterRef.current && !filterRef.current.contains(event.target as Node)) {
        setShowFilterDropdown(false);
      }
    };

    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  // 过滤会话（暂时只显示 active，归档功能待实现）
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

  const handleArchiveSession = async (id: string, e: React.MouseEvent) => {
    e.stopPropagation();
    // TODO: Implement archive functionality
    logger.info('Archive session', { id });
  };

  const hasAnySessions = sessions.length > 0;

  return (
    <div className="w-60 border-r border-zinc-800/50 flex flex-col bg-surface-950">
      {/* Header: New Chat + Filter */}
      <div className="p-3 flex items-center gap-2">
        <Button
          onClick={handleNewChat}
          loading={isLoading}
          variant="primary"
          leftIcon={!isLoading ? <Plus className="w-4 h-4" /> : undefined}
          className="flex-1"
        >
          新对话
        </Button>

        {/* Filter Dropdown */}
        <div className="relative" ref={filterRef}>
          <IconButton
            icon={<Filter className="w-4 h-4" />}
            aria-label="Filter sessions"
            onClick={() => setShowFilterDropdown(!showFilterDropdown)}
            variant={showFilterDropdown ? 'active' : 'default'}
            size="md"
          />

          {showFilterDropdown && (
            <div className="absolute right-0 top-full mt-1 w-36 bg-zinc-800 border border-zinc-700 rounded-lg shadow-xl z-50 py-1">
              <button
                onClick={() => { setFilter('active'); setShowFilterDropdown(false); }}
                className={`w-full text-left px-3 py-2 text-sm hover:bg-zinc-700/50 ${
                  filter === 'active' ? 'text-zinc-100' : 'text-zinc-400'
                }`}
              >
                进行中
              </button>
              <button
                onClick={() => { setFilter('archived'); setShowFilterDropdown(false); }}
                className={`w-full text-left px-3 py-2 text-sm hover:bg-zinc-700/50 ${
                  filter === 'archived' ? 'text-zinc-100' : 'text-zinc-400'
                }`}
              >
                已归档
              </button>
            </div>
          )}
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
          <div className="space-y-1 py-1">
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
                      ? 'bg-primary-500/10 border-l-2 border-primary-500'
                      : 'hover:bg-zinc-800/50 border-l-2 border-transparent'
                  }`}
                >
                  {/* Row 1: Title + Archive icon */}
                  <div className="flex items-center justify-between gap-2">
                    <span className={`text-sm truncate font-medium ${
                      isSelected ? 'text-zinc-100' : 'text-zinc-300'
                    }`}>
                      {session.title}
                    </span>
                    {hoveredSession === session.id && (
                      <IconButton
                        icon={<Archive className="w-3.5 h-3.5" />}
                        aria-label="Archive session"
                        onClick={(e) => handleArchiveSession(session.id, e as unknown as React.MouseEvent)}
                        variant="ghost"
                        size="sm"
                        className="!p-1 opacity-0 group-hover:opacity-100"
                      />
                    )}
                  </div>

                  {/* Row 2: Preview + Time */}
                  <div className="flex items-center justify-between gap-2 mt-0.5">
                    <span className="text-xs text-zinc-500 truncate flex-1">
                      {getSessionPreview(session)}
                    </span>
                    <span className="text-xs text-zinc-600 shrink-0">
                      {getRelativeTime(session.updatedAt)}
                    </span>
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

      {/* Account Menu (Bottom) */}
      <div className="border-t border-zinc-800/50 p-2" ref={accountMenuRef}>
        {isAuthenticated && user ? (
          <div className="relative">
            {/* Account Button */}
            <button
              onClick={() => setShowAccountMenu(!showAccountMenu)}
              className="w-full flex items-center gap-3 px-3 py-2 rounded-lg hover:bg-zinc-800/50 transition-colors"
            >
              {user.avatarUrl ? (
                <img
                  src={user.avatarUrl}
                  alt=""
                  className="w-8 h-8 rounded-full object-cover"
                />
              ) : (
                <div className="w-8 h-8 rounded-full bg-primary-600 flex items-center justify-center">
                  <User className="w-4 h-4 text-white" />
                </div>
              )}
              <div className="flex-1 text-left min-w-0">
                <div className="text-sm font-medium text-zinc-200 truncate">
                  {user.nickname || user.email?.split('@')[0]}
                </div>
                <div className="text-xs text-zinc-500">
                  {sessions.length} 条消息
                </div>
              </div>
              <ChevronUp className={`w-4 h-4 text-zinc-500 transition-transform ${showAccountMenu ? '' : 'rotate-180'}`} />
            </button>

            {/* Popup Menu (expands upward) */}
            {showAccountMenu && (
              <div className="absolute bottom-full left-0 right-0 mb-1 bg-zinc-800 border border-zinc-700 rounded-lg shadow-xl z-50 overflow-hidden animate-slideDown">
                {/* Settings */}
                <button
                  onClick={() => {
                    setShowSettings(true);
                    setShowAccountMenu(false);
                  }}
                  className="w-full flex items-center gap-2 px-3 py-2.5 text-sm text-zinc-300 hover:bg-zinc-700/50 transition-colors"
                >
                  <Settings className="w-4 h-4" />
                  设置
                </button>

                {/* Divider */}
                <div className="border-t border-zinc-700" />

                {/* Logout */}
                <button
                  onClick={() => {
                    signOut();
                    setShowAccountMenu(false);
                  }}
                  className="w-full flex items-center gap-2 px-3 py-2.5 text-sm text-zinc-400 hover:bg-zinc-700/50 hover:text-zinc-200 transition-colors"
                >
                  <LogOut className="w-4 h-4" />
                  退出登录
                </button>

                {/* Divider */}
                <div className="border-t border-zinc-700" />

                {/* Version */}
                <div className="px-3 py-2 text-xs text-zinc-600">
                  v{appVersion}
                </div>
              </div>
            )}
          </div>
        ) : (
          <button
            onClick={() => setShowAuthModal(true)}
            className="w-full flex items-center justify-center gap-2 px-3 py-2 rounded-lg bg-primary-600 hover:bg-primary-500 text-white text-sm font-medium transition-colors"
          >
            <LogIn className="w-4 h-4" />
            登录
          </button>
        )}
      </div>
    </div>
  );
};
