// ============================================================================
// UpdateSettings - Version Update Tab
// ============================================================================

import React, { useState, useEffect } from 'react';
import { Download, RefreshCw, CheckCircle, AlertCircle, Loader2 } from 'lucide-react';
import { useI18n } from '../../../../hooks/useI18n';
import { Button } from '../../../primitives';
import { SettingsPage } from '../SettingsLayout';
import { IPC_CHANNELS, IPC_DOMAINS } from '@shared/ipc';
import type {
  PrepareRuntimeAssetsResult,
  RuntimeAssetsStatus,
  RuntimeAssetStatusEntry,
  UpdateInfo,
} from '@shared/contract';
import { createLogger } from '../../../../utils/logger';
import { isWebMode, isTauriMode } from '../../../../utils/platform';
import {
  tauriCheckForUpdate,
  tauriGetCurrentVersion,
  tauriInstallUpdate,
  tauriOpenUpdateUrl,
} from '../../../../utils/tauriUpdater';
import { WebModeBanner } from '../WebModeBanner';
import ipcService from '../../../../services/ipcService';

const logger = createLogger('UpdateSettings');

// ============================================================================
// Types
// ============================================================================

export interface UpdateSettingsProps {
  updateInfo: UpdateInfo | null;
  onUpdateInfoChange: (info: UpdateInfo | null) => void;
  onShowUpdateModal: () => void;
}

export function shouldClearUpdateInfoBeforeCheck(updateInfo: UpdateInfo | null): boolean {
  return !updateInfo?.hasUpdate;
}

export function getVisibleUpdateInfo(
  updateInfo: UpdateInfo | null,
  isChecking: boolean,
  error: string | null,
): UpdateInfo | null {
  if (isChecking || error) {
    return null;
  }
  return updateInfo;
}

export function getRuntimeAssetsSummaryText(status: RuntimeAssetsStatus | null): string | null {
  if (!status) return null;
  if (status.summary.missing > 0) return '本地能力组件不可用';
  if (status.summary.installed > 0) return `已准备 ${status.summary.installed} 个本地能力组件`;
  return '使用内置能力组件';
}

export function shouldShowRuntimeAssetsPrepare(updateInfo: UpdateInfo | null): boolean {
  return Boolean(updateInfo?.runtimeAssets?.hasUpdate);
}

export function getRuntimeAssetsPrepareText(isPreparing: boolean): string {
  return isPreparing ? '正在准备本地能力组件...' : '准备本地能力组件';
}

function getRuntimeAssetStatusText(asset: RuntimeAssetStatusEntry): string {
  if (asset.state === 'installed') return '已准备';
  if (asset.state === 'bundledFallback') return '使用内置';
  return '不可用';
}

