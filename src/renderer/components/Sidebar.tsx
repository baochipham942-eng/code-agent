// ============================================================================
// Sidebar - Chat History and Navigation
// ============================================================================

import React, { useEffect } from 'react';
import { useSessionStore, initializeSessionStore } from '../stores/sessionStore';
import { useAppStore } from '../stores/appStore';
import { MessageSquare, Plus, Trash2, Loader2 } from 'lucide-react';

export const Sidebar: React.FC = () => {
  const { sidebarCollapsed, clearChat } = useAppStore();
  const {
    sessions,
    currentSessionId,
    isLoading,
    createSession,
    switchSession,
    deleteSession,
  } = useSessionStore();

  // 初始化：加载会话列表
  useEffect(() => {
    initializeSessionStore();
  }, []);

  const handleNewChat = async () => {
    await createSession('New Chat');
    clearChat(); // 清空 appStore 中的旧数据
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

  return (
    <div className="w-64 border-r border-zinc-800 flex flex-col bg-zinc-900/50">
      {/* New Chat Button */}
      <div className="p-3">
        <button
          onClick={handleNewChat}
          disabled={isLoading}
          className="w-full flex items-center justify-center gap-2 px-3 py-2 rounded-lg bg-blue-600 hover:bg-blue-500 disabled:opacity-50 disabled:cursor-not-allowed text-white transition-colors"
        >
          {isLoading ? (
            <Loader2 className="w-4 h-4 animate-spin" />
          ) : (
            <Plus className="w-4 h-4" />
          )}
          <span className="text-sm font-medium">New Chat</span>
        </button>
      </div>

      {/* Chat History */}
      <div className="flex-1 overflow-y-auto px-2 pb-2">
        <div className="text-xs font-medium text-zinc-500 px-2 py-2">
          Recent Chats
        </div>

        {isLoading && sessions.length === 0 ? (
          <div className="flex items-center justify-center py-8">
            <Loader2 className="w-5 h-5 animate-spin text-zinc-500" />
          </div>
        ) : sessions.length === 0 ? (
          <div className="text-sm text-zinc-500 text-center py-4">
            No chats yet
          </div>
        ) : (
          <div className="space-y-1">
            {sessions.map((session) => (
              <div
                key={session.id}
                onClick={() => handleSelectSession(session.id)}
                className={`group flex items-center gap-2 px-3 py-2 rounded-lg cursor-pointer transition-colors ${
                  currentSessionId === session.id
                    ? 'bg-zinc-800 text-zinc-100'
                    : 'hover:bg-zinc-800/50 text-zinc-400 hover:text-zinc-200'
                }`}
              >
                <MessageSquare className="w-4 h-4 shrink-0" />
                <div className="flex-1 min-w-0">
                  <span className="text-sm truncate block">{session.title}</span>
                  {session.messageCount > 0 && (
                    <span className="text-xs text-zinc-500">
                      {session.messageCount} messages
                    </span>
                  )}
                </div>
                <button
                  onClick={(e) => handleDeleteSession(session.id, e)}
                  className="opacity-0 group-hover:opacity-100 p-1 rounded hover:bg-zinc-700 text-zinc-500 hover:text-red-400 transition-all"
                >
                  <Trash2 className="w-3 h-3" />
                </button>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Footer */}
      <div className="p-3 border-t border-zinc-800">
        <div className="text-xs text-zinc-500 text-center">
          Code Agent v0.1.0
        </div>
      </div>
    </div>
  );
};
