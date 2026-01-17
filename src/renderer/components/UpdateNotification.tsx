// ============================================================================
// UpdateNotification - Update notification banner and download progress
// ============================================================================

import React, { useState, useEffect, useCallback } from 'react';
import { IPC_CHANNELS } from '../../shared/ipc';
import type { UpdateInfo, DownloadProgress } from '../../shared/types';

interface UpdateNotificationProps {
  /** Position of the notification */
  position?: 'top' | 'bottom';
  /** Auto-dismiss after update check (if no update available) */
  autoDismissNoUpdate?: boolean;
}

type NotificationState = 'idle' | 'checking' | 'available' | 'downloading' | 'downloaded' | 'error';

export const UpdateNotification: React.FC<UpdateNotificationProps> = ({
  position = 'top',
  autoDismissNoUpdate = true,
}) => {
  const [state, setState] = useState<NotificationState>('idle');
  const [updateInfo, setUpdateInfo] = useState<UpdateInfo | null>(null);
  const [downloadProgress, setDownloadProgress] = useState<DownloadProgress | null>(null);
  const [downloadedFilePath, setDownloadedFilePath] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [dismissed, setDismissed] = useState(false);

  // Listen for update events from main process
  useEffect(() => {
    const handleUpdateEvent = (event: { type: string; data?: any }) => {
      console.log('[UpdateNotification] Received event:', event.type, event.data);

      switch (event.type) {
        case 'update_available':
          setUpdateInfo(event.data);
          setState('available');
          setDismissed(false);
          break;

        case 'download_progress':
          setDownloadProgress(event.data);
          setState('downloading');
          break;

        case 'download_complete':
          setDownloadedFilePath(event.data.filePath);
          setState('downloaded');
          break;

        case 'download_error':
          setError(event.data.error);
          setState('error');
          break;
      }
    };

    const unsubscribe = window.electronAPI?.on(IPC_CHANNELS.UPDATE_EVENT, handleUpdateEvent);

    return () => {
      unsubscribe?.();
    };
  }, []);

  // Check for updates on mount
  useEffect(() => {
    const checkForUpdates = async () => {
      try {
        setState('checking');
        const info = await window.electronAPI?.invoke(IPC_CHANNELS.UPDATE_CHECK);
        if (!info) {
          setState('idle');
          return;
        }
        setUpdateInfo(info);

        if (info.hasUpdate) {
          setState('available');
        } else {
          setState('idle');
          if (autoDismissNoUpdate) {
            setDismissed(true);
          }
        }
      } catch (err) {
        console.error('[UpdateNotification] Check failed:', err);
        setState('idle');
      }
    };

    // Initial check
    checkForUpdates();
  }, [autoDismissNoUpdate]);

  const handleDownload = useCallback(async () => {
    if (!updateInfo?.downloadUrl) return;

    try {
      setState('downloading');
      setDownloadProgress({ percent: 0, transferred: 0, total: 0, bytesPerSecond: 0 });
      await window.electronAPI?.invoke(IPC_CHANNELS.UPDATE_DOWNLOAD, updateInfo.downloadUrl);
    } catch (err) {
      setError(err instanceof Error ? err.message : '下载失败');
      setState('error');
    }
  }, [updateInfo?.downloadUrl]);

  const handleOpenFile = useCallback(async () => {
    if (!downloadedFilePath) return;
    await window.electronAPI?.invoke(IPC_CHANNELS.UPDATE_OPEN_FILE, downloadedFilePath);
  }, [downloadedFilePath]);

  const handleOpenUrl = useCallback(async () => {
    if (!updateInfo?.downloadUrl) return;
    await window.electronAPI?.invoke(IPC_CHANNELS.UPDATE_OPEN_URL, updateInfo.downloadUrl);
  }, [updateInfo?.downloadUrl]);

  const handleDismiss = useCallback(() => {
    setDismissed(true);
  }, []);

  const handleRetry = useCallback(() => {
    setError(null);
    setState('available');
  }, []);

  // Format file size
  const formatSize = (bytes: number): string => {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  };

  // Format speed
  const formatSpeed = (bytesPerSecond: number): string => {
    if (bytesPerSecond < 1024) return `${bytesPerSecond.toFixed(0)} B/s`;
    if (bytesPerSecond < 1024 * 1024) return `${(bytesPerSecond / 1024).toFixed(1)} KB/s`;
    return `${(bytesPerSecond / (1024 * 1024)).toFixed(1)} MB/s`;
  };

  // Don't render if dismissed or idle
  if (dismissed || state === 'idle' || state === 'checking') {
    return null;
  }

  const positionClasses = position === 'top'
    ? 'top-0 left-0 right-0'
    : 'bottom-0 left-0 right-0';

  return (
    <div
      className={`fixed ${positionClasses} z-50 px-4 py-2 animate-fade-in-up`}
      style={{ background: 'linear-gradient(180deg, rgba(99, 102, 241, 0.15) 0%, transparent 100%)' }}
    >
      <div className="max-w-4xl mx-auto">
        <div className="bg-elevated/95 backdrop-blur-sm border border-primary/30 rounded-lg px-4 py-3 shadow-lg">
          {/* Update Available */}
          {state === 'available' && updateInfo && (
            <div className="flex items-center justify-between gap-4">
              <div className="flex items-center gap-3">
                <div className="w-8 h-8 rounded-full bg-primary/20 flex items-center justify-center">
                  <svg className="w-4 h-4 text-primary" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
                  </svg>
                </div>
                <div>
                  <p className="text-sm font-medium text-white">
                    新版本可用: v{updateInfo.latestVersion}
                  </p>
                  <p className="text-xs text-white/60">
                    当前版本: v{updateInfo.currentVersion}
                    {updateInfo.fileSize && ` • 大小: ${formatSize(updateInfo.fileSize)}`}
                  </p>
                </div>
              </div>
              <div className="flex items-center gap-2">
                <button
                  onClick={handleOpenUrl}
                  className="px-3 py-1.5 text-xs text-white/70 hover:text-white hover:bg-white/10 rounded-md transition-colors"
                >
                  在浏览器中打开
                </button>
                <button
                  onClick={handleDownload}
                  className="px-3 py-1.5 text-xs bg-primary hover:bg-primary/80 text-white rounded-md transition-colors font-medium"
                >
                  下载更新
                </button>
                <button
                  onClick={handleDismiss}
                  className="p-1 text-white/50 hover:text-white hover:bg-white/10 rounded transition-colors"
                >
                  <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                  </svg>
                </button>
              </div>
            </div>
          )}

          {/* Downloading */}
          {state === 'downloading' && downloadProgress && (
            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-3">
                  <div className="w-8 h-8 rounded-full bg-accent-cyan/20 flex items-center justify-center">
                    <svg className="w-4 h-4 text-accent-cyan animate-spin" fill="none" viewBox="0 0 24 24">
                      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
                    </svg>
                  </div>
                  <div>
                    <p className="text-sm font-medium text-white">正在下载更新...</p>
                    <p className="text-xs text-white/60">
                      {formatSize(downloadProgress.transferred)} / {formatSize(downloadProgress.total)}
                      {' • '}{formatSpeed(downloadProgress.bytesPerSecond)}
                    </p>
                  </div>
                </div>
                <span className="text-sm font-mono text-accent-cyan">
                  {downloadProgress.percent.toFixed(1)}%
                </span>
              </div>
              <div className="h-1.5 bg-white/10 rounded-full overflow-hidden">
                <div
                  className="h-full bg-gradient-to-r from-primary to-accent-cyan transition-all duration-300"
                  style={{ width: `${downloadProgress.percent}%` }}
                />
              </div>
            </div>
          )}

          {/* Download Complete */}
          {state === 'downloaded' && (
            <div className="flex items-center justify-between gap-4">
              <div className="flex items-center gap-3">
                <div className="w-8 h-8 rounded-full bg-accent-emerald/20 flex items-center justify-center">
                  <svg className="w-4 h-4 text-accent-emerald" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                  </svg>
                </div>
                <div>
                  <p className="text-sm font-medium text-white">下载完成!</p>
                  <p className="text-xs text-white/60">点击"安装"启动安装程序</p>
                </div>
              </div>
              <div className="flex items-center gap-2">
                <button
                  onClick={handleOpenFile}
                  className="px-3 py-1.5 text-xs bg-accent-emerald hover:bg-accent-emerald/80 text-white rounded-md transition-colors font-medium"
                >
                  安装更新
                </button>
                <button
                  onClick={handleDismiss}
                  className="p-1 text-white/50 hover:text-white hover:bg-white/10 rounded transition-colors"
                >
                  <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                  </svg>
                </button>
              </div>
            </div>
          )}

          {/* Error */}
          {state === 'error' && (
            <div className="flex items-center justify-between gap-4">
              <div className="flex items-center gap-3">
                <div className="w-8 h-8 rounded-full bg-accent-rose/20 flex items-center justify-center">
                  <svg className="w-4 h-4 text-accent-rose" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                  </svg>
                </div>
                <div>
                  <p className="text-sm font-medium text-white">下载失败</p>
                  <p className="text-xs text-white/60">{error || '未知错误'}</p>
                </div>
              </div>
              <div className="flex items-center gap-2">
                <button
                  onClick={handleRetry}
                  className="px-3 py-1.5 text-xs text-white/70 hover:text-white hover:bg-white/10 rounded-md transition-colors"
                >
                  重试
                </button>
                <button
                  onClick={handleOpenUrl}
                  className="px-3 py-1.5 text-xs bg-primary hover:bg-primary/80 text-white rounded-md transition-colors font-medium"
                >
                  手动下载
                </button>
                <button
                  onClick={handleDismiss}
                  className="p-1 text-white/50 hover:text-white hover:bg-white/10 rounded transition-colors"
                >
                  <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                  </svg>
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};

export default UpdateNotification;