function getRuntimeAssetTone(asset: RuntimeAssetStatusEntry): string {
  if (asset.state === 'installed') return 'text-green-300 bg-green-500/10 border-green-500/30';
  if (asset.state === 'bundledFallback') return 'text-amber-300 bg-amber-500/10 border-amber-500/30';
  return 'text-red-300 bg-red-500/10 border-red-500/30';
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
  const [isInstalling, setIsInstalling] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [localVersion, setLocalVersion] = useState<string | null>(null);
  const [runtimeAssetsStatus, setRuntimeAssetsStatus] = useState<RuntimeAssetsStatus | null>(null);
  const [isPreparingRuntimeAssets, setIsPreparingRuntimeAssets] = useState(false);
  const [runtimeAssetsError, setRuntimeAssetsError] = useState<string | null>(null);

  const runningInTauri = isTauriMode();

  // Load local version immediately on mount
  React.useEffect(() => {
    const loadLocalVersion = async () => {
      try {
        if (runningInTauri) {
          const version = await tauriGetCurrentVersion();
          if (version) {
            setLocalVersion(version);
          }
          return;
        }
        const version = await ipcService.invoke(IPC_CHANNELS.APP_GET_VERSION);
        if (version) {
          setLocalVersion(version);
        }
      } catch (err) {
        logger.error('Failed to load local version', err);
      }
    };
    loadLocalVersion();
  }, [runningInTauri]);

  React.useEffect(() => {
    let cancelled = false;
    ipcService.invokeDomain<RuntimeAssetsStatus>(IPC_DOMAINS.UPDATE, 'runtimeAssetsStatus')
      .then((status) => {
        if (!cancelled) setRuntimeAssetsStatus(status);
      })
      .catch((err) => {
        logger.debug('Runtime assets status unavailable', err);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const refreshRuntimeAssetsStatus = async () => {
    try {
      const status = await ipcService.invokeDomain<RuntimeAssetsStatus>(IPC_DOMAINS.UPDATE, 'runtimeAssetsStatus');
      setRuntimeAssetsStatus(status);
      return status;
    } catch (err) {
      logger.debug('Runtime assets status unavailable', { error: err instanceof Error ? err.message : String(err) });
      return null;
    }
  };

  // Get current version: prefer updateInfo, then local version, then placeholder
  const currentVersion = updateInfo?.currentVersion || localVersion || '...';
  const visibleUpdateInfo = getVisibleUpdateInfo(updateInfo, isChecking, error);

  const checkForUpdates = async () => {
    setIsChecking(true);
    setError(null);
    if (shouldClearUpdateInfoBeforeCheck(updateInfo)) {
      onUpdateInfoChange(null);
    }
    try {
      if (runningInTauri) {
        const info = await tauriCheckForUpdate();
        let runtimeAssets = info.runtimeAssets;
        try {
          const cloudInfo = await ipcService.invokeDomain<UpdateInfo>(IPC_DOMAINS.UPDATE, 'check');
          runtimeAssets = cloudInfo?.runtimeAssets;
        } catch (runtimeError) {
          logger.debug('Runtime assets update check unavailable', {
            error: runtimeError instanceof Error ? runtimeError.message : String(runtimeError),
          });
        }
        onUpdateInfoChange({ ...info, runtimeAssets });
        if (!localVersion && info.currentVersion) {
          setLocalVersion(info.currentVersion);
        }
      } else {
        const info = await ipcService.invokeDomain<UpdateInfo>(IPC_DOMAINS.UPDATE, 'check');
        if (info) {
          onUpdateInfoChange(info);
        }
      }
    } catch (err) {
      setError(t.update?.checkError || '检查更新失败，请稍后重试');
      logger.error('Update check failed', err);
    } finally {
      setIsChecking(false);
    }
  };

  const handlePrepareRuntimeAssets = async () => {
    setIsPreparingRuntimeAssets(true);
    setRuntimeAssetsError(null);
    try {
      await ipcService.invokeDomain<PrepareRuntimeAssetsResult>(IPC_DOMAINS.UPDATE, 'prepareRuntimeAssets');
      await refreshRuntimeAssetsStatus();
      const info = await ipcService.invokeDomain<UpdateInfo | null>(IPC_DOMAINS.UPDATE, 'getInfo');
      if (info) {
        onUpdateInfoChange({
          ...(updateInfo ?? info),
          runtimeAssets: info.runtimeAssets,
        });
      }
    } catch (err) {
      setRuntimeAssetsError('本地能力组件准备失败，继续使用内置组件');
      logger.error('Runtime assets prepare failed', err);
    } finally {
      setIsPreparingRuntimeAssets(false);
    }
  };

  const handleTauriInstall = async () => {
    setIsInstalling(true);
    setError(null);
    try {
      try {
        await tauriInstallUpdate();
      } catch (installError) {
        if (!updateInfo?.downloadUrl) {
          throw installError;
        }
        logger.debug('Native updater install failed, opening release page fallback', {
          error: installError instanceof Error ? installError.message : String(installError),
        });
        await tauriOpenUpdateUrl(updateInfo.downloadUrl);
      }
      setIsInstalling(false);
    } catch (err) {
      setError('更新安装失败，请稍后重试');
      logger.error('Tauri update install failed', err);
      setIsInstalling(false);
    }
  };

  useEffect(() => {
    // Auto-check on mount if no updateInfo
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

  // Whether the check/update buttons should be disabled
  const isDisabled = isWebMode();

  return (
    <SettingsPage
      title={t.update?.title || '版本更新'}
      description={t.update?.description || '检查并下载最新版本的 Agent Neo'}
    >
      <WebModeBanner />

      {/* Current Version */}
      <div className="bg-zinc-800 rounded-lg p-4">
        <div className="flex items-center justify-between">
          <div>
            <div className="text-sm text-zinc-400">{t.update?.currentVersion || '当前版本'}</div>
            <div className="text-lg font-semibold text-zinc-200">v{currentVersion}</div>
          </div>
          <Button
            disabled={isDisabled}
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

      {runtimeAssetsStatus && (
        <div className="bg-zinc-800 rounded-lg p-4">
          <div className="flex items-start justify-between gap-4">
            <div>
              <div className="text-sm text-zinc-400">本地能力组件</div>
              <div className="text-sm font-medium text-zinc-200 mt-1">
                {getRuntimeAssetsSummaryText(runtimeAssetsStatus)}
              </div>
            </div>
            <div className="space-y-2 text-right">
              {runtimeAssetsStatus.assets.map((asset) => (
                <div key={asset.id} className="flex items-center justify-end gap-2">
                  <span className="text-xs text-zinc-400">{asset.label}</span>
                  <span className={`text-xs px-2 py-1 rounded border ${getRuntimeAssetTone(asset)}`}>
                    {getRuntimeAssetStatusText(asset)}
                  </span>
                </div>
              ))}
            </div>
          </div>
          {shouldShowRuntimeAssetsPrepare(updateInfo) && (
            <Button
              disabled={isDisabled || isPreparingRuntimeAssets}
              onClick={handlePrepareRuntimeAssets}
              variant="secondary"
              size="sm"
              leftIcon={isPreparingRuntimeAssets ? <Loader2 className="w-4 h-4 animate-spin" /> : <Download className="w-4 h-4" />}
              className="mt-4"
            >
              {getRuntimeAssetsPrepareText(isPreparingRuntimeAssets)}
            </Button>
          )}
          {runtimeAssetsError && (
            <div className="mt-3 flex items-center gap-2 text-xs text-amber-300">
              <AlertCircle className="w-4 h-4" />
              <span>{runtimeAssetsError}</span>
            </div>
          )}
        </div>
      )}

      {/* Update Status */}
      {visibleUpdateInfo && (
        <div className={`rounded-lg p-4 ${
          visibleUpdateInfo.hasUpdate ? 'bg-indigo-500/10 border border-indigo-500/30' : 'bg-green-500/10 border border-green-500/30'
        }`}>
          {visibleUpdateInfo.hasUpdate ? (
            <div className="space-y-4">
              <div className="flex items-start gap-3">
                <Download className="w-5 h-5 text-indigo-400 mt-0.5" />
                <div className="flex-1">
                  <div className="text-sm font-medium text-zinc-200">
                    {t.update?.newVersion || '发现新版本'}: v{visibleUpdateInfo.latestVersion}
                  </div>
                  {visibleUpdateInfo.fileSize && (
                    <p className="text-xs text-zinc-500 mt-0.5">
                      文件大小: {formatSize(visibleUpdateInfo.fileSize)}
                    </p>
                  )}
                  {visibleUpdateInfo.releaseNotes && (
                    <div className="mt-2 p-2 bg-zinc-800 rounded text-xs text-zinc-400 max-h-24 overflow-y-auto whitespace-pre-line">
                      {visibleUpdateInfo.releaseNotes}
                    </div>
                  )}
                </div>
              </div>

              {/* Update Now Button — Tauri uses direct install, legacy desktop uses modal */}
              {runningInTauri ? (
                <Button
                  disabled={isDisabled || isInstalling}
                  onClick={handleTauriInstall}
                  variant="primary"
                  fullWidth
                  leftIcon={isInstalling ? <Loader2 className="w-4 h-4 animate-spin" /> : <Download className="w-4 h-4" />}
                  className="!bg-indigo-600 hover:!bg-indigo-500"
                >
                  {isInstalling ? '正在下载并安装...' : (t.update?.download || '立即更新')}
                </Button>
              ) : (
                <Button
                  disabled={isDisabled}
                  onClick={onShowUpdateModal}
                  variant="primary"
                  fullWidth
                  leftIcon={<Download className="w-4 h-4" />}
                  className="!bg-indigo-600 hover:!bg-indigo-500"
                >
                  {t.update?.download || '立即更新'}
                </Button>
              )}
            </div>
          ) : (
            <div className="flex items-center gap-3">
              <CheckCircle className="w-5 h-5 text-green-400" />
              <span className="text-sm text-zinc-200">{t.update?.upToDate || '已是最新版本'}</span>
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
    </SettingsPage>
  );
};
