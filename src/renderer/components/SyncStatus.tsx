// ============================================================================
// Sync Status Indicator - Shows sync status in the status bar
// ============================================================================

import React from 'react';
import { useAuthStore } from '../stores/authStore';
import { Cloud, CloudOff, Loader2, AlertCircle, Check } from 'lucide-react';

export const SyncStatusIndicator: React.FC = () => {
  const { syncStatus, isAuthenticated } = useAuthStore();

  if (!isAuthenticated) return null;

  const getStatusIcon = () => {
    if (syncStatus.isSyncing) {
      return <Loader2 className="w-3.5 h-3.5 animate-spin text-blue-400" />;
    }
    if (syncStatus.error) {
      return <AlertCircle className="w-3.5 h-3.5 text-red-400" />;
    }
    if (!syncStatus.isEnabled) {
      return <CloudOff className="w-3.5 h-3.5 text-zinc-500" />;
    }
    return <Cloud className="w-3.5 h-3.5 text-green-400" />;
  };

  const getStatusText = () => {
    if (syncStatus.isSyncing && syncStatus.syncProgress) {
      const { phase, current, total } = syncStatus.syncProgress;
      const phaseText = phase === 'pull' ? '拉取' : phase === 'push' ? '推送' : '完成';
      return `${phaseText}中 (${current}/${total})`;
    }
    if (syncStatus.isSyncing) {
      return '同步中...';
    }
    if (syncStatus.error) {
      return '同步失败';
    }
    if (!syncStatus.isEnabled) {
      return '同步已关闭';
    }
    if (syncStatus.pendingChanges > 0) {
      return `${syncStatus.pendingChanges} 待同步`;
    }
    return '已同步';
  };

  const getTooltip = () => {
    if (syncStatus.error) {
      return `同步失败: ${syncStatus.error}`;
    }
    if (syncStatus.lastSyncAt) {
      return `上次同步: ${new Date(syncStatus.lastSyncAt).toLocaleString('zh-CN')}`;
    }
    return getStatusText();
  };

  return (
    <div
      className="flex items-center gap-1.5 px-2 py-1 text-xs text-zinc-400"
      title={getTooltip()}
    >
      {getStatusIcon()}
      <span className="hidden sm:inline">{getStatusText()}</span>
    </div>
  );
};
