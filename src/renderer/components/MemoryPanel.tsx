// ============================================================================
// MemoryPanel - Memory & Knowledge Statistics Panel (Gen 5)
// ============================================================================

import React, { useState, useEffect } from 'react';
import {
  Brain,
  Database,
  FileCode,
  MessageSquare,
  RefreshCw,
  Search,
  ChevronDown,
  ChevronUp,
  X,
  Sparkles,
  CheckCircle,
} from 'lucide-react';
import { IPC_CHANNELS } from '@shared/ipc';
import type { MemoryStats, SearchResult } from '@shared/ipc';
import type { MemoryLearnedData } from '@shared/types';
import { UI } from '@shared/constants';
import { createLogger } from '../utils/logger';
import { useMemoryEvents } from '../hooks/useMemoryEvents';

const logger = createLogger('MemoryPanel');

interface MemoryPanelProps {
  isVisible?: boolean;
  onClose?: () => void;
}

export const MemoryPanel: React.FC<MemoryPanelProps> = ({ isVisible = true, onClose }) => {
  const [stats, setStats] = useState<MemoryStats | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState<SearchResult[]>([]);
  const [isSearching, setIsSearching] = useState(false);
  const [expandedSections, setExpandedSections] = useState({
    stats: true,
    learning: true,
    search: false,
  });

  // 记忆学习事件记录
  const [learningEvents, setLearningEvents] = useState<Array<MemoryLearnedData & { timestamp: number }>>([]);

  // 监听记忆学习事件
  useMemoryEvents({
    onMemoryLearned: (data) => {
      logger.info('Memory learned event received in panel', {
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

  // Load stats on mount and periodically
  useEffect(() => {
    if (isVisible) {
      loadStats();
      const interval = setInterval(loadStats, UI.PANEL_REFRESH_INTERVAL);
      return () => clearInterval(interval);
    }
  }, [isVisible]);

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

  const toggleSection = (section: keyof typeof expandedSections) => {
    setExpandedSections((prev) => ({
      ...prev,
      [section]: !prev[section],
    }));
  };

  const formatTimeAgo = (timestamp: number): string => {
    const diff = Date.now() - timestamp;
    if (diff < 60000) return '刚刚';
    if (diff < 3600000) return `${Math.floor(diff / 60000)} 分钟前`;
    if (diff < 86400000) return `${Math.floor(diff / 3600000)} 小时前`;
    return `${Math.floor(diff / 86400000)} 天前`;
  };

  if (!isVisible) return null;

  return (
    <div className="w-72 border-l border-zinc-800 bg-zinc-900/50 flex flex-col">
      {/* Header */}
      <div className="p-3 border-b border-zinc-800">
        <div className="flex items-center gap-2">
          <Brain className="w-4 h-4 text-cyan-400" />
          <span className="text-sm font-medium text-zinc-100">Memory</span>
          <span className="text-xs text-zinc-500 ml-auto">Gen 5</span>
          <button
            onClick={loadStats}
            disabled={isLoading}
            className="p-1 hover:bg-zinc-700 rounded transition-colors"
            title="刷新统计"
          >
            <RefreshCw className={`w-3.5 h-3.5 text-zinc-400 ${isLoading ? 'animate-spin' : ''}`} />
          </button>
          {onClose && (
            <button
              onClick={onClose}
              className="p-1 hover:bg-zinc-700 rounded transition-colors"
              title="关闭面板"
            >
              <X className="w-3.5 h-3.5 text-zinc-400" />
            </button>
          )}
        </div>
      </div>

      <div className="flex-1 overflow-y-auto">
        {/* Stats Section */}
        <div className="border-b border-zinc-800">
          <button
            onClick={() => toggleSection('stats')}
            className="w-full p-3 flex items-center justify-between hover:bg-zinc-800/50 transition-colors"
          >
            <div className="flex items-center gap-2">
              <Database className="w-3.5 h-3.5 text-zinc-400" />
              <span className="text-sm text-zinc-300">统计</span>
            </div>
            {expandedSections.stats ? (
              <ChevronUp className="w-3.5 h-3.5 text-zinc-500" />
            ) : (
              <ChevronDown className="w-3.5 h-3.5 text-zinc-500" />
            )}
          </button>

          {expandedSections.stats && stats && (
            <div className="p-3 pt-0 space-y-3">
              <StatItem
                icon={<MessageSquare className="w-3.5 h-3.5" />}
                label="会话"
                value={stats.sessionCount}
                color="text-blue-400"
              />
              <StatItem
                icon={<MessageSquare className="w-3.5 h-3.5" />}
                label="消息"
                value={stats.messageCount}
                color="text-green-400"
              />
              <StatItem
                icon={<Database className="w-3.5 h-3.5" />}
                label="向量存储"
                value={`${stats.vectorStoreSize} 文档`}
                color="text-purple-400"
              />
              <StatItem
                icon={<FileCode className="w-3.5 h-3.5" />}
                label="项目知识"
                value={stats.projectKnowledgeCount}
                color="text-orange-400"
              />
              <StatItem
                icon={<Database className="w-3.5 h-3.5" />}
                label="工具缓存"
                value={`${stats.toolCacheSize} 条`}
                color="text-cyan-400"
              />
            </div>
          )}
        </div>

        {/* Learning Events Section */}
        <div className="border-b border-zinc-800">
          <button
            onClick={() => toggleSection('learning')}
            className="w-full p-3 flex items-center justify-between hover:bg-zinc-800/50 transition-colors"
          >
            <div className="flex items-center gap-2">
              <Sparkles className="w-3.5 h-3.5 text-amber-400" />
              <span className="text-sm text-zinc-300">学习记录</span>
              {learningEvents.length > 0 && (
                <span className="px-1.5 py-0.5 text-xs rounded-full bg-amber-500/20 text-amber-300">
                  {learningEvents.length}
                </span>
              )}
            </div>
            {expandedSections.learning ? (
              <ChevronUp className="w-3.5 h-3.5 text-zinc-500" />
            ) : (
              <ChevronDown className="w-3.5 h-3.5 text-zinc-500" />
            )}
          </button>

          {expandedSections.learning && (
            <div className="p-3 pt-0 space-y-2">
              {learningEvents.length === 0 ? (
                <p className="text-xs text-zinc-500 text-center py-2">
                  暂无学习记录
                </p>
              ) : (
                learningEvents.map((event, index) => (
                  <LearningEventItem key={index} event={event} formatTimeAgo={formatTimeAgo} />
                ))
              )}
            </div>
          )}
        </div>

        {/* Search Section */}
        <div className="border-b border-zinc-800">
          <button
            onClick={() => toggleSection('search')}
            className="w-full p-3 flex items-center justify-between hover:bg-zinc-800/50 transition-colors"
          >
            <div className="flex items-center gap-2">
              <Search className="w-3.5 h-3.5 text-zinc-400" />
              <span className="text-sm text-zinc-300">搜索记忆</span>
            </div>
            {expandedSections.search ? (
              <ChevronUp className="w-3.5 h-3.5 text-zinc-500" />
            ) : (
              <ChevronDown className="w-3.5 h-3.5 text-zinc-500" />
            )}
          </button>

          {expandedSections.search && (
            <div className="p-3 pt-0 space-y-3">
              {/* Search Input */}
              <div className="flex gap-2">
                <input
                  type="text"
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  onKeyDown={(e) => e.key === 'Enter' && handleSearch()}
                  placeholder="搜索知识库..."
                  className="flex-1 px-2 py-1.5 text-sm bg-zinc-800 border border-zinc-700 rounded focus:outline-none focus:border-cyan-500 text-zinc-100 placeholder-zinc-500"
                />
                <button
                  onClick={handleSearch}
                  disabled={isSearching || !searchQuery.trim()}
                  className="px-2 py-1.5 bg-cyan-600 hover:bg-cyan-500 disabled:bg-zinc-700 rounded text-white text-sm transition-colors"
                >
                  {isSearching ? <RefreshCw className="w-3.5 h-3.5 animate-spin" /> : <Search className="w-3.5 h-3.5" />}
                </button>
              </div>

              {/* Search Results */}
              {searchResults.length > 0 && (
                <div className="space-y-2">
                  {searchResults.map((result) => (
                    <SearchResultItem key={result.id} result={result} />
                  ))}
                </div>
              )}

              {searchQuery && searchResults.length === 0 && !isSearching && (
                <p className="text-xs text-zinc-500 text-center py-2">
                  未找到结果
                </p>
              )}
            </div>
          )}
        </div>

        {/* Info Section */}
        <div className="p-3 text-xs text-zinc-500">
          <p>记忆系统跨会话存储知识。</p>
          <p className="mt-1">使用 memory_store、memory_search 和 code_index 工具与其交互。</p>
        </div>
      </div>
    </div>
  );
};

// Stat item component
const StatItem: React.FC<{
  icon: React.ReactNode;
  label: string;
  value: string | number;
  color: string;
}> = ({ icon, label, value, color }) => (
  <div className="flex items-center justify-between">
    <div className="flex items-center gap-2">
      <span className={color}>{icon}</span>
      <span className="text-sm text-zinc-400">{label}</span>
    </div>
    <span className="text-sm font-medium text-zinc-200">{value}</span>
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
