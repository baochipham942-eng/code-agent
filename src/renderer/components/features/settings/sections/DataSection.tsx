// ============================================================================
// DataSection - 数据设置（使用统计、记忆搜索、清理缓存）
// ============================================================================

import React, { useState, useEffect } from 'react';
import {
  RefreshCw,
  CheckCircle,
  AlertCircle,
  Loader2,
  MessageSquare,
  Database,
  FileCode,
  Brain,
  Search,
  Trash2,
} from 'lucide-react';
import { Button, Input } from '../../../primitives';
import { IPC_CHANNELS } from '@shared/ipc';
import type { MemoryStats, SearchResult } from '@shared/ipc';
import { createLogger } from '../../../../utils/logger';

const logger = createLogger('DataSection');

// ============================================================================
// Types
// ============================================================================

export interface DataStats {
  sessionCount: number;
  messageCount: number;
  toolExecutionCount: number;
  knowledgeCount: number;
  databaseSize: number;
  cacheEntries: number;
}

// ============================================================================
// Component
// ============================================================================

export const DataSection: React.FC = () => {
  const [stats, setStats] = useState<DataStats | null>(null);
  const [memoryStats, setMemoryStats] = useState<MemoryStats | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isClearing, setIsClearing] = useState(false);
  const [message, setMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null);

  // Memory search
  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState<SearchResult[]>([]);
  const [isSearching, setIsSearching] = useState(false);

  const loadStats = async () => {
    try {
      const [dataStats, memStats] = await Promise.all([
        window.electronAPI?.invoke(IPC_CHANNELS.DATA_GET_STATS),
        window.electronAPI?.invoke(IPC_CHANNELS.MEMORY_GET_STATS),
      ]);
      if (dataStats) setStats(dataStats);
      if (memStats) setMemoryStats(memStats);
    } catch (error) {
      logger.error('Failed to load data stats', error);
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    loadStats();
  }, []);

  const handleClearCache = async () => {
    setIsClearing(true);
    setMessage(null);
    try {
      const cleared = await window.electronAPI?.invoke(IPC_CHANNELS.DATA_CLEAR_TOOL_CACHE);
      if (cleared === 0) {
        setMessage({ type: 'success', text: '缓存已经是空的' });
      } else {
        setMessage({ type: 'success', text: `已清理 ${cleared} 条缓存` });
      }
      await loadStats();
    } catch {
      setMessage({ type: 'error', text: '清理失败' });
    } finally {
      setIsClearing(false);
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

  // Format file size
  const formatSize = (bytes: number): string => {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  };

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-8">
        <Loader2 className="w-5 h-5 animate-spin text-zinc-400" />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Usage Stats */}
      <div>
        <h4 className="text-sm font-medium text-zinc-100 mb-3">使用统计</h4>
        <div className="grid grid-cols-4 gap-3">
          <StatCard
            icon={<MessageSquare className="w-4 h-4" />}
            label="会话"
            value={stats?.sessionCount || 0}
            color="text-blue-400"
          />
          <StatCard
            icon={<MessageSquare className="w-4 h-4" />}
            label="消息"
            value={stats?.messageCount || 0}
            color="text-green-400"
          />
          <StatCard
            icon={<Database className="w-4 h-4" />}
            label="数据库"
            value={formatSize(stats?.databaseSize || 0)}
            color="text-purple-400"
          />
          <StatCard
            icon={<FileCode className="w-4 h-4" />}
            label="向量"
            value={memoryStats?.vectorStoreSize || 0}
            color="text-orange-400"
          />
        </div>
      </div>

      {/* Memory Search */}
      <div>
        <h4 className="text-sm font-medium text-zinc-100 mb-3 flex items-center gap-2">
          <Brain className="w-4 h-4 text-cyan-400" />
          记忆搜索
        </h4>
        <div className="flex gap-2">
          <div className="flex-1 relative">
            <Input
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && handleSearch()}
              placeholder="搜索知识库..."
              leftIcon={<Search className="w-4 h-4" />}
            />
          </div>
          <Button
            onClick={handleSearch}
            loading={isSearching}
            disabled={!searchQuery.trim()}
            variant="secondary"
            size="md"
          >
            搜索
          </Button>
        </div>

        {/* Search Results */}
        {searchResults.length > 0 && (
          <div className="mt-3 space-y-2 max-h-40 overflow-y-auto">
            {searchResults.map((result) => (
              <div
                key={result.id}
                className="p-2 bg-zinc-800/50 rounded text-xs"
              >
                <div className="flex items-center gap-1.5 mb-1">
                  {result.metadata.source === 'file' ? (
                    <FileCode className="w-3 h-3 text-blue-400" />
                  ) : result.metadata.source === 'conversation' ? (
                    <MessageSquare className="w-3 h-3 text-green-400" />
                  ) : (
                    <Brain className="w-3 h-3 text-purple-400" />
                  )}
                  <span className="text-zinc-400 truncate">
                    {result.metadata.path?.split('/').pop() || result.metadata.category || result.metadata.source}
                  </span>
                  <span className="ml-auto text-zinc-500">
                    {Math.round(result.score * 100)}%
                  </span>
                </div>
                <p className="text-zinc-300 line-clamp-2">{result.content}</p>
              </div>
            ))}
          </div>
        )}

        {searchQuery && searchResults.length === 0 && !isSearching && (
          <p className="text-xs text-zinc-500 text-center py-3 mt-2">未找到结果</p>
        )}
      </div>

      {/* Clear Cache */}
      <div>
        <h4 className="text-sm font-medium text-zinc-100 mb-3 flex items-center gap-2">
          <Trash2 className="w-4 h-4 text-zinc-400" />
          清理缓存
        </h4>
        <p className="text-xs text-zinc-500 mb-3">
          清理工具调用的临时缓存（文件读取、搜索结果），不影响会话和数据。
        </p>
        <Button
          onClick={handleClearCache}
          loading={isClearing}
          variant="secondary"
          fullWidth
          leftIcon={!isClearing ? <RefreshCw className="w-4 h-4" /> : undefined}
        >
          清空缓存 {(stats?.cacheEntries || 0) > 0 && `(${stats?.cacheEntries} 条)`}
        </Button>

        {/* Message */}
        {message && (
          <div className={`flex items-center gap-2 p-2 rounded-lg mt-3 text-xs ${
            message.type === 'success' ? 'bg-emerald-500/10 text-emerald-400' : 'bg-red-500/10 text-red-400'
          }`}>
            {message.type === 'success' ? <CheckCircle className="w-3.5 h-3.5" /> : <AlertCircle className="w-3.5 h-3.5" />}
            <span>{message.text}</span>
          </div>
        )}
      </div>
    </div>
  );
};

// Stat card component
const StatCard: React.FC<{
  icon: React.ReactNode;
  label: string;
  value: string | number;
  color: string;
}> = ({ icon, label, value, color }) => (
  <div className="p-3 rounded-lg bg-zinc-800/50">
    <div className="flex items-center gap-1.5 mb-1">
      <span className={color}>{icon}</span>
      <span className="text-xs text-zinc-500">{label}</span>
    </div>
    <span className="text-lg font-semibold text-zinc-200">{value}</span>
  </div>
);
