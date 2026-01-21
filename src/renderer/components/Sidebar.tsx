// ============================================================================
// Sidebar - Chat History and Navigation (Enhanced UI/UX)
// ============================================================================

import React, { useEffect, useState, useMemo } from 'react';
import { useSessionStore, initializeSessionStore, type SessionWithMeta } from '../stores/sessionStore';
import { useAppStore } from '../stores/appStore';
import { useIsCoworkMode } from '../stores/modeStore';
import {
  MessageSquare,
  Plus,
  Trash2,
  Loader2,
  Search,
  Calendar,
  Clock,
  Sparkles,
  FolderOpen,
} from 'lucide-react';
import { IPC_CHANNELS } from '@shared/ipc';
import { Button, IconButton } from './primitives';
import { createLogger } from '../utils/logger';

const logger = createLogger('Sidebar');

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

// 获取工作空间名称（从路径提取最后一级目录名）
function getWorkspaceName(path?: string): string {
  if (!path) return '未指定工作空间';
  const parts = path.split('/').filter(Boolean);
  return parts[parts.length - 1] || path;
}

// 按工作空间分组会话
function groupSessionsByWorkspace(sessions: SessionWithMeta[]): Record<string, SessionWithMeta[]> {
  const groups: Record<string, SessionWithMeta[]> = {};

  sessions.forEach(session => {
    const workspace = session.workingDirectory || '未指定工作空间';
    if (!groups[workspace]) {
      groups[workspace] = [];
    }
    groups[workspace].push(session);
  });

  // 按最近更新时间排序每个分组内的会话
  Object.keys(groups).forEach(key => {
    groups[key].sort((a, b) => b.updatedAt - a.updatedAt);
  });

  return groups;
}

