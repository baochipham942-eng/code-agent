// ============================================================================
// MemorySyncPanel - 跨设备记忆同步 (Phase 4)
// ============================================================================

import React, { useState, useEffect } from 'react';
import {
  Cloud,
  CloudOff,
  RefreshCw,
  CheckCircle,
  AlertCircle,
  Laptop,
  Smartphone,
  Monitor,
  Clock,
  ArrowUpDown,
  Download,
  Upload,
} from 'lucide-react';
import { Button } from '../../../primitives';
import { IPC_CHANNELS } from '@shared/ipc';
import type { SyncStatus, DeviceInfo } from '@shared/types';
import { createLogger } from '../../../../utils/logger';

const logger = createLogger('MemorySyncPanel');

interface MemorySyncPanelProps {
  onSyncComplete?: () => void;
}

// 设备图标映射
function getDeviceIcon(deviceName: string): React.ReactNode {
  const lowerName = deviceName.toLowerCase();
  if (lowerName.includes('iphone') || lowerName.includes('android') || lowerName.includes('mobile')) {
    return <Smartphone className="w-4 h-4" />;
  }
  if (lowerName.includes('laptop') || lowerName.includes('macbook')) {
    return <Laptop className="w-4 h-4" />;
  }
  return <Monitor className="w-4 h-4" />;
}

// 格式化时间
function formatRelativeTime(timestamp: number | null): string {
  if (!timestamp) return '从未';

  const now = Date.now();
  const diff = now - timestamp;

  if (diff < 60 * 1000) return '刚刚';
  if (diff < 60 * 60 * 1000) return `${Math.floor(diff / 60000)} 分钟前`;
  if (diff < 24 * 60 * 60 * 1000) return `${Math.floor(diff / 3600000)} 小时前`;
  return `${Math.floor(diff / 86400000)} 天前`;
}

