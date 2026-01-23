// ============================================================================
// MemorySettings - Memory & Knowledge Management Tab (Gen 5)
// ============================================================================

import React, { useState, useEffect } from 'react';
import {
  Brain,
  Database,
  FileCode,
  MessageSquare,
  RefreshCw,
  Search,
  Sparkles,
  CheckCircle,
} from 'lucide-react';
import { IPC_CHANNELS } from '@shared/ipc';
import type { MemoryStats, SearchResult } from '@shared/ipc';
import type { MemoryLearnedData } from '@shared/types';
import { UI } from '@shared/constants';
import { createLogger } from '../../../../utils/logger';
import { useMemoryEvents } from '../../../../hooks/useMemoryEvents';

const logger = createLogger('MemorySettings');

export const MemorySettings: React.FC = () => {
  const [stats, setStats] = useState<MemoryStats | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState<SearchResult[]>([]);
  const [isSearching, setIsSearching] = useState(false);

  // 记忆学习事件记录
  const [learningEvents, setLearningEvents] = useState<Array<MemoryLearnedData & { timestamp: number }>>([]);

  // 监听记忆学习事件
  useMemoryEvents({
    onMemoryLearned: (data) => {
      logger.info('Memory learned event received', {
        sessionId: data.sessionId,
        knowledgeExtracted: data.knowledgeExtracted,
        codeStylesLearned: data.codeStylesLearned,
        toolPreferencesUpdated: data.toolPreferencesUpdated,
      });
      setLearningEvents((prev) => [
        { ...data, timestamp: Date.now() },
        ...prev.slice(0, 9), // 保留最近 10 条
      ]);
      // 学习后刷新统计
      loadStats();
    },
  });

  // Load stats on mount
  useEffect(() => {
    loadStats();
    const interval = setInterval(loadStats, UI.PANEL_REFRESH_INTERVAL);
    return () => clearInterval(interval);
  }, []);

  const loadStats = async () => {
    setIsLoading(true);
    try {
      const result = await window.electronAPI?.invoke(IPC_CHANNELS.MEMORY_GET_STATS);
      if (result) {
        setStats(result);
      }
    } catch (error) {
      logger.error('Failed to load memory stats', error);
    } finally {
      setIsLoading(false);
    }
  };

  const handleSearch = async () => {
    if (!searchQuery.trim()) return;

    setIsSearching(true);
    try {
      const [codeResults, convResults] = await Promise.all([
        window.electronAPI?.invoke(IPC_CHANNELS.MEMORY_SEARCH_CODE, searchQuery, 3),
        window.electronAPI?.invoke(IPC_CHANNELS.MEMORY_SEARCH_CONVERSATIONS, searchQuery, 3),
      ]);

      const combined = [
        ...(codeResults || []),
        ...(convResults || []),
      ].sort((a, b) => b.score - a.score);

      setSearchResults(combined);
    } catch (error) {
      logger.error('Search failed', error);
    } finally {
      setIsSearching(false);
    }
  };

  const formatTimeAgo = (timestamp: number): string => {
    const diff = Date.now() - timestamp;
    if (diff < 60000) return '刚刚';
    if (diff < 3600000) return `${Math.floor(diff / 60000)} 分钟前`;
    if (diff < 86400000) return `${Math.floor(diff / 3600000)} 小时前`;
    return `${Math.floor(diff / 86400000)} 天前`;
  };

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Brain className="w-5 h-5 text-cyan-400" />
          <h3 className="text-lg font-medium text-zinc-100">记忆管理</h3>
          <span className="text-xs text-zinc-500">Gen 5</span>
        </div>
        <button
          onClick={loadStats}
          disabled={isLoading}
          className="flex items-center gap-1.5 px-2 py-1 text-xs text-zinc-400 hover:text-zinc-200 hover:bg-zinc-800 rounded transition-colors"
        >
          <RefreshCw className={`w-3.5 h-3.5 ${isLoading ? 'animate-spin' : ''}`} />
          刷新
        </button>
      </div>

      {/* Stats Grid */}
      {stats && (
        <div className="grid grid-cols-2 gap-3">
          <StatCard
            icon={<MessageSquare className="w-4 h-4" />}
            label="会话"
            value={stats.sessionCount}
            color="text-blue-400"
            bgColor="bg-blue-500/10"
          />
          <StatCard
            icon={<MessageSquare className="w-4 h-4" />}
            label="消息"
            value={stats.messageCount}
            color="text-green-400"
            bgColor="bg-green-500/10"
          />
          <StatCard
            icon={<Database className="w-4 h-4" />}
            label="向量存储"
            value={`${stats.vectorStoreSize} 文档`}
            color="text-purple-400"
            bgColor="bg-purple-500/10"
          />
          <StatCard
            icon={<FileCode className="w-4 h-4" />}
            label="项目知识"
            value={stats.projectKnowledgeCount}
            color="text-orange-400"
            bgColor="bg-orange-500/10"
          />
        </div>
      )}

      {/* Learning Events */}
      <div>
        <div className="flex items-center gap-2 mb-3">
          <Sparkles className="w-4 h-4 text-amber-400" />
          <span className="text-sm font-medium text-zinc-300">学习记录</span>
          {learningEvents.length > 0 && (
            <span className="px-1.5 py-0.5 text-xs rounded-full bg-amber-500/20 text-amber-300">
              {learningEvents.length}
            </span>
          )}
        </div>
        <div className="space-y-2 max-h-40 overflow-y-auto">
          {learningEvents.length === 0 ? (
            <p className="text-xs text-zinc-500 text-center py-3 bg-zinc-800/30 rounded">
              暂无学习记录，会话结束后会自动学习
            </p>
          ) : (
            learningEvents.map((event, index) => (
              <LearningEventItem key={index} event={event} formatTimeAgo={formatTimeAgo} />
            ))
          )}
        </div>
      </div>

      {/* Search */}
      <div>
        <div className="flex items-center gap-2 mb-3">
          <Search className="w-4 h-4 text-zinc-400" />
          <span className="text-sm font-medium text-zinc-300">搜索记忆</span>
        </div>
        <div className="flex gap-2">
          <input
            type="text"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && handleSearch()}
            placeholder="搜索知识库..."
            className="flex-1 px-3 py-2 text-sm bg-zinc-800 border border-zinc-700 rounded-lg focus:outline-none focus:border-cyan-500 text-zinc-100 placeholder-zinc-500"
          />
          <button
            onClick={handleSearch}
            disabled={isSearching || !searchQuery.trim()}
            className="px-3 py-2 bg-cyan-600 hover:bg-cyan-500 disabled:bg-zinc-700 disabled:text-zinc-500 rounded-lg text-white text-sm transition-colors"
          >
            {isSearching ? <RefreshCw className="w-4 h-4 animate-spin" /> : '搜索'}
          </button>
        </div>

        {/* Search Results */}
        {searchResults.length > 0 && (
          <div className="mt-3 space-y-2 max-h-48 overflow-y-auto">
            {searchResults.map((result) => (
              <SearchResultItem key={result.id} result={result} />
            ))}
          </div>
        )}

        {searchQuery && searchResults.length === 0 && !isSearching && (
          <p className="text-xs text-zinc-500 text-center py-3 mt-2">
            未找到结果
          </p>
        )}
      </div>

      {/* Info */}
      <p className="text-xs text-zinc-500">
        记忆系统跨会话存储知识，使用 memory_store、memory_search 和 code_index 工具交互。
      </p>
    </div>
  );
};

