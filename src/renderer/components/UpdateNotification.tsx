// ============================================================================
// UpdateNotification - 可选更新弹窗（可关闭）
// 仅用于非强制更新场景，由用户在设置中手动触发
// ============================================================================

import React, { useState, useEffect, useCallback } from 'react';
import { X, Download, CheckCircle, AlertCircle, Loader2 } from 'lucide-react';
import { IPC_CHANNELS } from '../../shared/ipc';
import type { UpdateInfo, DownloadProgress } from '../../shared/types';
import { createLogger } from '../utils/logger';

const logger = createLogger('UpdateNotification');

interface UpdateNotificationProps {
  /** 更新信息 */
  updateInfo: UpdateInfo;
  /** 关闭回调 */
  onClose: () => void;
}

type DownloadState = 'idle' | 'downloading' | 'downloaded' | 'error';

export const UpdateNotification: React.FC<UpdateNotificationProps> = ({
  updateInfo,
  onClose,
}) => {
  const [downloadState, setDownloadState] = useState<DownloadState>('idle');
  const [downloadProgress, setDownloadProgress] = useState<DownloadProgress | null>(null);
  const [downloadedFilePath, setDownloadedFilePath] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Listen for update events from main process
  useEffect(() => {
    const handleUpdateEvent = (event: { type: string; data?: any }) => {
      logger.debug('Received event', { type: event.type, data: event.data });

      switch (event.type) {
        case 'download_progress':
          setDownloadProgress(event.data);
          setDownloadState('downloading');
          break;

        case 'download_complete':
          setDownloadedFilePath(event.data.filePath);
          setDownloadState('downloaded');
          break;

        case 'download_error':
          setError(event.data.error);
          setDownloadState('error');
          break;
      }
    };

    const unsubscribe = window.electronAPI?.on(IPC_CHANNELS.UPDATE_EVENT, handleUpdateEvent);

    return () => {
      unsubscribe?.();
    };
  }, []);

  const handleDownload = useCallback(async () => {
    if (!updateInfo?.downloadUrl) return;

    try {
      setDownloadState('downloading');
      setDownloadProgress({ percent: 0, transferred: 0, total: 0, bytesPerSecond: 0 });
      await window.electronAPI?.invoke(IPC_CHANNELS.UPDATE_DOWNLOAD, updateInfo.downloadUrl);
    } catch (err) {
      setError(err instanceof Error ? err.message : '下载失败');
      setDownloadState('error');
    }
  }, [updateInfo?.downloadUrl]);

  const handleOpenFile = useCallback(async () => {
    if (!downloadedFilePath) return;
    await window.electronAPI?.invoke(IPC_CHANNELS.UPDATE_OPEN_FILE, downloadedFilePath);
  }, [downloadedFilePath]);

  const handleRetry = useCallback(() => {
    setError(null);
    setDownloadState('idle');
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

  // 下载中不允许关闭
  const canClose = downloadState !== 'downloading';

  return (
    <>
      {/* Backdrop */}
      <div
        className="fixed inset-0 bg-black/60 backdrop-blur-sm z-50"
        onClick={canClose ? onClose : undefined}
      />

      {/* Modal */}
      <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
        <div
          className="bg-zinc-900 border border-zinc-700 rounded-xl shadow-2xl w-full max-w-md animate-in fade-in zoom-in-95 duration-200"
          onClick={(e) => e.stopPropagation()}
        >
          {/* Header */}
          <div className="flex items-center justify-between px-6 py-4 border-b border-zinc-800">
            <h2 className="text-lg font-semibold text-white">软件更新</h2>
            {canClose && (
              <button
                onClick={onClose}
                className="p-1.5 text-zinc-400 hover:text-white hover:bg-zinc-800 rounded-lg transition-colors"
              >
                <X className="w-5 h-5" />
              </button>
            )}
          </div>

          {/* Content */}
          <div className="px-6 py-5">
            {/* Idle State - Ready to Download */}
            {downloadState === 'idle' && (
              <div className="space-y-4">
                <div className="flex items-start gap-4">
                  <div className="w-12 h-12 rounded-full bg-indigo-500/20 flex items-center justify-center flex-shrink-0">
                    <Download className="w-6 h-6 text-indigo-400" />
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="text-lg font-medium text-white">
                      新版本 v{updateInfo.latestVersion} 可用
                    </p>
                    <p className="text-sm text-zinc-400 mt-1">
                      当前版本: v{updateInfo.currentVersion}
                    </p>
                    {updateInfo.fileSize && (
                      <p className="text-sm text-zinc-500 mt-0.5">
                        文件大小: {formatSize(updateInfo.fileSize)}
                      </p>
                    )}
                  </div>
                </div>

                {/* Release Notes */}
                {updateInfo.releaseNotes && (
                  <div className="bg-zinc-800/50 rounded-lg p-4 max-h-40 overflow-y-auto">
                    <p className="text-xs font-medium text-zinc-400 mb-2">更新内容</p>
                    <div className="text-sm text-zinc-300 whitespace-pre-wrap">
                      {updateInfo.releaseNotes}
                    </div>
                  </div>
                )}
              </div>
            )}

            {/* Downloading */}
            {downloadState === 'downloading' && downloadProgress && (
              <div className="space-y-4">
                <div className="flex items-center gap-4">
                  <div className="w-12 h-12 rounded-full bg-cyan-500/20 flex items-center justify-center flex-shrink-0">
                    <Loader2 className="w-6 h-6 text-cyan-400 animate-spin" />
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="text-lg font-medium text-white">正在下载更新</p>
                    <p className="text-sm text-zinc-400 mt-1">
                      {formatSize(downloadProgress.transferred)} / {formatSize(downloadProgress.total)}
                      {downloadProgress.bytesPerSecond > 0 && ` • ${formatSpeed(downloadProgress.bytesPerSecond)}`}
                    </p>
                  </div>
                  <span className="text-xl font-mono font-bold text-cyan-400">
                    {downloadProgress.percent.toFixed(0)}%
                  </span>
                </div>

                {/* Progress Bar */}
                <div className="h-2 bg-zinc-800 rounded-full overflow-hidden">
                  <div
                    className="h-full bg-gradient-to-r from-indigo-500 to-cyan-400 transition-all duration-300"
                    style={{ width: `${downloadProgress.percent}%` }}
                  />
                </div>

                <p className="text-xs text-zinc-500 text-center">
                  请勿关闭此窗口，下载完成后可安装更新
                </p>
              </div>
            )}

            {/* Download Complete */}
            {downloadState === 'downloaded' && (
              <div className="space-y-4">
                <div className="flex items-center gap-4">
                  <div className="w-12 h-12 rounded-full bg-emerald-500/20 flex items-center justify-center flex-shrink-0">
                    <CheckCircle className="w-6 h-6 text-emerald-400" />
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="text-lg font-medium text-white">下载完成</p>
                    <p className="text-sm text-zinc-400 mt-1">
                      点击下方按钮启动安装程序
                    </p>
                  </div>
                </div>
              </div>
            )}

            {/* Error */}
            {downloadState === 'error' && (
              <div className="space-y-4">
                <div className="flex items-center gap-4">
                  <div className="w-12 h-12 rounded-full bg-rose-500/20 flex items-center justify-center flex-shrink-0">
                    <AlertCircle className="w-6 h-6 text-rose-400" />
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="text-lg font-medium text-white">下载失败</p>
                    <p className="text-sm text-zinc-400 mt-1">
                      {error || '发生未知错误，请稍后重试'}
                    </p>
                  </div>
                </div>
              </div>
            )}
          </div>

          {/* Footer */}
          <div className="flex items-center justify-end gap-3 px-6 py-4 border-t border-zinc-800 bg-zinc-900/50">
            {downloadState === 'idle' && (
              <>
                <button
                  onClick={onClose}
                  className="px-4 py-2 text-sm text-zinc-400 hover:text-white hover:bg-zinc-800 rounded-lg transition-colors"
                >
                  稍后提醒
                </button>
                <button
                  onClick={handleDownload}
                  className="px-4 py-2 text-sm bg-indigo-600 hover:bg-indigo-500 text-white rounded-lg transition-colors font-medium"
                >
                  立即下载
                </button>
              </>
            )}

            {downloadState === 'downloaded' && (
              <>
                <button
                  onClick={onClose}
                  className="px-4 py-2 text-sm text-zinc-400 hover:text-white hover:bg-zinc-800 rounded-lg transition-colors"
                >
                  稍后安装
                </button>
                <button
                  onClick={handleOpenFile}
                  className="px-4 py-2 text-sm bg-emerald-600 hover:bg-emerald-500 text-white rounded-lg transition-colors font-medium"
                >
                  立即安装
                </button>
              </>
            )}

            {downloadState === 'error' && (
              <>
                <button
                  onClick={onClose}
                  className="px-4 py-2 text-sm text-zinc-400 hover:text-white hover:bg-zinc-800 rounded-lg transition-colors"
                >
                  关闭
                </button>
                <button
                  onClick={handleRetry}
                  className="px-4 py-2 text-sm bg-indigo-600 hover:bg-indigo-500 text-white rounded-lg transition-colors font-medium"
                >
                  重新下载
                </button>
              </>
            )}
          </div>
        </div>
      </div>
    </>
  );
};

export default UpdateNotification;