export const MemorySyncPanel: React.FC<MemorySyncPanelProps> = ({
  onSyncComplete,
}) => {
  const [syncStatus, setSyncStatus] = useState<SyncStatus | null>(null);
  const [devices, setDevices] = useState<DeviceInfo[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [isSyncing, setIsSyncing] = useState(false);
  const [message, setMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null);

  // 加载同步状态
  const loadSyncStatus = async () => {
    try {
      const [status, deviceList] = await Promise.all([
        window.electronAPI?.invoke(IPC_CHANNELS.SYNC_GET_STATUS) as Promise<SyncStatus>,
        window.electronAPI?.invoke(IPC_CHANNELS.DEVICE_LIST) as Promise<DeviceInfo[]>,
      ]);
      setSyncStatus(status);
      setDevices(deviceList || []);
    } catch (error) {
      logger.error('Failed to load sync status', error);
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    loadSyncStatus();

    // 监听同步事件
    const unsubscribe = window.electronAPI?.on(IPC_CHANNELS.SYNC_EVENT, (status: SyncStatus) => {
      setSyncStatus(status);
      if (!status.isSyncing && isSyncing) {
        setIsSyncing(false);
        if (!status.error) {
          setMessage({ type: 'success', text: '同步完成' });
          onSyncComplete?.();
        } else {
          setMessage({ type: 'error', text: status.error });
        }
      }
    });

    return () => {
      unsubscribe?.();
    };
  }, [isSyncing, onSyncComplete]);

  // 开始同步
  const handleSync = async () => {
    setIsSyncing(true);
    setMessage(null);
    try {
      await window.electronAPI?.invoke(IPC_CHANNELS.SYNC_START);
    } catch (error) {
      logger.error('Sync failed', error);
      setMessage({ type: 'error', text: '同步失败' });
      setIsSyncing(false);
    }
  };

  // 强制全量同步
  const handleForceSync = async () => {
    setIsSyncing(true);
    setMessage(null);
    try {
      const result = await window.electronAPI?.invoke(IPC_CHANNELS.SYNC_FORCE_FULL);
      if (result?.success) {
        setMessage({ type: 'success', text: '全量同步完成' });
        onSyncComplete?.();
      } else {
        setMessage({ type: 'error', text: result?.error || '同步失败' });
      }
    } catch (error) {
      logger.error('Force sync failed', error);
      setMessage({ type: 'error', text: '全量同步失败' });
    } finally {
      setIsSyncing(false);
    }
  };

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-8">
        <RefreshCw className="w-5 h-5 animate-spin text-text-secondary" />
      </div>
    );
  }

  const isEnabled = syncStatus?.isEnabled;

  return (
    <div className="space-y-4">
      {/* 同步状态 */}
      <div className={`flex items-center gap-3 p-3 rounded-lg ${
        isEnabled ? 'bg-green-500/10' : 'bg-surface'
      }`}>
        {isEnabled ? (
          <Cloud className="w-5 h-5 text-green-400" />
        ) : (
          <CloudOff className="w-5 h-5 text-text-tertiary" />
        )}
        <div className="flex-1">
          <div className="text-sm font-medium text-text-primary">
            {isEnabled ? '云端同步已启用' : '云端同步未启用'}
          </div>
          <div className="text-xs text-text-secondary">
            {isEnabled
              ? `上次同步: ${formatRelativeTime(syncStatus?.lastSyncAt || null)}`
              : '登录账户后可跨设备同步记忆'}
          </div>
        </div>
        {isEnabled && (
          <Button
            variant="secondary"
            size="sm"
            onClick={handleSync}
            disabled={isSyncing}
            className="flex items-center gap-1.5"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${isSyncing ? 'animate-spin' : ''}`} />
            {isSyncing ? '同步中...' : '立即同步'}
          </Button>
        )}
      </div>

      {/* 同步统计 */}
      {isEnabled && syncStatus && (
        <div className="grid grid-cols-3 gap-2">
          <div className="bg-surface rounded-lg p-2 text-center">
            <div className="flex items-center justify-center gap-1 text-blue-400 mb-1">
              <Upload className="w-3.5 h-3.5" />
            </div>
            <div className="text-xs text-text-secondary">待上传</div>
            <div className="text-sm font-medium text-text-primary">{syncStatus.pendingChanges || 0}</div>
          </div>
          <div className="bg-surface rounded-lg p-2 text-center">
            <div className="flex items-center justify-center gap-1 text-green-400 mb-1">
              <Download className="w-3.5 h-3.5" />
            </div>
            <div className="text-xs text-text-secondary">已同步</div>
            <div className="text-sm font-medium text-text-primary">
              {syncStatus.lastSyncAt ? '✓' : '-'}
            </div>
          </div>
          <div className="bg-surface rounded-lg p-2 text-center">
            <div className="flex items-center justify-center gap-1 text-amber-400 mb-1">
              <ArrowUpDown className="w-3.5 h-3.5" />
            </div>
            <div className="text-xs text-text-secondary">设备数</div>
            <div className="text-sm font-medium text-text-primary">{devices.length}</div>
          </div>
        </div>
      )}

      {/* 已连接设备 */}
      {isEnabled && devices.length > 0 && (
        <div className="space-y-2">
          <div className="text-xs font-medium text-text-secondary uppercase tracking-wide">
            已连接设备
          </div>
          <div className="space-y-1.5">
            {devices.map(device => (
              <div
                key={device.id}
                className="flex items-center gap-2 p-2 bg-surface rounded-lg"
              >
                <span className="text-text-secondary">
                  {getDeviceIcon(device.deviceName)}
                </span>
                <div className="flex-1 min-w-0">
                  <div className="text-sm text-text-primary truncate">
                    {device.deviceName}
                  </div>
                  <div className="text-xs text-text-tertiary">
                    {device.isCurrent && (
                      <span className="text-green-400 mr-2">当前设备</span>
                    )}
                    <span className="flex items-center gap-1 inline-flex">
                      <Clock className="w-3 h-3" />
                      {formatRelativeTime(device.lastActiveAt)}
                    </span>
                  </div>
                </div>
                {device.isCurrent && (
                  <span className="w-2 h-2 rounded-full bg-green-500" />
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      {/* 高级选项 */}
      {isEnabled && (
        <div className="pt-2 border-t border-border-default">
          <button
            onClick={handleForceSync}
            disabled={isSyncing}
            className="text-xs text-text-tertiary hover:text-text-secondary transition-colors"
          >
            强制全量同步（覆盖本地数据）
          </button>
        </div>
      )}

      {/* 消息提示 */}
      {message && (
        <div
          className={`flex items-center gap-2 p-2 rounded-lg text-xs ${
            message.type === 'success'
              ? 'bg-green-500/10 text-green-400'
              : 'bg-red-500/10 text-red-400'
          }`}
        >
          {message.type === 'success' ? (
            <CheckCircle className="w-4 h-4" />
          ) : (
            <AlertCircle className="w-4 h-4" />
          )}
          <span>{message.text}</span>
        </div>
      )}

      {/* 未启用提示 */}
      {!isEnabled && (
        <div className="text-xs text-text-tertiary bg-surface rounded-lg p-3">
          <p className="mb-2">启用云端同步后，您的记忆将自动在所有设备间保持一致：</p>
          <ul className="list-disc list-inside space-y-1 text-text-secondary">
            <li>AI 学习的偏好和习惯</li>
            <li>常用信息和模板</li>
            <li>个人设置和配置</li>
          </ul>
          <p className="mt-2 text-text-secondary">请在「云端」设置中登录账户以启用同步。</p>
        </div>
      )}
    </div>
  );
};
