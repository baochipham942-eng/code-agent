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
  RendererBundleStatus,
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
  type UpdateInstallProgress,
} from '../../../../utils/tauriUpdater';
import { WebModeBanner } from '../WebModeBanner';
import ipcService from '../../../../services/ipcService';
import { useAppStore } from '../../../../stores/appStore';
import { useSessionStore } from '../../../../stores/sessionStore';
import { useIsDeveloperMode } from '../../../../stores/modeStore';
import {
  getRendererBundleActivationText,
  getRendererBundleReloadBlockedReason,
  hasRendererBundlePendingActivation,
  readLoadedRendererBundleStatus,
} from '../../../../utils/rendererBundleActivation';

export {
  getRendererBundleActivationText,
  getRendererBundleAutoReloadBlockedReason,
  getRendererBundleReloadBlockedReason,
  hasRendererBundlePendingActivation,
  isRendererBundleTextEntryElement,
  readLoadedRendererBundleStatus,
  shouldAutoReloadRendererBundle,
} from '../../../../utils/rendererBundleActivation';

const logger = createLogger('UpdateSettings');
const BUILD_APP_VERSION = import.meta.env.VITE_APP_VERSION as string | undefined;

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

/**
 * 这次检查是否彻底失败。失败时不能渲染成"已是最新版本"，
 * 必须显示"检查失败"以免误导用户停留在旧版本。
 */
export function isFailedUpdateCheck(info: UpdateInfo | null): boolean {
  return Boolean(info?.checkFailed);
}

/** 安装进度百分比（0-100），总大小未知时返回 null（用不确定态展示） */
export function getInstallProgressPercent(progress: UpdateInstallProgress | null): number | null {
  if (progress?.phase !== 'download' || !progress.total) return null;
  return Math.min(100, Math.round((progress.downloaded / progress.total) * 100));
}

