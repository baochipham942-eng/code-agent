// ============================================================================
// Sidebar - Chat History and Navigation (Enhanced UI/UX)
// ============================================================================

import React, { useEffect, useState, useMemo } from 'react';
import { useSessionStore, initializeSessionStore } from '../stores/sessionStore';
import { useAppStore } from '../stores/appStore';
import { useAuthStore } from '../stores/authStore';
import {
  MessageSquare,
  Plus,
  Trash2,
  Loader2,
  Search,
  Calendar,
  Clock,
  Sparkles,
  User,
  LogIn,
  Cloud,
  CloudOff,
  Settings,
} from 'lucide-react';
import { UserMenu } from './UserMenu';

// 会话分组类型
type SessionGroup = 'today' | 'yesterday' | 'week' | 'month' | 'older';

// 获取会话分组
function getSessionGroup(timestamp: number): SessionGroup {
  const now = new Date();
  const date = new Date(timestamp);
  const diffDays = Math.floor((now.getTime() - date.getTime()) / (1000 * 60 * 60 * 24));

  if (diffDays === 0) return 'today';
  if (diffDays === 1) return 'yesterday';
  if (diffDays <= 7) return 'week';
  if (diffDays <= 30) return 'month';
  return 'older';
}

// 分组标签
const groupLabels: Record<SessionGroup, string> = {
  today: '今天',
  yesterday: '昨天',
  week: '本周',
  month: '本月',
  older: '更早',
};

// 分组图标
const GroupIcon: React.FC<{ group: SessionGroup }> = ({ group }) => {
  switch (group) {
    case 'today':
      return <Sparkles className="w-3 h-3" />;
    case 'yesterday':
    case 'week':
      return <Clock className="w-3 h-3" />;
    default:
      return <Calendar className="w-3 h-3" />;
  }
};

