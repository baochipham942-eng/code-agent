// ============================================================================
// ForceUpdateModal - 强制更新弹窗（不可关闭）
// ============================================================================

import React, { useState, useEffect, useCallback } from 'react';
import { Download, CheckCircle, AlertCircle, Loader2, ShieldAlert } from 'lucide-react';
import { IPC_CHANNELS, IPC_DOMAINS } from '../../shared/ipc';
import type { UpdateInfo, DownloadProgress } from '../../shared/contract';
import { Modal, ModalHeader } from './primitives/Modal';
import { createLogger } from '../utils/logger';
import ipcService from '../services/ipcService';
import { useI18n } from '../hooks/useI18n';
import type { Translations } from '../i18n';

const logger = createLogger('ForceUpdateModal');

async function invokeUpdate<T>(action: string, payload?: unknown): Promise<T> {
  const response = await window.domainAPI?.invoke<T>(IPC_DOMAINS.UPDATE, action, payload);
  if (!response?.success) {
    throw new Error(response?.error?.message || `Update action failed: ${action}`);
  }
  return response.data as T;
}

export type DownloadErrorKind = 'network' | 'disk' | 'unknown';

/** 下载失败原文 → 错误类别。判别顺序有意为之：磁盘类特征（ENOSPC/EACCES）比网络类更具体，先判。 */
export function classifyDownloadErrorKind(error: string): DownloadErrorKind {
  if (/enospc|no space|disk full|eacces|eperm|permission denied/i.test(error)) return 'disk';
  if (/timeout|timed ?out|etimedout|network|enotfound|econnrefused|econnreset|eai_again|proxy|\bdns\b/i.test(error)) return 'network';
  return 'unknown';
}

export interface DownloadErrorPresentation {
  /** 一行人话摘要，替代满屏原始报错 */
  message: string;
  /** 分不出类别时才有：原始报错文本，展示层进折叠/tooltip，不裸露成主文案 */
  detail?: string;
}

