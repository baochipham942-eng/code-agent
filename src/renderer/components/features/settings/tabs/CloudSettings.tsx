// ============================================================================
// CloudSettings - Cloud Configuration Management Tab
// ============================================================================

import React, { useState, useEffect } from 'react';
import { RefreshCw, CheckCircle, AlertCircle, Loader2 } from 'lucide-react';
import { useI18n } from '../../../../hooks/useI18n';
import { Button } from '../../../primitives';
import { IPC_CHANNELS } from '@shared/ipc';
import { createLogger } from '../../../../utils/logger';

const logger = createLogger('CloudSettings');

// ============================================================================
// Types
// ============================================================================

export interface CloudConfigInfo {
  version: string;
  lastFetch: number;
  isStale: boolean;
  fromCloud: boolean;
  lastError: string | null;
}

// ============================================================================
// Component
// ============================================================================

export const CloudSettings: React.FC = () => {
  const { t } = useI18n();
  const [cloudConfigInfo, setCloudConfigInfo] = useState<CloudConfigInfo | null>(null);
  const [isRefreshingConfig, setIsRefreshingConfig] = useState(false);
  const [message, setMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null);

  const loadCloudConfigInfo = async () => {
    try {
      const info = await window.electronAPI?.invoke(IPC_CHANNELS.CLOUD_CONFIG_GET_INFO);
      if (info) setCloudConfigInfo(info);
    } catch (error) {
      logger.error('Failed to load cloud config info', error);
    }
  };

  useEffect(() => {
    loadCloudConfigInfo();
  }, []);

  const handleRefreshCloudConfig = async () => {
    setIsRefreshingConfig(true);
    setMessage(null);
    try {
      const result = await window.electronAPI?.invoke(IPC_CHANNELS.CLOUD_CONFIG_REFRESH);
      if (result?.success) {
        setMessage({ type: 'success', text: `配置已更新到 v${result.version}` });
        await loadCloudConfigInfo();
      } else {
        setMessage({ type: 'error', text: result?.error || '刷新失败' });
      }
    } catch (error) {
      setMessage({ type: 'error', text: '刷新失败' });
    } finally {
      setIsRefreshingConfig(false);
    }
  };

  // Format time
  const formatTime = (timestamp: number): string => {
    if (!timestamp) return '从未';
    const date = new Date(timestamp);
    return date.toLocaleString('zh-CN', {
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  };

  return (
    <div className="space-y-6">
      {/* Header */}
      <div>
        <h3 className="text-sm font-medium text-zinc-100 mb-2">
          {t.settings.cloud?.title || '云端配置'}
        </h3>
        <p className="text-xs text-zinc-400 mb-4">
          {t.settings.cloud?.description || 'System Prompt、Skills 等配置从云端实时获取，支持热更新。'}
        </p>
      </div>

      {/* Config Status */}
      <div className="bg-zinc-800/50 rounded-lg p-4">
        <h4 className="text-sm font-medium text-zinc-100 mb-3">配置状态</h4>
        {cloudConfigInfo ? (
          <div className="space-y-2 text-xs">
            <div className="flex justify-between text-zinc-400">
              <span>配置版本</span>
              <span className="text-zinc-300 font-mono">{cloudConfigInfo.version}</span>
            </div>
            <div className="flex justify-between text-zinc-400">
              <span>配置来源</span>
              <span className={cloudConfigInfo.fromCloud ? 'text-green-400' : 'text-yellow-400'}>
                {cloudConfigInfo.fromCloud ? '云端' : '内置'}
              </span>
            </div>
            <div className="flex justify-between text-zinc-400">
              <span>上次获取</span>
              <span className="text-zinc-300">{formatTime(cloudConfigInfo.lastFetch)}</span>
            </div>
            <div className="flex justify-between text-zinc-400">
              <span>缓存状态</span>
              <span className={cloudConfigInfo.isStale ? 'text-yellow-400' : 'text-green-400'}>
                {cloudConfigInfo.isStale ? '已过期' : '有效'}
              </span>
            </div>
            {cloudConfigInfo.lastError && (
              <div className="flex justify-between text-zinc-400">
                <span>最近错误</span>
                <span className="text-red-400 truncate max-w-[200px]" title={cloudConfigInfo.lastError}>
                  {cloudConfigInfo.lastError}
                </span>
              </div>
            )}
          </div>
        ) : (
          <div className="flex items-center justify-center py-4">
            <Loader2 className="w-5 h-5 animate-spin text-zinc-400" />
          </div>
        )}
      </div>

      {/* Refresh Button */}
      <Button
        onClick={handleRefreshCloudConfig}
        loading={isRefreshingConfig}
        variant="primary"
        fullWidth
        leftIcon={!isRefreshingConfig ? <RefreshCw className="w-4 h-4" /> : undefined}
        className="!bg-indigo-600 hover:!bg-indigo-500"
      >
        {isRefreshingConfig ? '刷新中...' : '刷新云端配置'}
      </Button>

      {/* Message */}
      {message && (
        <div className={`flex items-center gap-2 p-3 rounded-lg ${
          message.type === 'success' ? 'bg-green-500/10 text-green-400' : 'bg-red-500/10 text-red-400'
        }`}>
          {message.type === 'success' ? <CheckCircle className="w-4 h-4" /> : <AlertCircle className="w-4 h-4" />}
          <span className="text-sm">{message.text}</span>
        </div>
      )}

      {/* Info Box */}
      <div className="bg-zinc-800/50 rounded-lg p-4">
        <h4 className="text-sm font-medium text-zinc-100 mb-2">关于云端配置</h4>
        <p className="text-xs text-zinc-400 leading-relaxed">
          云端配置包含 System Prompt、Skills 定义、Feature Flags 等内容。
          配置会在应用启动时自动获取，并缓存 1 小时。如果云端不可用，
          将自动降级使用内置配置。
        </p>
      </div>
    </div>
  );
};