export const Sidebar: React.FC = () => {
  const { sidebarCollapsed, clearChat, setShowSettings } = useAppStore();
  const {
    sessions,
    currentSessionId,
    isLoading,
    createSession,
    switchSession,
    deleteSession,
  } = useSessionStore();
  const { isAuthenticated, user, syncStatus, setShowAuthModal } = useAuthStore();

  const [searchQuery, setSearchQuery] = useState('');
  const [hoveredSession, setHoveredSession] = useState<string | null>(null);

  // 初始化：加载会话列表
  useEffect(() => {
    initializeSessionStore();
  }, []);

  // 过滤和分组会话
  const groupedSessions = useMemo(() => {
    const filtered = sessions.filter(session =>
      session.title.toLowerCase().includes(searchQuery.toLowerCase())
    );

    const groups: Record<SessionGroup, typeof sessions> = {
      today: [],
      yesterday: [],
      week: [],
      month: [],
      older: [],
    };

    filtered.forEach(session => {
      const group = getSessionGroup(session.updatedAt);
      groups[group].push(session);
    });

    return groups;
  }, [sessions, searchQuery]);

  const handleNewChat = async () => {
    await createSession('新对话');
    clearChat();
  };

  const handleSelectSession = async (sessionId: string) => {
    if (sessionId !== currentSessionId) {
      await switchSession(sessionId);
    }
  };

  const handleDeleteSession = async (id: string, e: React.MouseEvent) => {
    e.stopPropagation();
    await deleteSession(id);
  };

  if (sidebarCollapsed) {
    return null;
  }

  const hasAnySessions = sessions.length > 0;
  const hasFilteredSessions = Object.values(groupedSessions).some(g => g.length > 0);

  return (
    <div className="w-64 border-r border-zinc-800/50 flex flex-col bg-surface-950/80 backdrop-blur-sm">
      {/* New Chat Button */}
      <div className="p-3">
        <button
          onClick={handleNewChat}
          disabled={isLoading}
          className="w-full flex items-center justify-center gap-2 px-4 py-2.5 rounded-xl bg-gradient-to-r from-primary-600 to-primary-500 hover:from-primary-500 hover:to-primary-400 disabled:opacity-50 disabled:cursor-not-allowed text-white font-medium text-sm transition-all duration-200 shadow-lg shadow-primary-500/20 hover:shadow-primary-500/30 active:scale-[0.98]"
        >
          {isLoading ? (
            <Loader2 className="w-4 h-4 animate-spin" />
          ) : (
            <Plus className="w-4 h-4" />
          )}
          <span>新对话</span>
        </button>
      </div>

      {/* Search Bar */}
      {hasAnySessions && (
        <div className="px-3 pb-2">
          <div className="relative">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-zinc-500" />
            <input
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="搜索对话..."
              className="w-full pl-9 pr-3 py-2 text-sm bg-zinc-800/50 border border-zinc-700/50 rounded-lg text-zinc-100 placeholder-zinc-500 focus:outline-none focus:border-primary-500/50 focus:ring-1 focus:ring-primary-500/20 transition-all"
            />
          </div>
        </div>
      )}

      {/* Chat History */}
      <div className="flex-1 overflow-y-auto px-2 pb-2">
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
        ) : !hasFilteredSessions ? (
          <div className="flex flex-col items-center justify-center py-8 text-center">
            <Search className="w-8 h-8 text-zinc-600 mb-2" />
            <p className="text-sm text-zinc-400">没有匹配的对话</p>
          </div>
        ) : (
          <div className="space-y-4">
            {(Object.keys(groupedSessions) as SessionGroup[]).map((group) => {
              const groupSessions = groupedSessions[group];
              if (groupSessions.length === 0) return null;

              return (
                <div key={group} className="animate-fadeIn">
                  {/* Group Header */}
                  <div className="flex items-center gap-2 px-2 py-1.5 text-xs font-medium text-zinc-500">
                    <GroupIcon group={group} />
                    <span>{groupLabels[group]}</span>
                    <span className="ml-auto text-zinc-600">{groupSessions.length}</span>
                  </div>

                  {/* Group Sessions */}
                  <div className="space-y-0.5">
                    {groupSessions.map((session, index) => (
                      <div
                        key={session.id}
                        onClick={() => handleSelectSession(session.id)}
                        onMouseEnter={() => setHoveredSession(session.id)}
                        onMouseLeave={() => setHoveredSession(null)}
                        style={{ animationDelay: `${index * 30}ms` }}
                        className={`group flex items-center gap-2.5 px-3 py-2.5 rounded-xl cursor-pointer transition-all duration-200 animate-slideUp ${
                          currentSessionId === session.id
                            ? 'bg-primary-500/10 text-zinc-100 border border-primary-500/20'
                            : 'hover:bg-zinc-800/50 text-zinc-400 hover:text-zinc-200 border border-transparent'
                        }`}
                      >
                        <div className={`w-8 h-8 rounded-lg flex items-center justify-center shrink-0 transition-colors ${
                          currentSessionId === session.id
                            ? 'bg-primary-500/20 text-primary-400'
                            : 'bg-zinc-800/50 text-zinc-500 group-hover:text-zinc-400'
                        }`}>
                          <MessageSquare className="w-4 h-4" />
                        </div>
                        <div className="flex-1 min-w-0">
                          <span className="text-sm truncate block font-medium">{session.title}</span>
                          {session.messageCount > 0 && (
                            <span className="text-xs text-zinc-500">
                              {session.messageCount} 条消息
                            </span>
                          )}
                        </div>
                        <button
                          onClick={(e) => handleDeleteSession(session.id, e)}
                          className={`p-1.5 rounded-lg text-zinc-500 hover:text-red-400 hover:bg-red-500/10 transition-all duration-200 ${
                            hoveredSession === session.id ? 'opacity-100' : 'opacity-0'
                          }`}
                        >
                          <Trash2 className="w-3.5 h-3.5" />
                        </button>
                      </div>
                    ))}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* User Section */}
      <div className="p-3 border-t border-zinc-800/50">
        {isAuthenticated && user ? (
          <div className="space-y-2">
            {/* User Menu */}
            <UserMenu />

            {/* Sync Status */}
            <div className="flex items-center justify-between text-xs">
              <span className="text-zinc-500">云同步</span>
              <span className={`flex items-center gap-1 ${
                syncStatus.isEnabled ? 'text-green-400' : 'text-zinc-500'
              }`}>
                {syncStatus.isEnabled ? (
                  <>
                    <Cloud className="w-3 h-3" />
                    {syncStatus.isSyncing ? '同步中...' : '已开启'}
                  </>
                ) : (
                  <>
                    <CloudOff className="w-3 h-3" />
                    已关闭
                  </>
                )}
              </span>
            </div>
          </div>
        ) : (
          <div className="space-y-2">
            {/* Login Button */}
            <button
              onClick={() => setShowAuthModal(true)}
              className="w-full flex items-center justify-center gap-2 px-3 py-2 rounded-lg bg-zinc-800 hover:bg-zinc-700 text-zinc-300 hover:text-white transition-colors"
            >
              <LogIn className="w-4 h-4" />
              <span className="text-sm">登录 / 注册</span>
            </button>
            <p className="text-xs text-zinc-500 text-center">
              登录后可云端同步会话记录
            </p>
          </div>
        )}

        {/* Version */}
        <div className="mt-3 pt-3 border-t border-zinc-800/50 flex items-center justify-center">
          <div className="flex items-center gap-2 text-xs text-zinc-600">
            <div className="w-1.5 h-1.5 rounded-full bg-green-500 animate-pulse" />
            <span>Code Agent v0.2.2</span>
          </div>
        </div>
      </div>
    </div>
  );
};