// Stat card component
const StatCard: React.FC<{
  icon: React.ReactNode;
  label: string;
  value: string | number;
  color: string;
  bgColor: string;
}> = ({ icon, label, value, color, bgColor }) => (
  <div className={`p-3 rounded-lg ${bgColor}`}>
    <div className="flex items-center gap-2 mb-1">
      <span className={color}>{icon}</span>
      <span className="text-xs text-zinc-400">{label}</span>
    </div>
    <span className="text-lg font-semibold text-zinc-200">{value}</span>
  </div>
);

// Learning event item component
const LearningEventItem: React.FC<{
  event: MemoryLearnedData & { timestamp: number };
  formatTimeAgo: (timestamp: number) => string;
}> = ({ event, formatTimeAgo }) => {
  const totalLearned = event.knowledgeExtracted + event.codeStylesLearned + event.toolPreferencesUpdated;

  return (
    <div className="p-2 bg-zinc-800/50 rounded text-xs">
      <div className="flex items-center gap-1 mb-1">
        <CheckCircle className="w-3 h-3 text-emerald-400" />
        <span className="text-zinc-300 font-medium">会话学习完成</span>
        <span className="ml-auto text-zinc-500">{formatTimeAgo(event.timestamp)}</span>
      </div>
      <div className="flex flex-wrap gap-2 mt-1">
        {event.knowledgeExtracted > 0 && (
          <span className="px-1.5 py-0.5 rounded bg-cyan-500/20 text-cyan-300">
            知识 +{event.knowledgeExtracted}
          </span>
        )}
        {event.codeStylesLearned > 0 && (
          <span className="px-1.5 py-0.5 rounded bg-purple-500/20 text-purple-300">
            代码风格 +{event.codeStylesLearned}
          </span>
        )}
        {event.toolPreferencesUpdated > 0 && (
          <span className="px-1.5 py-0.5 rounded bg-amber-500/20 text-amber-300">
            工具偏好 +{event.toolPreferencesUpdated}
          </span>
        )}
        {totalLearned === 0 && (
          <span className="text-zinc-500">无新内容</span>
        )}
      </div>
    </div>
  );
};

// Search result item component
const SearchResultItem: React.FC<{ result: SearchResult }> = ({ result }) => {
  const getSourceIcon = () => {
    switch (result.metadata.source) {
      case 'file':
        return <FileCode className="w-3 h-3 text-blue-400" />;
      case 'conversation':
        return <MessageSquare className="w-3 h-3 text-green-400" />;
      case 'knowledge':
        return <Brain className="w-3 h-3 text-purple-400" />;
      default:
        return <Database className="w-3 h-3 text-zinc-400" />;
    }
  };

  const getSourceLabel = () => {
    if (result.metadata.path) {
      return result.metadata.path.split('/').pop();
    }
    if (result.metadata.category) {
      return result.metadata.category;
    }
    return result.metadata.source;
  };

  return (
    <div className="p-2 bg-zinc-800/50 rounded text-xs">
      <div className="flex items-center gap-1 mb-1">
        {getSourceIcon()}
        <span className="text-zinc-400 truncate">{getSourceLabel()}</span>
        <span className="ml-auto text-zinc-500">
          {Math.round(result.score * 100)}%
        </span>
      </div>
      <p className="text-zinc-300 line-clamp-2">{result.content}</p>
    </div>
  );
};
