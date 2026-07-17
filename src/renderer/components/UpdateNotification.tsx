// ============================================================================
// UpdateNotification - 可选更新弹窗（可关闭）
// 非强制更新场景：先展示更新内容，再由用户决定是否更新。
// ============================================================================

import React, { useState, useEffect, useCallback } from 'react';
import { X, Download, CheckCircle, AlertCircle, Loader2 } from 'lucide-react';
import { IconButton, Modal } from './primitives';
import { IPC_CHANNELS, IPC_DOMAINS } from '../../shared/ipc';
import type { UpdateInfo, DownloadProgress } from '../../shared/contract';
import { createLogger } from '../utils/logger';
import ipcService from '../services/ipcService';
import { isTauriMode } from '../utils/platform';
import { tauriInstallUpdate, tauriOpenUpdateUrl } from '../utils/tauriUpdater';

const logger = createLogger('UpdateNotification');

async function invokeUpdate<T>(action: string, payload?: unknown): Promise<T> {
  const response = await window.domainAPI?.invoke<T>(IPC_DOMAINS.UPDATE, action, payload);
  if (!response?.success) {
    throw new Error(response?.error?.message || `Update action failed: ${action}`);
  }
  return response.data as T;
}

type UpdateEvent =
  | { type: 'download_progress'; data: DownloadProgress }
  | { type: 'download_complete'; data: { filePath: string } }
  | { type: 'download_error'; data: { error: string } };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseUpdateEvent(value: unknown): UpdateEvent | null {
  if (!isRecord(value) || typeof value.type !== 'string') return null;
  if (value.type === 'download_progress' && isRecord(value.data)) {
    const { percent, transferred, total, bytesPerSecond } = value.data;
    if (
      typeof percent === 'number'
      && typeof transferred === 'number'
      && typeof total === 'number'
      && typeof bytesPerSecond === 'number'
    ) {
      return { type: value.type, data: { percent, transferred, total, bytesPerSecond } };
    }
  }
  if (value.type === 'download_complete' && isRecord(value.data) && typeof value.data.filePath === 'string') {
    return { type: value.type, data: { filePath: value.data.filePath } };
  }
  if (value.type === 'download_error' && isRecord(value.data) && typeof value.data.error === 'string') {
    return { type: value.type, data: { error: value.data.error } };
  }
  return null;
}

interface UpdateNotificationProps {
  /** 更新信息 */
  updateInfo: UpdateInfo;
  /** 关闭回调 */
  onClose: () => void;
}

type DownloadState = 'idle' | 'downloading' | 'downloaded' | 'opened' | 'error';

