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
const BUILD_APP_VERSION = import.meta.env.VITE_APP_VERSION;

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
  const optionalMissing = status.assets.filter((asset) => asset.delivery === 'optional' && asset.state === 'missing').length;
  const bundledMissing = status.assets.filter((asset) => asset.delivery === 'bundled' && asset.state === 'missing').length;
  const bundledReady = status.assets.filter((asset) => asset.delivery === 'bundled' && asset.state === 'bundledFallback').length;
  if (bundledMissing > 0) return '图片理解暂不可用';
  if (optionalMissing > 0 && bundledReady > 0) return '图片理解已可用；语音输入、网页操作首次使用时自动下载';
  if (optionalMissing > 0) return '语音输入、网页操作首次使用时自动下载';
  if (status.summary.missing > 0) return '部分功能暂不可用';
  if (status.summary.installed > 0) return '语音输入、网页操作、图片理解都已可用';
  return '图片理解已可用';
}

export function shouldShowRuntimeAssetsPrepare(updateInfo: UpdateInfo | null): boolean {
  return Boolean(updateInfo?.runtimeAssets?.hasUpdate);
}

export function shouldDisableUpdateActions(webMode: boolean, hasNativeBridge: boolean): boolean {
  return webMode && !hasNativeBridge;
}

export function getRuntimeAssetsPrepareText(isPreparing: boolean): string {
  return isPreparing ? '正在准备语音输入和网页操作...' : '提前准备语音输入和网页操作';
}

export function getRuntimeAssetStatusText(asset: RuntimeAssetStatusEntry): string {
  if (asset.state === 'installed') return '已可用';
  if (asset.state === 'bundledFallback') return '已可用';
  if (asset.delivery === 'optional') return '首次使用时下载';
  return '缺失';
}

export function getRuntimeAssetDisplayName(asset: RuntimeAssetStatusEntry): string {
  const value = `${asset.id} ${asset.label}`.toLowerCase();
  if (value.includes('audio') || value.includes('vad')) return '语音输入';
  if (value.includes('browser') || value.includes('playwright')) return '网页操作';
  if (value.includes('image') || value.includes('sharp')) return '图片理解';
  return asset.label;
}

function getRuntimeAssetTone(asset: RuntimeAssetStatusEntry): string {
  if (asset.state === 'installed') return 'text-green-300 bg-green-500/10 border-green-500/30';
  if (asset.state === 'bundledFallback') return 'text-amber-300 bg-amber-500/10 border-amber-500/30';
  return 'text-zinc-300 bg-zinc-700/40 border-zinc-600/60';
}

function hasNativeUpdateBridge(): boolean {
  if (typeof window === 'undefined') return false;
  return Boolean(window.__TAURI_INTERNALS__ || window.codeAgentDomainAPI || window.domainAPI);
}

function fallbackNoUpdateInfo(...versions: Array<string | null | undefined>): UpdateInfo | null {
  const currentVersion = versions
    .map((version) => version?.trim())
    .find((version) => version && version !== '...');
  return currentVersion ? { hasUpdate: false, currentVersion } : null;
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
        if (BUILD_APP_VERSION) {
          setLocalVersion(BUILD_APP_VERSION);
        }
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
  const currentVersion = updateInfo?.currentVersion || localVersion || BUILD_APP_VERSION || '...';
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
      const fallback = fallbackNoUpdateInfo(updateInfo?.currentVersion, localVersion, BUILD_APP_VERSION);
      if (fallback) {
        onUpdateInfoChange(fallback);
        setLocalVersion(fallback.currentVersion);
        setError(null);
        logger.error('Update check failed; using local version fallback', err);
      } else {
        setError(t.update?.checkError || '检查更新失败，请稍后重试');
        logger.error('Update check failed', err);
      }
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
      setRuntimeAssetsError('可选能力下载失败，已继续使用内置能力');
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
  const isDisabled = shouldDisableUpdateActions(isWebMode(), hasNativeUpdateBridge());

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
              <div className="text-sm text-zinc-400">本机功能</div>
              <div className="text-sm font-medium text-zinc-200 mt-1">
                {getRuntimeAssetsSummaryText(runtimeAssetsStatus)}
              </div>
            </div>
            <div className="space-y-2 text-right">
              {runtimeAssetsStatus.assets.map((asset) => (
                <div key={asset.id} className="flex items-center justify-end gap-2">
                  <span className="text-xs text-zinc-400">{getRuntimeAssetDisplayName(asset)}</span>
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
