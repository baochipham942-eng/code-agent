// ============================================================================
// DataSettings - Data Management Tab (originally CacheSettings)
// ============================================================================

import React, { useState, useEffect } from 'react';
import { RefreshCw, CheckCircle, AlertCircle, Loader2 } from 'lucide-react';
import { Button } from '../../../primitives';
import { SettingsPage, SettingsSection } from '../SettingsLayout';
import { IPC_DOMAINS } from '@shared/ipc';
import { createLogger } from '../../../../utils/logger';
import { isWebMode } from '../../../../utils/platform';
import { WebModeBanner } from '../WebModeBanner';
import ipcService from '../../../../services/ipcService';

const logger = createLogger('DataSettings');

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

interface SnapshotStats {
  snapshotCount: number;
  sessionCount: number;
  totalBytes: number;
  retentionDays: number;
}

const RETENTION_OPTIONS: Array<{ value: number; label: string }> = [
  { value: 1, label: '1 天' },
  { value: 7, label: '7 天' },
  { value: 30, label: '30 天' },
  { value: -1, label: '永久' },
];

export const DataSettings: React.FC = () => {
  const [stats, setStats] = useState<DataStats | null>(null);
  const [snapshotStats, setSnapshotStats] = useState<SnapshotStats | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isClearing, setIsClearing] = useState(false);
  const [isClearingSnapshots, setIsClearingSnapshots] = useState(false);
  const [message, setMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null);

  const loadStats = async () => {
    try {
      const [dataStats, snapStats] = await Promise.all([
        ipcService.invokeDomain<DataStats>(IPC_DOMAINS.DATA, 'getStats'),
        ipcService.invokeDomain<SnapshotStats>(IPC_DOMAINS.DATA, 'getSnapshotStats'),
      ]);
      if (dataStats) setStats(dataStats);
      if (snapStats) setSnapshotStats(snapStats);
    } catch (error) {
      logger.error('Failed to load data stats', error);
    } finally {
      setIsLoading(false);
    }
  };

  const handleClearSnapshots = async () => {
    setIsClearingSnapshots(true);
    setMessage(null);
    try {
      const cleared = await ipcService.invokeDomain<number>(IPC_DOMAINS.DATA, 'clearSnapshots', {});
      setMessage({
        type: 'success',
        text: cleared && cleared > 0 ? `已清空 ${cleared} 条调试快照` : '没有可清理的快照',
      });
      await loadStats();
    } catch {
      setMessage({ type: 'error', text: '清理失败' });
    } finally {
      setIsClearingSnapshots(false);
    }
  };

  const handleRetentionChange = async (days: number) => {
    try {
      await ipcService.invokeDomain(IPC_DOMAINS.DATA, 'setSnapshotRetention', { days });
      await loadStats();
    } catch (error) {
      logger.error('Failed to set retention', error);
    }
  };

  useEffect(() => {
    loadStats();
  }, []);

  const handleClearToolCache = async () => {
    setIsClearing(true);
    setMessage(null);
    try {
      const cleared = await ipcService.invokeDomain<number>(IPC_DOMAINS.DATA, 'clearToolCache');
      if (cleared === 0) {
        setMessage({ type: 'success', text: '缓存已经是空的' });
      } else {
        setMessage({ type: 'success', text: `已清理 ${cleared} 条工具调用缓存` });
      }
      await loadStats();
    } catch {
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
    <SettingsPage
      title="数据与存储"
      description="查看应用数据使用情况。会话、消息和生成的文件不会被清理。"
    >
      <WebModeBanner />

      <SettingsSection title="使用情况">
      <div className="grid grid-cols-2 gap-4">
        <div className="bg-zinc-800 rounded-lg p-4">
          <div className="text-2xl font-bold text-zinc-200">{stats?.sessionCount || 0}</div>
          <div className="text-xs text-zinc-400">会话数</div>
        </div>
        <div className="bg-zinc-800 rounded-lg p-4">
          <div className="text-2xl font-bold text-zinc-200">{stats?.messageCount || 0}</div>
          <div className="text-xs text-zinc-400">消息数</div>
        </div>
        <div className="bg-zinc-800 rounded-lg p-4">
          <div className="text-2xl font-bold text-indigo-400">{formatSize(stats?.databaseSize || 0)}</div>
          <div className="text-xs text-zinc-400">数据库大小</div>
        </div>
        <div className="bg-zinc-800 rounded-lg p-4">
          <div className="text-2xl font-bold text-cyan-400">{stats?.cacheEntries || 0}</div>
          <div className="text-xs text-zinc-400">内存缓存条目</div>
        </div>
      </div>
      </SettingsSection>

      {/* Detailed Stats */}
      <div className="bg-zinc-800 rounded-lg p-4">
        <h4 className="text-sm font-medium text-zinc-200 mb-3">详细数据</h4>
        <div className="space-y-2 text-xs">
          <div className="flex justify-between text-zinc-400">
            <span>工具执行记录</span>
            <span className="text-zinc-400">{stats?.toolExecutionCount || 0} 条</span>
          </div>
          <div className="flex justify-between text-zinc-400">
            <span>项目知识库</span>
            <span className="text-zinc-400">{stats?.knowledgeCount || 0} 条</span>
          </div>
        </div>
      </div>

      {/* Cache Info & Clear Button */}
      <div className="bg-zinc-800 rounded-lg p-4">
        <h4 className="text-sm font-medium text-zinc-200 mb-3">可清理的缓存</h4>
        <p className="text-xs text-zinc-400 mb-3">
          工具调用的临时缓存（如文件读取、搜索结果）可以安全清理，不会影响您的会话和数据。
        </p>
        <Button
          disabled={isWebMode()}
          onClick={handleClearToolCache}
          loading={isClearing}
          variant="secondary"
          fullWidth
          leftIcon={!isClearing ? <RefreshCw className="w-4 h-4" /> : undefined}
        >
          清空缓存 {(stats?.cacheEntries || 0) > 0 && `(${stats?.cacheEntries} 条)`}
        </Button>
      </div>

      {/* Debug Snapshots */}
      <div className="bg-zinc-800 rounded-lg p-4">
        <h4 className="text-sm font-medium text-zinc-200 mb-3">调试快照</h4>
        <p className="text-xs text-zinc-400 mb-3">
          每个 agent turn 自动落一条上下文快照，给 <code className="text-zinc-300">debug session</code> 与设置页排查问题用。
          清空不会影响会话和消息。
        </p>
        <div className="grid grid-cols-3 gap-2 mb-3 text-xs">
          <div className="bg-zinc-900 rounded p-2">
            <div className="text-zinc-200 font-medium">{snapshotStats?.snapshotCount ?? 0}</div>
            <div className="text-zinc-500">快照数</div>
          </div>
          <div className="bg-zinc-900 rounded p-2">
            <div className="text-zinc-200 font-medium">{snapshotStats?.sessionCount ?? 0}</div>
            <div className="text-zinc-500">覆盖 session</div>
          </div>
          <div className="bg-zinc-900 rounded p-2">
            <div className="text-zinc-200 font-medium">{formatSize(snapshotStats?.totalBytes ?? 0)}</div>
            <div className="text-zinc-500">占用</div>
          </div>
        </div>

        <div className="mb-3">
          <label className="block text-xs text-zinc-400 mb-2">保留时长</label>
          <div className="flex gap-2 flex-wrap">
            {RETENTION_OPTIONS.map((opt) => {
              const active = (snapshotStats?.retentionDays ?? 1) === opt.value;
              return (
                <button
                  key={opt.value}
                  type="button"
                  onClick={() => handleRetentionChange(opt.value)}
                  disabled={isWebMode()}
                  className={`px-3 py-1.5 rounded text-xs border transition-colors ${
                    active
                      ? 'bg-indigo-500/20 border-indigo-500/50 text-indigo-200'
                      : 'bg-zinc-900 border-zinc-700 text-zinc-400 hover:bg-zinc-700'
                  } ${isWebMode() ? 'opacity-50 cursor-not-allowed' : ''}`}
                >
                  {opt.label}
                </button>
              );
            })}
          </div>
          <p className="text-xs text-zinc-500 mt-2">
            启动时自动清理超出保留时长的快照（"永久" 表示禁用自动清理）。当前默认 1 天。
          </p>
        </div>

        <Button
          disabled={isWebMode()}
          onClick={handleClearSnapshots}
          loading={isClearingSnapshots}
          variant="secondary"
          fullWidth
          leftIcon={!isClearingSnapshots ? <RefreshCw className="w-4 h-4" /> : undefined}
        >
          清空调试快照 {(snapshotStats?.snapshotCount || 0) > 0 && `(${snapshotStats?.snapshotCount} 条)`}
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
    </SettingsPage>
  );
};