/** 下载失败原文 → 展示层文案。网络/磁盘类给对应人话，分不出类别用通用兜底 + 原文进 detail。 */
export function toDownloadErrorPresentation(
  error: string,
  n: Translations['notices']['update'],
): DownloadErrorPresentation {
  const kind = classifyDownloadErrorKind(error);
  if (kind === 'network') return { message: n.downloadErrorNetwork };
  if (kind === 'disk') return { message: n.downloadErrorDisk };
  return { message: n.unknownError, detail: error };
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

interface ForceUpdateModalProps {
  updateInfo: UpdateInfo;
}

type DownloadState = 'idle' | 'downloading' | 'downloaded' | 'error';

export const ForceUpdateModal: React.FC<ForceUpdateModalProps> = ({ updateInfo }) => {
  const [downloadState, setDownloadState] = useState<DownloadState>('idle');
  const [downloadProgress, setDownloadProgress] = useState<DownloadProgress | null>(null);
  const [downloadedFilePath, setDownloadedFilePath] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  // 原始报错文本（分不出网络/磁盘类别时才有）：只挂 tooltip，不裸露成主文案。
  const [errorDetail, setErrorDetail] = useState<string | null>(null);
  const { t } = useI18n();
  const n = t.notices.update;

  // Listen for download events from main process
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

        case 'download_error': {
          const presentation = toDownloadErrorPresentation(event.data.error, n);
          setError(presentation.message);
          setErrorDetail(presentation.detail ?? null);
          setDownloadState('error');
          break;
        }
      }
    };

    const unsubscribe = ipcService.on(IPC_CHANNELS.UPDATE_EVENT, handleUpdateEvent);

    return () => {
      unsubscribe?.();
    };
  }, [n]);

  const handleDownload = useCallback(async () => {
    if (!updateInfo?.downloadUrl) return;

    try {
      setDownloadState('downloading');
      setDownloadProgress({ percent: 0, transferred: 0, total: 0, bytesPerSecond: 0 });
      setError(null);
      setErrorDetail(null);
      await invokeUpdate<string>('download', { downloadUrl: updateInfo.downloadUrl });
    } catch (err) {
      const raw = err instanceof Error ? err.message : String(err);
      const presentation = toDownloadErrorPresentation(raw, n);
      setError(presentation.message);
      setErrorDetail(presentation.detail ?? null);
      setDownloadState('error');
    }
  }, [updateInfo?.downloadUrl, n]);

  const handleOpenFile = useCallback(async () => {
    if (!downloadedFilePath) return;
    await invokeUpdate('openFile', { filePath: downloadedFilePath });
  }, [downloadedFilePath]);

  const handleRetry = useCallback(() => {
    setError(null);
    setErrorDetail(null);
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

  // Render footer button based on state
  const renderFooterButton = () => {
    switch (downloadState) {
      case 'idle':
        return (
          <button
            onClick={handleDownload}
            className="w-full px-4 py-2.5 text-sm bg-indigo-600 hover:bg-indigo-500 text-white rounded-lg transition-colors font-medium"
          >
            {n.downloadUpdateNow}
          </button>
        );
      case 'downloaded':
        return (
          <button
            onClick={handleOpenFile}
            className="w-full px-4 py-2.5 text-sm bg-emerald-600 hover:bg-emerald-500 text-white rounded-lg transition-colors font-medium"
          >
            {n.installNow}
          </button>
        );
      case 'error':
        return (
          <button
            onClick={handleRetry}
            className="w-full px-4 py-2.5 text-sm bg-indigo-600 hover:bg-indigo-500 text-white rounded-lg transition-colors font-medium"
          >
            {n.redownload}
          </button>
        );
      default:
        return null;
    }
  };

  return (
    <Modal
      isOpen={true}
      size="md"
      closeOnBackdropClick={false}
      closeOnEsc={false}
      showCloseButton={false}
      zIndex={100}
      className="border-rose-500/30"
      headerBgClass="bg-rose-500/5"
      header={
        <ModalHeader
          icon={<ShieldAlert className="w-5 h-5" />}
          iconBgClass="bg-rose-500/20"
          iconColorClass="text-rose-400"
          title={n.forceTitle}
          subtitle={n.forceSubtitle}
          showCloseButton={false}
        />
      }
      footer={renderFooterButton()}
    >
      <div className="py-1">
        {/* Idle State - Ready to Download */}
        {downloadState === 'idle' && (
          <div className="space-y-4">
            <div className="flex items-start gap-4">
              <div className="w-12 h-12 rounded-full bg-indigo-500/20 flex items-center justify-center flex-shrink-0">
                <Download className="w-6 h-6 text-indigo-400" />
              </div>
              <div className="flex-1 min-w-0">
                <p className="text-lg font-medium text-white">
                  {n.versionAvailable.replace('{version}', updateInfo.latestVersion ?? '')}
                </p>
                <p className="text-sm text-zinc-400 mt-1">
                  {n.currentVersionLine.replace('{version}', updateInfo.currentVersion ?? '')}
                </p>
                {updateInfo.fileSize && (
                  <p className="text-sm text-zinc-500 mt-0.5">
                    {n.fileSizeLine.replace('{size}', formatSize(updateInfo.fileSize))}
                  </p>
                )}
              </div>
            </div>

            {/* Release Notes */}
            {updateInfo.releaseNotes && (
              <div className="bg-zinc-800 rounded-lg p-4 max-h-40 overflow-y-auto">
                <p className="text-xs font-medium text-zinc-400 mb-2">{n.updateContent}</p>
                <div className="text-sm text-zinc-400 whitespace-pre-wrap">
                  {updateInfo.releaseNotes}
                </div>
              </div>
            )}

            <div className="bg-amber-500/10 border border-amber-500/20 rounded-lg p-3">
              <p className="text-xs text-amber-200">
                {n.forceNote}
              </p>
            </div>
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
                <p className="text-lg font-medium text-white">{n.downloading}</p>
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
            <div className="h-2 bg-zinc-700 rounded-full overflow-hidden">
              <div
                className="h-full bg-gradient-to-r from-indigo-500 to-cyan-400 transition-all duration-300"
                style={{ width: `${downloadProgress.percent}%` }}
              />
            </div>

            <p className="text-xs text-zinc-500 text-center">
              {n.dontCloseForce}
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
                <p className="text-lg font-medium text-white">{n.downloadComplete}</p>
                <p className="text-sm text-zinc-400 mt-1">
                  {n.clickToInstall}
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
                <p className="text-lg font-medium text-white">{n.downloadFailed}</p>
                <p className="text-sm text-zinc-400 mt-1" title={errorDetail ?? undefined}>
                  {error || n.unknownError}
                </p>
              </div>
            </div>
          </div>
        )}
      </div>
    </Modal>
  );
};

export default ForceUpdateModal;