export const UpdateNotification: React.FC<UpdateNotificationProps> = ({
  updateInfo,
  onClose,
}) => {
  const [downloadState, setDownloadState] = useState<DownloadState>('idle');
  const [downloadProgress, setDownloadProgress] = useState<DownloadProgress | null>(null);
  const [downloadedFilePath, setDownloadedFilePath] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const runningInTauri = isTauriMode();

  // Listen for update events from main process
  useEffect(() => {
    const handleUpdateEvent = (rawEvent: unknown) => {
      const event = parseUpdateEvent(rawEvent);
      if (!event) return;
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

    const unsubscribe = ipcService.on(IPC_CHANNELS.UPDATE_EVENT, handleUpdateEvent);

    return () => {
      unsubscribe?.();
    };
  }, []);

  const handleDownload = useCallback(async () => {
    if (!runningInTauri && !updateInfo?.downloadUrl) return;

    try {
      setDownloadState('downloading');
      // 从 0% 起步，避免初始用 w-1/2 的 indeterminate 占位让进度条先闪到 50% 再跳回 0
      setDownloadProgress({ percent: 0, transferred: 0, total: 0, bytesPerSecond: 0 });
      setError(null);

      if (runningInTauri) {
        try {
          await tauriInstallUpdate((p) => {
            if (p.phase === 'download' && p.total) {
              setDownloadProgress({
                percent: Math.min(100, (p.downloaded / p.total) * 100),
                transferred: p.downloaded,
                total: p.total,
                bytesPerSecond: 0,
              });
            } else if (p.phase !== 'download') {
              setDownloadProgress((prev) => (prev ? { ...prev, percent: 100 } : prev));
            }
          });
        } catch (installError) {
          if (!updateInfo?.downloadUrl) {
            throw installError;
          }
          logger.debug('Native updater install failed, opening release page fallback', {
            error: installError instanceof Error ? installError.message : String(installError),
          });
          await tauriOpenUpdateUrl(updateInfo.downloadUrl);
          setDownloadState('opened');
        }
        return;
      }

      await invokeUpdate<string>('download', { downloadUrl: updateInfo.downloadUrl });
    } catch (err) {
      setError(err instanceof Error ? err.message : '下载失败');
      setDownloadState('error');
    }
  }, [runningInTauri, updateInfo?.downloadUrl]);

  const handleOpenFile = useCallback(async () => {
    if (!downloadedFilePath) return;
    try {
      await invokeUpdate('openFile', { filePath: downloadedFilePath });
    } catch (err) {
      setError(err instanceof Error ? err.message : '打开安装包失败');
      setDownloadState('error');
    }
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
  const latestVersionLabel = updateInfo.latestVersion ? `v${updateInfo.latestVersion}` : '新版本';
  const currentVersionLabel = updateInfo.currentVersion ? `v${updateInfo.currentVersion}` : '当前版本';
  const canStartUpdate = runningInTauri || Boolean(updateInfo.downloadUrl);
  const primaryActionLabel = runningInTauri ? '立即更新' : '立即下载';

  return (
    <Modal
      isOpen={true}
      onClose={onClose}
      title="软件更新"
      size="md"
      closeOnBackdropClick={canClose}
      closeOnEsc={canClose}
      header={
        <>
          <div className="flex-1">
            <h2 className="text-lg font-semibold text-zinc-100">软件更新</h2>
            <p className="mt-1 text-sm font-medium text-zinc-400">发现新版本可用</p>
          </div>
          {canClose && (
            <IconButton
              variant="default"
              size="md"
              icon={<X className="w-5 h-5" />}
              aria-label="关闭更新窗口"
              onClick={onClose}
            />
          )}
        </>
      }
      footer={
        <>
          {downloadState === 'idle' && (
            <>
              <button
                onClick={onClose}
                className="px-4 py-2 text-sm font-medium text-zinc-300 hover:text-zinc-100 hover:bg-zinc-800 rounded-lg transition-colors"
              >
                取消
              </button>
              <button
                onClick={handleDownload}
                disabled={!canStartUpdate}
                className="inline-flex items-center gap-2 px-5 py-2.5 text-sm bg-blue-500 hover:bg-blue-400 disabled:bg-zinc-700 disabled:text-zinc-500 text-zinc-950 rounded-full transition-colors font-semibold"
              >
                <Download className="w-4 h-4" />
                {primaryActionLabel}
              </button>
            </>
          )}

          {downloadState === 'downloading' && (
            <button
              disabled
              className="inline-flex items-center gap-2 px-5 py-2.5 text-sm bg-blue-500/60 text-zinc-950 rounded-full font-semibold"
            >
              <Loader2 className="w-4 h-4 animate-spin" />
              更新中…
            </button>
          )}

          {downloadState === 'downloaded' && (
            <>
              <button
                onClick={onClose}
                className="px-4 py-2 text-sm font-medium text-zinc-300 hover:text-zinc-100 hover:bg-zinc-800 rounded-lg transition-colors"
              >
                稍后安装
              </button>
              <button
                onClick={handleOpenFile}
                className="px-5 py-2.5 text-sm bg-emerald-500 hover:bg-emerald-400 text-zinc-950 rounded-full transition-colors font-semibold"
              >
                立即安装
              </button>
            </>
          )}

          {downloadState === 'opened' && (
            <button
              onClick={onClose}
              className="px-5 py-2.5 text-sm bg-zinc-800 hover:bg-zinc-700 text-zinc-100 rounded-full transition-colors font-semibold"
            >
              关闭
            </button>
          )}

          {downloadState === 'error' && (
            <>
              <button
                onClick={onClose}
                className="px-4 py-2 text-sm font-medium text-zinc-300 hover:text-zinc-100 hover:bg-zinc-800 rounded-lg transition-colors"
              >
                关闭
              </button>
              <button
                onClick={handleRetry}
                className="px-5 py-2.5 text-sm bg-blue-500 hover:bg-blue-400 text-zinc-950 rounded-full transition-colors font-semibold"
              >
                重新下载
              </button>
            </>
          )}
        </>
      }
    >
      {/* Idle State - Ready to Download */}
            {downloadState === 'idle' && (
              <div className="space-y-5">
                <div className="flex flex-wrap items-center gap-x-3 gap-y-2 font-mono text-base font-semibold text-zinc-200">
                  <span className="text-zinc-500">{currentVersionLabel}</span>
                  <span className="text-zinc-600">→</span>
                  <span>{latestVersionLabel}</span>
                </div>

                <div>
                  <p className="mb-2 text-xs font-semibold text-zinc-400">更新内容</p>
                  <div className="max-h-[160px] overflow-y-auto rounded-lg border border-zinc-800 bg-zinc-950/45 p-3">
                    <div className="whitespace-pre-wrap text-[13px] leading-6 text-zinc-300">
                      {updateInfo.releaseNotes?.trim() || '暂无更新内容'}
                    </div>
                  </div>
                </div>

                {updateInfo.fileSize && (
                  <p className="text-sm text-zinc-500">安装包大小：{formatSize(updateInfo.fileSize)}</p>
                )}
              </div>
            )}

            {/* Downloading */}
            {downloadState === 'downloading' && (
              <div className="space-y-5">
                <div className="flex items-center gap-4">
                  <div className="w-12 h-12 rounded-full bg-cyan-500/20 flex items-center justify-center flex-shrink-0">
                    <Loader2 className="w-6 h-6 text-cyan-400 animate-spin" />
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="text-lg font-medium text-white">
                      {runningInTauri ? '正在下载并安装更新' : '正在下载更新'}
                    </p>
                    {downloadProgress ? (
                      <p className="text-sm text-zinc-400 mt-1">
                        {formatSize(downloadProgress.transferred)} / {formatSize(downloadProgress.total)}
                        {downloadProgress.bytesPerSecond > 0 && ` · ${formatSpeed(downloadProgress.bytesPerSecond)}`}
                      </p>
                    ) : (
                      <p className="text-sm text-zinc-400 mt-1">应用会在安装完成后自动重启</p>
                    )}
                  </div>
                  {downloadProgress && (
                    <span className="text-xl font-mono font-bold text-cyan-400">
                      {downloadProgress.percent.toFixed(0)}%
                    </span>
                  )}
                </div>

                {/* Progress Bar */}
                <div className="h-2 bg-zinc-700 rounded-full overflow-hidden">
                  <div
                    className={`h-full bg-gradient-to-r from-indigo-500 to-cyan-400 transition-all duration-300 ${
                      downloadProgress ? '' : 'w-1/2 animate-pulse'
                    }`}
                    style={downloadProgress ? { width: `${downloadProgress.percent}%` } : undefined}
                  />
                </div>

                <p className="text-xs text-zinc-500 text-center">
                  请勿关闭应用，更新完成后再继续使用
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

            {/* Release page fallback */}
            {downloadState === 'opened' && (
              <div className="space-y-4">
                <div className="flex items-center gap-4">
                  <div className="w-12 h-12 rounded-full bg-emerald-500/20 flex items-center justify-center flex-shrink-0">
                    <CheckCircle className="w-6 h-6 text-emerald-400" />
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="text-lg font-medium text-white">已打开更新页面</p>
                    <p className="text-sm text-zinc-400 mt-1">
                      请在浏览器中选择适合当前系统的安装包。
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
    </Modal>
  );
};

export default UpdateNotification;