export const Sidebar: React.FC = () => {
  const { sidebarCollapsed, clearChat } = useAppStore();
  const isCoworkMode = useIsCoworkMode();
  const {
    sessions,
    currentSessionId,
    isLoading,
    createSession,
    switchSession,
    deleteSession,
    unreadSessionIds,
  } = useSessionStore();

  const [searchQuery, setSearchQuery] = useState('');
  const [hoveredSession, setHoveredSession] = useState<string | null>(null);
  const [appVersion, setAppVersion] = useState<string>('');
  const [collapsedWorkspaces, setCollapsedWorkspaces] = useState<Set<string>>(new Set());

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
    return sessions.filter(session =>
      session.title.toLowerCase().includes(searchQuery.toLowerCase())
    );
  }, [sessions, searchQuery]);

  // 按时间分组会话（开发者模式）
  const groupedByTime = useMemo(() => {
    const groups: Record<SessionGroup, SessionWithMeta[]> = {
      today: [],
      yesterday: [],
      week: [],
      month: [],
      older: [],
    };

    filteredSessions.forEach(session => {
      const group = getSessionGroup(session.updatedAt);
      groups[group].push(session);
    });

    return groups;
  }, [filteredSessions]);

  // 按工作空间分组会话（Cowork 模式）
  const groupedByWorkspace = useMemo(() => {
    return groupSessionsByWorkspace(filteredSessions);
  }, [filteredSessions]);

  // 切换工作空间折叠状态
  const toggleWorkspaceCollapse = (workspace: string) => {
    setCollapsedWorkspaces(prev => {
      const newSet = new Set(prev);
      if (newSet.has(workspace)) {
        newSet.delete(workspace);
      } else {
        newSet.add(workspace);
      }
      return newSet;
    });
  };

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
  const hasFilteredSessions = filteredSessions.length > 0;

  return (
    <div className="w-64 border-r border-zinc-800/50 flex flex-col bg-surface-950/80 backdrop-blur-sm">
      {/* New Chat Button */}
      <div className="p-3">
        <Button
          onClick={handleNewChat}
          loading={isLoading}
          variant="primary"
          fullWidth
          leftIcon={!isLoading ? <Plus className="w-4 h-4" /> : undefined}
          className="!rounded-xl"
        >
          新对话
        </Button>
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
        ) : isCoworkMode ? (
          // Cowork 模式：按工作空间分组
          <div className="space-y-3">
            {Object.entries(groupedByWorkspace).map(([workspace, workspaceSessions]) => {
              const isCollapsed = collapsedWorkspaces.has(workspace);
              const workspaceName = getWorkspaceName(workspace);

              return (
                <div key={workspace} className="animate-fadeIn">
                  {/* Workspace Header */}
                  <button
                    onClick={() => toggleWorkspaceCollapse(workspace)}
                    className="w-full flex items-center gap-2 px-2 py-2 text-xs font-medium text-zinc-400 hover:text-zinc-300 hover:bg-zinc-800/30 rounded-lg transition-colors"
                  >
                    <FolderOpen className="w-3.5 h-3.5 text-amber-400" />
                    <span className="flex-1 text-left truncate" title={workspace}>
                      {workspaceName}
                    </span>
                    <span className="text-zinc-600">{workspaceSessions.length}</span>
                    <div className={`transition-transform ${isCollapsed ? '' : 'rotate-90'}`}>
                      <Sparkles className="w-3 h-3 text-zinc-600" />
                    </div>
                  </button>

                  {/* Workspace Sessions */}
                  {!isCollapsed && (
                    <div className="space-y-0.5 mt-1 pl-2">
                      {workspaceSessions.map((session, index) => {
                        const isUnread = unreadSessionIds.has(session.id);
                        return (
                          <div
                            key={session.id}
                            onClick={() => handleSelectSession(session.id)}
                            onMouseEnter={() => setHoveredSession(session.id)}
                            onMouseLeave={() => setHoveredSession(null)}
                            style={{ animationDelay: `${index * 30}ms` }}
                            className={`group flex items-center gap-2 px-2 py-2 rounded-lg cursor-pointer transition-all duration-200 animate-slideUp ${
                              currentSessionId === session.id
                                ? 'bg-primary-500/10 text-zinc-100 border border-primary-500/20'
                                : isUnread
                                  ? 'bg-purple-500/10 text-zinc-100 border border-purple-500/20'
                                  : 'hover:bg-zinc-800/50 text-zinc-400 hover:text-zinc-200 border border-transparent'
                            }`}
                          >
                            <MessageSquare className={`w-3.5 h-3.5 shrink-0 ${
                              currentSessionId === session.id ? 'text-primary-400' :
                              isUnread ? 'text-purple-400' : 'text-zinc-500'
                            }`} />
                            <span className="text-sm truncate flex-1">{session.title}</span>
                            {isUnread && (
                              <div className="w-2 h-2 bg-purple-500 rounded-full animate-pulse" />
                            )}
                            <IconButton
                              icon={<Trash2 className="w-3 h-3" />}
                              aria-label="Delete session"
                              onClick={(e) => handleDeleteSession(session.id, e as unknown as React.MouseEvent)}
                              variant="danger"
                              size="sm"
                              className={`!p-1 transition-all duration-200 ${
                                hoveredSession === session.id ? 'opacity-100' : 'opacity-0'
                              }`}
                            />
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        ) : (
          // 开发者模式：按时间分组
          <div className="space-y-4">
            {(Object.keys(groupedByTime) as SessionGroup[]).map((group) => {
              const groupSessions = groupedByTime[group];
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
                    {groupSessions.map((session, index) => {
                      const isUnread = unreadSessionIds.has(session.id);
                      return (
                        <div
                          key={session.id}
                          onClick={() => handleSelectSession(session.id)}
                          onMouseEnter={() => setHoveredSession(session.id)}
                          onMouseLeave={() => setHoveredSession(null)}
                          style={{ animationDelay: `${index * 30}ms` }}
                          className={`group flex items-center gap-2.5 px-3 py-2.5 rounded-xl cursor-pointer transition-all duration-200 animate-slideUp ${
                            currentSessionId === session.id
                              ? 'bg-primary-500/10 text-zinc-100 border border-primary-500/20'
                              : isUnread
                                ? 'bg-purple-500/10 text-zinc-100 border border-purple-500/20'
                                : 'hover:bg-zinc-800/50 text-zinc-400 hover:text-zinc-200 border border-transparent'
                          }`}
                        >
                          <div className={`relative w-8 h-8 rounded-lg flex items-center justify-center shrink-0 transition-colors ${
                            currentSessionId === session.id
                              ? 'bg-primary-500/20 text-primary-400'
                              : isUnread
                                ? 'bg-purple-500/20 text-purple-400'
                                : 'bg-zinc-800/50 text-zinc-500 group-hover:text-zinc-400'
                          }`}>
                            <MessageSquare className="w-4 h-4" />
                            {/* 未读指示器 */}
                            {isUnread && (
                              <div className="absolute -top-0.5 -right-0.5 w-2.5 h-2.5 bg-purple-500 rounded-full border-2 border-surface-950 animate-pulse" />
                            )}
                          </div>
                          <div className="flex-1 min-w-0">
                            <span className={`text-sm truncate block font-medium ${isUnread ? 'text-zinc-100' : ''}`}>
                              {session.title}
                            </span>
                            {session.messageCount > 0 && (
                              <span className={`text-xs ${isUnread ? 'text-purple-400' : 'text-zinc-500'}`}>
                                {isUnread ? '有新消息' : `${session.messageCount} 条消息`}
                              </span>
                            )}
                          </div>
                          <IconButton
                            icon={<Trash2 className="w-3.5 h-3.5" />}
                            aria-label="Delete session"
                            onClick={(e) => handleDeleteSession(session.id, e as unknown as React.MouseEvent)}
                            variant="danger"
                            size="sm"
                            className={`transition-all duration-200 ${
                              hoveredSession === session.id ? 'opacity-100' : 'opacity-0'
                            }`}
                          />
                        </div>
                      );
                    })}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* Version */}
      <div className="p-3 border-t border-zinc-800/50">
        <div className="flex items-center justify-center">
          <div className="flex items-center gap-2 text-xs text-zinc-600">
            <div className="w-1.5 h-1.5 rounded-full bg-green-500 animate-pulse" />
            <span>Code Agent {appVersion ? `v${appVersion}` : ''}</span>
          </div>
        </div>
      </div>
    </div>
  );
};
