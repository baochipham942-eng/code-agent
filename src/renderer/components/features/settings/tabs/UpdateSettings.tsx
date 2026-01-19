// ============================================================================
// UpdateSettings - Version Update Tab
// ============================================================================

import React, { useState, useEffect } from 'react';
import { Download, RefreshCw, CheckCircle, AlertCircle } from 'lucide-react';
import { useI18n } from '../../../../hooks/useI18n';
import { Button } from '../../../primitives';
import { IPC_CHANNELS } from '@shared/ipc';
import type { UpdateInfo } from '@shared/types';

// ============================================================================
// Types
// ============================================================================

export interface UpdateSettingsProps {
  updateInfo: UpdateInfo | null;
  onUpdateInfoChange: (info: UpdateInfo | null) => void;
  onShowUpdateModal: () => void;
}

// ============================================================================
// Component
// ============================================================================

export const UpdateSettings: React.FC<UpdateSettingsProps> = ({
  updateInfo,
  onUpdateInfoChange,
  onShowUpdateModal,
}) => {
  const { t } = useI18n();
  const [isChecking, setIsChecking] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Get current version from updateInfo, or show placeholder
  const currentVersion = updateInfo?.currentVersion || '...';

  const checkForUpdates = async () => {
    setIsChecking(true);
    setError(null);
    try {
      const info = await window.electronAPI?.invoke(IPC_CHANNELS.UPDATE_CHECK);
      // Only handle non-force updates (force updates handled by App.tsx)
      if (info && !info.forceUpdate) {
        onUpdateInfoChange(info);
      } else if (info) {
        onUpdateInfoChange(info);
      }
    } catch (err) {
      setError(t.update?.checkError || '检查更新失败，请稍后重试');
      console.error('Update check failed:', err);
    } finally {
      setIsChecking(false);
    }
  };

  useEffect(() => {
    // Auto-check if no updateInfo
    if (!updateInfo) {
      checkForUpdates();
    }
  }, []);

  // Format file size
  const formatSize = (bytes: number): string => {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  };

  return (
    <div className="space-y-6">
      {/* Header */}
      <div>
        <h3 className="text-sm font-medium text-zinc-100 mb-2">{t.update?.title || '版本更新'}</h3>
        <p className="text-xs text-zinc-400 mb-4">
          {t.update?.description || '检查并下载最新版本的 Code Agent'}
        </p>
      </div>

      {/* Current Version */}
      <div className="bg-zinc-800/50 rounded-lg p-4">
        <div className="flex items-center justify-between">
          <div>
            <div className="text-sm text-zinc-400">{t.update?.currentVersion || '当前版本'}</div>
            <div className="text-lg font-semibold text-zinc-100">v{currentVersion}</div>
          </div>
          <Button
            onClick={checkForUpdates}
            loading={isChecking}
            variant="secondary"
            size="sm"
            leftIcon={!isChecking ? <RefreshCw className="w-4 h-4" /> : undefined}
          >
            {isChecking ? (t.update?.checking || '检查中...') : (t.update?.checkNow || '检查更新')}
          </Button>
        </div>
      </div>

      {/* Update Status */}
      {updateInfo && (
        <div className={`rounded-lg p-4 ${
          updateInfo.hasUpdate ? 'bg-indigo-500/10 border border-indigo-500/30' : 'bg-green-500/10 border border-green-500/30'
        }`}>
          {updateInfo.hasUpdate ? (
            <div className="space-y-4">
              <div className="flex items-start gap-3">
                <Download className="w-5 h-5 text-indigo-400 mt-0.5" />
                <div className="flex-1">
                  <div className="text-sm font-medium text-zinc-100">
                    {t.update?.newVersion || '发现新版本'}: v{updateInfo.latestVersion}
                  </div>
                  {updateInfo.fileSize && (
                    <p className="text-xs text-zinc-500 mt-0.5">
                      文件大小: {formatSize(updateInfo.fileSize)}
                    </p>
                  )}
                  {updateInfo.releaseNotes && (
                    <div className="mt-2 p-2 bg-zinc-800/50 rounded text-xs text-zinc-400 max-h-24 overflow-y-auto whitespace-pre-line">
                      {updateInfo.releaseNotes}
                    </div>
                  )}
                </div>
              </div>

              {/* Update Now Button */}
              <Button
                onClick={onShowUpdateModal}
                variant="primary"
                fullWidth
                leftIcon={<Download className="w-4 h-4" />}
                className="!bg-indigo-600 hover:!bg-indigo-500"
              >
                {t.update?.download || '立即更新'}
              </Button>
            </div>
          ) : (
            <div className="flex items-center gap-3">
              <CheckCircle className="w-5 h-5 text-green-400" />
              <span className="text-sm text-zinc-100">{t.update?.upToDate || '已是最新版本'}</span>
            </div>
          )}
        </div>
      )}

      {/* Error Message */}
      {error && (
        <div className="flex items-center gap-2 p-3 rounded-lg bg-red-500/10 text-red-400">
          <AlertCircle className="w-4 h-4" />
          <span className="text-sm">{error}</span>
        </div>
      )}
    </div>
  );
};