/** 安装按钮文案：随阶段变化，下载阶段优先显示百分比，否则显示已下载 MB */
export function getInstallButtonLabel(
  isInstalling: boolean,
  progress: UpdateInstallProgress | null,
): string {
  if (!isInstalling) return '立即更新';
  if (!progress) return '准备中...';
  if (progress.phase === 'install') return '正在安装...';
  if (progress.phase === 'relaunch') return '正在重启...';
  const percent = getInstallProgressPercent(progress);
  if (percent !== null) return `下载中 ${percent}%`;
  return `下载中 ${(progress.downloaded / 1024 / 1024).toFixed(1)} MB`;
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

export function getRendererBundleSummaryText(status: RendererBundleStatus | null): string | null {
  if (!status) return null;
  if (status.disabled) {
    return '前端热更已停用，使用包内版本';
  }
  const attempt = status.lastAttempt;
  if (!attempt) {
    return status.activeBundle
      ? `前端界面已应用 v${status.activeBundle.version}`
      : '前端界面使用包内版本';
  }
  if (attempt.outcome === 'applied') {
    return `前端界面已热更到 v${attempt.manifest?.version ?? status.activeBundle?.version ?? 'unknown'}`;
  }
  if (attempt.outcome === 'rolled-back') {
    return '前端热更已回退到包内版本';
  }
  if (attempt.outcome === 'skipped') {
    if (attempt.reason === 'already-current') {
      return `前端界面已是最新热更 v${attempt.manifest?.version ?? status.activeBundle?.version ?? 'unknown'}`;
    }
    if (attempt.reason === 'shell-too-old') {
      return `前端热更需要壳版本 v${attempt.manifest?.minShellVersion ?? 'unknown'}`;
    }
    if (attempt.reason === 'missing-shell-capability') {
      return '前端热更需要新壳能力';
    }
    return `前端热更已跳过：${attempt.reason ?? 'unknown'}`;
  }
  return `前端热更检查失败：${attempt.reason ?? 'unknown'}`;
}

function shortContentHash(contentHash: string | undefined): string {
  return contentHash ? contentHash.slice(0, 12) : 'unknown';
}

export function getRendererBundleDiagnosticRows(status: RendererBundleStatus | null): Array<{ label: string; value: string }> {
  if (!status) return [];
  const rows: Array<{ label: string; value: string }> = [];
  rows.push({
    label: '当前热更',
    value: status.activeBundle
      ? `v${status.activeBundle.version} · ${shortContentHash(status.activeBundle.contentHash)}`
      : '包内版本',
  });
  if (status.disabledReason) {
    rows.push({ label: '停用开关', value: status.disabledReason });
  }
  if (status.source) {
    rows.push({
      label: '配置入口',
      value: [
        status.source.manifestUrlOverride ? 'manifest override' : 'channel',
        status.source.channel,
      ].filter(Boolean).join(' · '),
    });
    if (status.source.errorReason) {
      rows.push({
        label: '入口配置错误',
        value: [
          status.source.errorReason,
          status.source.errorTarget,
        ].filter(Boolean).join(' · '),
      });
    } else if (status.source.manifestUrl) {
      rows.push({ label: '配置 manifest', value: status.source.manifestUrl });
    }
    if (status.source.rolloutPolicyUrl) {
      rows.push({ label: '策略入口', value: status.source.rolloutPolicyUrl });
    }
    if (status.source.cohort) {
      rows.push({ label: '灰度 cohort', value: status.source.cohort });
    }
  }
  const attempt = status.lastAttempt;
  if (!attempt) return rows;
  rows.push({
    label: '最近检查',
    value: [
      attempt.outcome,
      attempt.reason,
      attempt.checkedAt,
    ].filter(Boolean).join(' · '),
  });
  if (attempt.manifest) {
    rows.push({
      label: '候选版本',
      value: [
        `v${attempt.manifest.version}`,
        `min shell v${attempt.manifest.minShellVersion}`,
        `${attempt.manifest.requiredShellCapabilitiesCount} capabilities`,
        attempt.manifest.requiredRuntimeAssetsCount
          ? `${attempt.manifest.requiredRuntimeAssetsCount} runtime assets`
          : null,
        attempt.manifest.requiredResourcesCount
          ? `${attempt.manifest.requiredResourcesCount} resources`
          : null,
        attempt.manifest.rollbackToBuiltin ? 'rollback' : null,
      ].filter(Boolean).join(' · '),
    });
    if (attempt.manifest.contentHash) {
      rows.push({
        label: '候选 hash',
        value: shortContentHash(attempt.manifest.contentHash),
      });
    }
  }
  if (attempt.manifestUrl) {
    rows.push({ label: 'manifest', value: attempt.manifestUrl });
  }
  if (attempt.rollout) {
    rows.push({
      label: '策略决策',
      value: [
        attempt.rollout.decision,
        attempt.rollout.policyVersion,
        attempt.rollout.rolloutApplied === true ? 'target' : null,
        attempt.rollout.rolloutApplied === false ? 'fallback' : null,
        attempt.rollout.fallbackReason,
        attempt.rollout.reason,
      ].filter(Boolean).join(' · '),
    });
  }
  if (attempt.runtimeAssetPreparation) {
    rows.push({
      label: '运行资源预备',
      value: [
        `${attempt.runtimeAssetPreparation.installed.length} installed`,
        `${attempt.runtimeAssetPreparation.skipped.length} skipped`,
        attempt.runtimeAssetPreparation.errorMessage,
      ].filter(Boolean).join(' · '),
    });
  }
  return rows;
}

function getRuntimeAssetTone(asset: RuntimeAssetStatusEntry): string {
  if (asset.state === 'installed') return 'text-green-300 bg-green-500/10 border-green-500/30';
  if (asset.state === 'bundledFallback') return 'text-amber-300 bg-amber-500/10 border-amber-500/30';
  return 'text-zinc-300 bg-zinc-700/40 border-zinc-600/60';
}

function getRendererBundleTone(status: RendererBundleStatus): string {
  if (status.disabled) return 'text-zinc-300 bg-zinc-700/40 border-zinc-600/60';
  const outcome = status.lastAttempt?.outcome;
  if (outcome === 'applied') return 'text-green-300 bg-green-500/10 border-green-500/30';
  if (outcome === 'rolled-back') return 'text-zinc-300 bg-zinc-700/40 border-zinc-600/60';
  if (outcome === 'skipped') return 'text-zinc-300 bg-zinc-700/40 border-zinc-600/60';
  if (outcome === 'failed') return 'text-amber-300 bg-amber-500/10 border-amber-500/30';
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
  const [installProgress, setInstallProgress] = useState<UpdateInstallProgress | null>(null);
  const [installedNeedsRestart, setInstalledNeedsRestart] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [localVersion, setLocalVersion] = useState<string | null>(null);
  const [runtimeAssetsStatus, setRuntimeAssetsStatus] = useState<RuntimeAssetsStatus | null>(null);
  const [rendererBundleStatus, setRendererBundleStatus] = useState<RendererBundleStatus | null>(null);
  const [isPreparingRuntimeAssets, setIsPreparingRuntimeAssets] = useState(false);
  const [runtimeAssetsError, setRuntimeAssetsError] = useState<string | null>(null);

  const runningInTauri = isTauriMode();
  // 本机功能 / 前端热更诊断属于开发者信息，普通用户不展示，避免压低更新提示并暴露 manifest/链路细节
  const isDeveloperMode = useIsDeveloperMode();
  const loadedRendererBundle = React.useMemo(() => readLoadedRendererBundleStatus(), []);
  const runningSessionCount = useSessionStore((state) => state.runningSessionIds.size);
  const processingSessionCount = useAppStore((state) => state.processingSessionIds.size);
  const isProcessing = useAppStore((state) => state.isProcessing);

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
      .catch((err: unknown) => {
        logger.debug('Runtime assets status unavailable', {
          error: err instanceof Error ? err.message : String(err),
        });
      });
    ipcService.invokeDomain<RendererBundleStatus>(IPC_DOMAINS.UPDATE, 'rendererBundleStatus')
      .then((status) => {
        if (!cancelled) setRendererBundleStatus(status);
      })
      .catch((err: unknown) => {
        logger.debug('Renderer bundle status unavailable', {
          error: err instanceof Error ? err.message : String(err),
        });
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

  const refreshRendererBundleStatus = async () => {
    try {
      const status = await ipcService.invokeDomain<RendererBundleStatus>(IPC_DOMAINS.UPDATE, 'rendererBundleStatus');
      setRendererBundleStatus(status);
      return status;
    } catch (err) {
      logger.debug('Renderer bundle status unavailable', { error: err instanceof Error ? err.message : String(err) });
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
        if (!localVersion && info.currentVersion) {
          setLocalVersion(info.currentVersion);
        }
        // 检查彻底失败（native + cloud 都没结果）：报"检查失败"，绝不渲染成"已是最新"
        if (isFailedUpdateCheck(info)) {
          onUpdateInfoChange(null);
          setError(t.update?.checkError || '检查更新失败，请稍后重试');
          logger.error('Update check failed (native + cloud unavailable)');
        } else {
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
        }
      } else {
        const info = await ipcService.invokeDomain<UpdateInfo>(IPC_DOMAINS.UPDATE, 'check');
        if (info) {
          onUpdateInfoChange(info);
        }
      }
    } catch (err) {
      // 检查抛错（如 IPC/桥不可用）也属于检查失败，记下当前版本但显示失败，
      // 不再静默回退成"已是最新"。
      const fallbackVersion = fallbackNoUpdateInfo(
        updateInfo?.currentVersion,
        localVersion,
        BUILD_APP_VERSION,
      )?.currentVersion;
      if (fallbackVersion) {
        setLocalVersion(fallbackVersion);
      }
      onUpdateInfoChange(null);
      setError(t.update?.checkError || '检查更新失败，请稍后重试');
      logger.error('Update check failed', err);
    } finally {
      await refreshRendererBundleStatus();
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
    setInstallProgress(null);
    setError(null);
    try {
      try {
        // 下载（带进度回调）→ 安装 → 自动重启；正常情况 relaunch() 会重启 app 不再返回
        await tauriInstallUpdate((progress) => setInstallProgress(progress));
        // relaunch 未生效的兜底：提示用户手动重启
        setInstalledNeedsRestart(true);
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
      setInstallProgress(null);
    } catch (err) {
      setError('更新安装失败，请稍后重试');
      logger.error('Tauri update install failed', err);
      setIsInstalling(false);
      setInstallProgress(null);
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
  const rendererBundlePendingActivation = hasRendererBundlePendingActivation(rendererBundleStatus, loadedRendererBundle);
  const rendererBundleActivationText = getRendererBundleActivationText(rendererBundleStatus, loadedRendererBundle);
  const rendererBundleReloadBlockedReason = rendererBundlePendingActivation
    ? getRendererBundleReloadBlockedReason({ runningSessionCount, processingSessionCount, isProcessing })
    : null;

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

      {isDeveloperMode && runtimeAssetsStatus && (
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

      {isDeveloperMode && rendererBundleStatus && (
        <div className="bg-zinc-800 rounded-lg p-4">
          <div className="flex items-start justify-between gap-4">
            <div>
              <div className="text-sm text-zinc-400">前端界面</div>
              <div className="text-sm font-medium text-zinc-200 mt-1">
                {getRendererBundleSummaryText(rendererBundleStatus)}
              </div>
            </div>
            <span className={`text-xs px-2 py-1 rounded border ${getRendererBundleTone(rendererBundleStatus)}`}>
              {rendererBundleStatus.disabled ? 'disabled' : (rendererBundleStatus.lastAttempt?.outcome ?? 'builtin')}
            </span>
          </div>
          {rendererBundleStatus.lastAttempt?.missingShellCapabilities?.length ? (
            <div className="mt-3 text-xs text-zinc-500 truncate">
              缺少能力: {rendererBundleStatus.lastAttempt.missingShellCapabilities.join(', ')}
            </div>
          ) : null}
          {rendererBundleStatus.lastAttempt?.missingRuntimeAssets?.length ? (
            <div className="mt-3 text-xs text-zinc-500 truncate">
              缺少运行资源: {rendererBundleStatus.lastAttempt.missingRuntimeAssets.join(', ')}
            </div>
          ) : null}
          {rendererBundleStatus.lastAttempt?.missingResources?.length ? (
            <div className="mt-3 text-xs text-zinc-500 truncate">
              缺少包内资源: {rendererBundleStatus.lastAttempt.missingResources.join(', ')}
            </div>
          ) : null}
          {rendererBundlePendingActivation && (
            <div className="mt-4 flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
              <div className="min-w-0 text-xs">
                {rendererBundleActivationText && (
                  <div className="text-amber-300">{rendererBundleActivationText}</div>
                )}
                {rendererBundleReloadBlockedReason && (
                  <div className="mt-1 text-zinc-500">{rendererBundleReloadBlockedReason}</div>
                )}
              </div>
              <Button
                disabled={isDisabled || Boolean(rendererBundleReloadBlockedReason)}
                onClick={() => window.location.reload()}
                variant="secondary"
                size="sm"
                leftIcon={<RefreshCw className="w-4 h-4" />}
                className="shrink-0"
              >
                刷新界面生效
              </Button>
            </div>
          )}
          <div className="mt-3 grid gap-2 text-xs">
            {getRendererBundleDiagnosticRows(rendererBundleStatus).map((row) => (
              <div key={row.label} className="flex items-start justify-between gap-3">
                <span className="shrink-0 text-zinc-500">{row.label}</span>
                <span className="min-w-0 text-right text-zinc-400 break-all">{row.value}</span>
              </div>
            ))}
          </div>
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
                <div className="space-y-2">
                  <Button
                    disabled={isDisabled || isInstalling}
                    onClick={handleTauriInstall}
                    variant="primary"
                    fullWidth
                    leftIcon={isInstalling ? <Loader2 className="w-4 h-4 animate-spin" /> : <Download className="w-4 h-4" />}
                    className="!bg-indigo-600 hover:!bg-indigo-500"
                  >
                    {getInstallButtonLabel(isInstalling, installProgress)}
                  </Button>
                  {isInstalling && installProgress?.phase === 'download' && (
                    <div className="h-1.5 w-full overflow-hidden rounded-full bg-zinc-700">
                      <div
                        className="h-full rounded-full bg-indigo-400 transition-all duration-200"
                        style={
                          getInstallProgressPercent(installProgress) !== null
                            ? { width: `${getInstallProgressPercent(installProgress)}%` }
                            : { width: '100%', opacity: 0.4 }
                        }
                      />
                    </div>
                  )}
                </div>
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

      {/* Installed, needs restart */}
      {installedNeedsRestart && (
        <div className="flex items-center gap-2 p-3 rounded-lg bg-green-500/10 text-green-400">
          <CheckCircle className="w-4 h-4" />
          <span className="text-sm">更新已下载安装完成，请重启 Agent Neo 生效</span>
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
