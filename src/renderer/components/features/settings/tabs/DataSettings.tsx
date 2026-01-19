// ============================================================================
// DataSettings - Data Management Tab (originally CacheSettings)
// ============================================================================

import React, { useState, useEffect } from 'react';
import { RefreshCw, CheckCircle, AlertCircle, Loader2 } from 'lucide-react';
import { Button } from '../../../primitives';
import { IPC_CHANNELS } from '@shared/ipc';

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

export const DataSettings: React.FC = () => {
  const [stats, setStats] = useState<DataStats | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isClearing, setIsClearing] = useState(false);
  const [message, setMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null);

  const loadStats = async () => {
    try {
      const dataStats = await window.electronAPI?.invoke(IPC_CHANNELS.DATA_GET_STATS);
      if (dataStats) setStats(dataStats);
    } catch (error) {
      console.error('Failed to load data stats:', error);
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    loadStats();
  }, []);

  const handleClearToolCache = async () => {
    setIsClearing(true);
    setMessage(null);
    try {
      const cleared = await window.electronAPI?.invoke(IPC_CHANNELS.DATA_CLEAR_TOOL_CACHE);
      if (cleared === 0) {
        setMessage({ type: 'success', text: '缓存已经是空的' });
      } else {
        setMessage({ type: 'success', text: `已清理 ${cleared} 条工具调用缓存` });
      }
      await loadStats();
    } catch (error) {
      setMessage({ type: 'error', text: '清理失败' });
    } finally {
      setIsClearing(false);
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
      <div className="flex items-center justify-center h-48">
        <Loader2 className="w-6 h-6 animate-spin text-zinc-400" />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div>
        <h3 className="text-sm font-medium text-zinc-100 mb-2">数据管理</h3>
        <p className="text-xs text-zinc-400 mb-4">
          查看应用数据使用情况。会话、消息和生成的文件不会被清理。
        </p>
      </div>

      {/* Data Stats Grid */}
      <div className="grid grid-cols-2 gap-4">
        <div className="bg-zinc-800/50 rounded-lg p-4">
          <div className="text-2xl font-bold text-zinc-100">{stats?.sessionCount || 0}</div>
          <div className="text-xs text-zinc-400">会话数</div>
        </div>
        <div className="bg-zinc-800/50 rounded-lg p-4">
          <div className="text-2xl font-bold text-zinc-100">{stats?.messageCount || 0}</div>
          <div className="text-xs text-zinc-400">消息数</div>
        </div>
        <div className="bg-zinc-800/50 rounded-lg p-4">
          <div className="text-2xl font-bold text-indigo-400">{formatSize(stats?.databaseSize || 0)}</div>
          <div className="text-xs text-zinc-400">数据库大小</div>
        </div>
        <div className="bg-zinc-800/50 rounded-lg p-4">
          <div className="text-2xl font-bold text-cyan-400">{stats?.cacheEntries || 0}</div>
          <div className="text-xs text-zinc-400">内存缓存条目</div>
        </div>
      </div>

      {/* Detailed Stats */}
      <div className="bg-zinc-800/50 rounded-lg p-4">
        <h4 className="text-sm font-medium text-zinc-100 mb-3">详细数据</h4>
        <div className="space-y-2 text-xs">
          <div className="flex justify-between text-zinc-400">
            <span>工具执行记录</span>
            <span className="text-zinc-300">{stats?.toolExecutionCount || 0} 条</span>
          </div>
          <div className="flex justify-between text-zinc-400">
            <span>项目知识库</span>
            <span className="text-zinc-300">{stats?.knowledgeCount || 0} 条</span>
          </div>
        </div>
      </div>

      {/* Cache Info & Clear Button */}
      <div className="bg-zinc-800/50 rounded-lg p-4">
        <h4 className="text-sm font-medium text-zinc-100 mb-3">可清理的缓存</h4>
        <p className="text-xs text-zinc-400 mb-3">
          工具调用的临时缓存（如文件读取、搜索结果）可以安全清理，不会影响您的会话和数据。
        </p>
        <Button
          onClick={handleClearToolCache}
          loading={isClearing}
          variant="secondary"
          fullWidth
          leftIcon={!isClearing ? <RefreshCw className="w-4 h-4" /> : undefined}
        >
          清空缓存 {(stats?.cacheEntries || 0) > 0 && `(${stats?.cacheEntries} 条)`}
        </Button>
      </div>

      {/* Message */}
      {message && (
        <div className={`flex items-center gap-2 p-3 rounded-lg ${
          message.type === 'success' ? 'bg-green-500/10 text-green-400' : 'bg-red-500/10 text-red-400'
        }`}>
          {message.type === 'success' ? <CheckCircle className="w-4 h-4" /> : <AlertCircle className="w-4 h-4" />}
          <span className="text-sm">{message.text}</span>
        </div>
      )}
    </div>
  );
};
