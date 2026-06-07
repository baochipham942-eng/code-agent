import { describe, expect, it } from 'vitest';
import type { RendererBundleStatus, UpdateInfo } from '../../../src/shared/contract';
import {
  getRendererBundleDiagnosticRows,
  getRendererBundleActivationText,
  getRendererBundleReloadBlockedReason,
  getRendererBundleSummaryText,
  getRuntimeAssetDisplayName,
  getRuntimeAssetStatusText,
  getRuntimeAssetsPrepareText,
  getRuntimeAssetsSummaryText,
  getVisibleUpdateInfo,
  isFailedUpdateCheck,
  getInstallButtonLabel,
  getInstallProgressPercent,
  hasRendererBundlePendingActivation,
  isRendererBundleTextEntryElement,
  shouldShowRuntimeAssetsPrepare,
  shouldClearUpdateInfoBeforeCheck,
  shouldDisableUpdateActions,
  shouldAutoReloadRendererBundle,
} from '../../../src/renderer/components/features/settings/tabs/UpdateSettings';

const upToDateInfo: UpdateInfo = {
  hasUpdate: false,
  currentVersion: '0.16.75',
};

const availableUpdateInfo: UpdateInfo = {
  hasUpdate: true,
  currentVersion: '0.16.75',
  latestVersion: '0.16.76',
};

describe('UpdateSettings status visibility', () => {
  it('hides stale success status while a fresh check is running or failed', () => {
    expect(getVisibleUpdateInfo(upToDateInfo, false, null)).toBe(upToDateInfo);
    expect(getVisibleUpdateInfo(upToDateInfo, true, null)).toBeNull();
    expect(getVisibleUpdateInfo(upToDateInfo, false, '检查更新失败，请稍后重试')).toBeNull();
  });

  it('treats a failed check as failure, not as up-to-date', () => {
    expect(isFailedUpdateCheck(null)).toBe(false);
    expect(isFailedUpdateCheck(upToDateInfo)).toBe(false);
    expect(isFailedUpdateCheck(availableUpdateInfo)).toBe(false);
    expect(isFailedUpdateCheck({ hasUpdate: false, currentVersion: '0.16.91', checkFailed: true })).toBe(true);
    // 检查失败时必须连同 error 一起隐藏旧的成功状态，不能渲染"已是最新"
    expect(getVisibleUpdateInfo(upToDateInfo, false, '检查更新失败，请稍后重试')).toBeNull();
  });

  it('renders install progress: percent → install → relaunch', () => {
    expect(getInstallButtonLabel(false, null)).toBe('立即更新');
    expect(getInstallButtonLabel(true, null)).toBe('准备中...');
    expect(getInstallButtonLabel(true, { phase: 'download', downloaded: 5_000_000, total: 10_000_000 })).toBe('下载中 50%');
    expect(getInstallButtonLabel(true, { phase: 'download', downloaded: 2_097_152 })).toBe('下载中 2.0 MB');
    expect(getInstallButtonLabel(true, { phase: 'install', downloaded: 10, total: 10 })).toBe('正在安装...');
    expect(getInstallButtonLabel(true, { phase: 'relaunch', downloaded: 10, total: 10 })).toBe('正在重启...');

    expect(getInstallProgressPercent(null)).toBeNull();
    expect(getInstallProgressPercent({ phase: 'download', downloaded: 3, total: 4 })).toBe(75);
    expect(getInstallProgressPercent({ phase: 'download', downloaded: 3 })).toBeNull();
    expect(getInstallProgressPercent({ phase: 'install', downloaded: 4, total: 4 })).toBeNull();
  });

  it('clears stale no-update results before rechecking while preserving known update availability', () => {
    expect(shouldClearUpdateInfoBeforeCheck(null)).toBe(true);
    expect(shouldClearUpdateInfoBeforeCheck(upToDateInfo)).toBe(true);
    expect(shouldClearUpdateInfoBeforeCheck(availableUpdateInfo)).toBe(false);
  });

  it('keeps update actions enabled for the packaged localhost bridge', () => {
    expect(shouldDisableUpdateActions(true, false)).toBe(true);
    expect(shouldDisableUpdateActions(true, true)).toBe(false);
    expect(shouldDisableUpdateActions(false, false)).toBe(false);
  });

  it('summarizes local runtime component status for settings', () => {
    expect(getRuntimeAssetsSummaryText(null)).toBeNull();
    expect(getRuntimeAssetsSummaryText({
      runtimeBaseDir: '/tmp/runtime',
      activeManifestPath: '/tmp/runtime/active.json',
      assets: [{
        id: 'sharp-image-runtime',
        label: 'Image processing components',
        delivery: 'bundled',
        state: 'bundledFallback',
        nodeModules: [],
      }],
      summary: { installed: 0, bundledFallback: 1, missing: 0 },
    })).toBe('图片理解已可用');
    expect(getRuntimeAssetsSummaryText({
      runtimeBaseDir: '/tmp/runtime',
      activeManifestPath: '/tmp/runtime/active.json',
      assets: [{
        id: 'onnxruntime-vad',
        label: 'Local audio capability components',
        delivery: 'optional',
        state: 'installed',
        nodeModules: [],
      }],
      summary: { installed: 1, bundledFallback: 0, missing: 0 },
    })).toBe('语音输入、网页操作、图片理解都已可用');
    expect(getRuntimeAssetsSummaryText({
      runtimeBaseDir: '/tmp/runtime',
      activeManifestPath: '/tmp/runtime/active.json',
      assets: [{
        id: 'sharp-image-runtime',
        label: 'Image processing components',
        delivery: 'bundled',
        state: 'bundledFallback',
        nodeModules: [],
      }, {
        id: 'playwright-browser-runtime',
        label: 'Browser automation components',
        delivery: 'optional',
        state: 'missing',
        nodeModules: [],
      }],
      summary: { installed: 0, bundledFallback: 1, missing: 1 },
    })).toBe('图片理解已可用；语音输入、网页操作首次使用时自动下载');
    expect(getRuntimeAssetsSummaryText({
      runtimeBaseDir: '/tmp/runtime',
      activeManifestPath: '/tmp/runtime/active.json',
      assets: [{
        id: 'sharp-image-runtime',
        label: 'Image processing components',
        delivery: 'bundled',
        state: 'missing',
        nodeModules: [],
      }],
      summary: { installed: 0, bundledFallback: 0, missing: 1 },
    })).toBe('图片理解暂不可用');
  });

  it('labels bundled Sharp fallback separately from optional runtime downloads', () => {
    expect(getRuntimeAssetStatusText({
      id: 'sharp-image-runtime',
      label: 'Image processing components',
      delivery: 'bundled',
      state: 'bundledFallback',
      nodeModules: [],
    })).toBe('已可用');
    expect(getRuntimeAssetStatusText({
      id: 'playwright-browser-runtime',
      label: 'Browser automation components',
      delivery: 'optional',
      state: 'missing',
      nodeModules: [],
    })).toBe('首次使用时下载');
  });

  it('uses user-facing runtime capability names instead of package labels', () => {
    expect(getRuntimeAssetDisplayName({
      id: 'onnxruntime-vad',
      label: 'Local audio capability components',
      delivery: 'optional',
      state: 'missing',
      nodeModules: [],
    })).toBe('语音输入');
    expect(getRuntimeAssetDisplayName({
      id: 'playwright-browser-runtime',
      label: 'Browser automation components',
      delivery: 'optional',
      state: 'missing',
      nodeModules: [],
    })).toBe('网页操作');
    expect(getRuntimeAssetDisplayName({
      id: 'sharp-image-runtime',
      label: 'Image processing components',
      delivery: 'bundled',
      state: 'bundledFallback',
      nodeModules: [],
    })).toBe('图片理解');
  });

  it('shows prepare action only when runtime assets need an update', () => {
    expect(shouldShowRuntimeAssetsPrepare(null)).toBe(false);
    expect(shouldShowRuntimeAssetsPrepare(upToDateInfo)).toBe(false);
    expect(shouldShowRuntimeAssetsPrepare({
      hasUpdate: false,
      currentVersion: '0.16.75',
      runtimeAssets: {
        hasUpdate: true,
        manifestUrl: 'https://cdn.example.com/runtime-assets/manifest.json',
        manifestSha256: 'a'.repeat(64),
      },
    })).toBe(true);
    expect(getRuntimeAssetsPrepareText(false)).toBe('提前准备语音输入和网页操作');
    expect(getRuntimeAssetsPrepareText(true)).toBe('正在准备语音输入和网页操作...');
  });

  it('summarizes renderer bundle hot-update status', () => {
    const builtinStatus: RendererBundleStatus = {
      schemaVersion: 1,
      activeBundle: null,
      lastAttempt: null,
    };
    expect(getRendererBundleSummaryText(builtinStatus)).toBe('前端界面使用包内版本');
    expect(getRendererBundleSummaryText({
      schemaVersion: 1,
      disabled: true,
      disabledReason: 'CODE_AGENT_DISABLE_RENDERER_HOT_UPDATE',
      activeBundle: { version: '0.16.93', contentHash: 'abc' },
      lastAttempt: null,
    })).toBe('前端热更已停用，使用包内版本');

    expect(getRendererBundleSummaryText({
      schemaVersion: 1,
      activeBundle: { version: '0.16.93', contentHash: 'abc' },
      lastAttempt: {
        checkedAt: '2026-06-06T00:00:00.000Z',
        manifestUrl: 'https://oss.example/manifest.json',
        currentShellVersion: '0.16.93',
        outcome: 'applied',
        manifest: {
          version: '0.16.94',
          contentHash: 'def',
          minShellVersion: '0.16.93',
          bundleUrl: 'https://oss.example/bundle.tar.gz',
          requiredShellCapabilitiesCount: 155,
        },
      },
    })).toBe('前端界面已热更到 v0.16.94');

    expect(getRendererBundleSummaryText({
      schemaVersion: 1,
      activeBundle: null,
      lastAttempt: {
        checkedAt: '2026-06-06T00:00:00.000Z',
        manifestUrl: 'https://oss.example/manifest.json',
        currentShellVersion: '0.16.93',
        outcome: 'rolled-back',
        reason: 'rollback-to-builtin',
        manifest: {
          version: '0.16.94',
          minShellVersion: '0.16.93',
          requiredShellCapabilitiesCount: 0,
          rollbackToBuiltin: true,
        },
      },
    })).toBe('前端热更已回退到包内版本');

    expect(getRendererBundleSummaryText({
      schemaVersion: 1,
      activeBundle: null,
      lastAttempt: {
        checkedAt: '2026-06-06T00:00:00.000Z',
        manifestUrl: 'https://oss.example/manifest.json',
        currentShellVersion: '0.16.92',
        outcome: 'skipped',
        reason: 'shell-too-old',
        manifest: {
          version: '0.16.94',
          contentHash: 'def',
          minShellVersion: '0.16.93',
          bundleUrl: 'https://oss.example/bundle.tar.gz',
          requiredShellCapabilitiesCount: 155,
        },
      },
    })).toBe('前端热更需要壳版本 v0.16.93');

    expect(getRendererBundleSummaryText({
      schemaVersion: 1,
      activeBundle: null,
      lastAttempt: {
        checkedAt: '2026-06-06T00:00:00.000Z',
        manifestUrl: 'https://oss.example/manifest.json',
        currentShellVersion: '0.16.93',
        outcome: 'skipped',
        reason: 'missing-shell-capability',
        missingShellCapabilities: ['domain:local/newAction'],
      },
    })).toBe('前端热更需要新壳能力');

    expect(getRendererBundleSummaryText({
      schemaVersion: 1,
      activeBundle: null,
      lastAttempt: {
        checkedAt: '2026-06-06T00:00:00.000Z',
        manifestUrl: 'https://oss.example/manifest.json',
        currentShellVersion: '0.16.93',
        outcome: 'failed',
        reason: 'envelope-untrusted',
      },
    })).toBe('前端热更检查失败：envelope-untrusted');
  });

  it('shows renderer bundle diagnostics for active bundle, last attempt, and manifest gates', () => {
    const status: RendererBundleStatus = {
      schemaVersion: 1,
      activeBundle: { version: '0.16.93', contentHash: 'abcdef1234567890' },
      lastAttempt: {
        checkedAt: '2026-06-06T00:00:00.000Z',
        manifestUrl: 'https://oss.example/renderer-bundle/latest/manifest.json',
        currentShellVersion: '0.16.93',
        outcome: 'skipped',
        reason: 'already-current',
        rollout: {
          policyUrl: 'https://agentneo.example/api/v1/control-plane?kind=renderer_bundle_rollout',
          policyVersion: 'policy-1',
          decision: 'use-manifest',
          rolloutApplied: false,
          fallbackReason: 'rollout-percent-excluded',
        },
        runtimeAssetPreparation: {
          attempted: true,
          installed: [{ assetId: 'playwright-browser-runtime' }],
          skipped: [{ assetId: 'onnxruntime-vad', reason: 'already installed' }],
        },
        manifest: {
          version: '0.16.93',
          contentHash: 'abcdef1234567890',
          minShellVersion: '0.16.93',
          bundleUrl: 'https://oss.example/renderer-bundle/latest/bundle.tar.gz',
          requiredShellCapabilitiesCount: 180,
          requiredRuntimeAssetsCount: 2,
          requiredResourcesCount: 1,
        },
      },
    };

    expect(getRendererBundleDiagnosticRows(status)).toEqual([
      { label: '当前热更', value: 'v0.16.93 · abcdef123456' },
      { label: '最近检查', value: 'skipped · already-current · 2026-06-06T00:00:00.000Z' },
      { label: '候选版本', value: 'v0.16.93 · min shell v0.16.93 · 180 capabilities · 2 runtime assets · 1 resources' },
      { label: '候选 hash', value: 'abcdef123456' },
      { label: 'manifest', value: 'https://oss.example/renderer-bundle/latest/manifest.json' },
      { label: '策略决策', value: 'use-manifest · policy-1 · fallback · rollout-percent-excluded' },
      { label: '运行资源预备', value: '1 installed · 1 skipped' },
    ]);
  });

  it('shows renderer bundle source configuration diagnostics', () => {
    expect(getRendererBundleDiagnosticRows({
      schemaVersion: 1,
      source: {
        channel: 'beta',
        manifestUrl: 'https://oss.example/renderer-bundle/channels/beta/manifest.json',
        rolloutPolicyUrl: 'https://agentneo.example/api/v1/control-plane?kind=renderer_bundle_rollout',
        rolloutPolicyUrlOverride: true,
        cohort: 'staff',
      },
      activeBundle: null,
      lastAttempt: null,
    })).toEqual([
      { label: '当前热更', value: '包内版本' },
      { label: '配置入口', value: 'channel · beta' },
      { label: '配置 manifest', value: 'https://oss.example/renderer-bundle/channels/beta/manifest.json' },
      { label: '策略入口', value: 'https://agentneo.example/api/v1/control-plane?kind=renderer_bundle_rollout' },
      { label: '灰度 cohort', value: 'staff' },
    ]);

    expect(getRendererBundleDiagnosticRows({
      schemaVersion: 1,
      source: {
        channel: '../beta',
        errorReason: 'invalid-renderer-bundle-channel',
        errorTarget: 'CODE_AGENT_RENDERER_BUNDLE_CHANNEL=../beta',
      },
      activeBundle: null,
      lastAttempt: null,
    })).toEqual([
      { label: '当前热更', value: '包内版本' },
      { label: '配置入口', value: 'channel · ../beta' },
      {
        label: '入口配置错误',
        value: 'invalid-renderer-bundle-channel · CODE_AGENT_RENDERER_BUNDLE_CHANNEL=../beta',
      },
    ]);
  });

  it('shows renderer hot-update disabled reason in diagnostics', () => {
    expect(getRendererBundleDiagnosticRows({
      schemaVersion: 1,
      disabled: true,
      disabledReason: 'CODE_AGENT_DISABLE_RENDERER_HOT_UPDATE',
      activeBundle: null,
      lastAttempt: null,
    })).toEqual([
      { label: '当前热更', value: '包内版本' },
      { label: '停用开关', value: 'CODE_AGENT_DISABLE_RENDERER_HOT_UPDATE' },
    ]);
  });

  it('detects renderer bundle changes that need a page refresh', () => {
    const activeStatus: RendererBundleStatus = {
      schemaVersion: 1,
      activeBundle: { version: '0.16.94', contentHash: 'hash-new' },
      lastAttempt: null,
    };

    expect(hasRendererBundlePendingActivation(activeStatus, null)).toBe(true);
    expect(getRendererBundleActivationText(activeStatus, null)).toBe('刷新界面后使用 v0.16.94');

    expect(hasRendererBundlePendingActivation(activeStatus, {
      version: '0.16.94',
      contentHash: 'hash-new',
    })).toBe(false);
    expect(getRendererBundleActivationText(activeStatus, {
      version: '0.16.94',
      contentHash: 'hash-new',
    })).toBeNull();

    const rolledBackStatus: RendererBundleStatus = {
      schemaVersion: 1,
      activeBundle: null,
      lastAttempt: {
        checkedAt: '2026-06-06T00:00:00.000Z',
        manifestUrl: 'https://oss.example/manifest.json',
        currentShellVersion: '0.16.94',
        outcome: 'rolled-back',
        reason: 'rollback-to-builtin',
      },
    };

    expect(hasRendererBundlePendingActivation(rolledBackStatus, {
      version: '0.16.94',
      contentHash: 'hash-new',
    })).toBe(true);
    expect(getRendererBundleActivationText(rolledBackStatus, {
      version: '0.16.94',
      contentHash: 'hash-new',
    })).toBe('刷新界面后回到包内版本');

    expect(hasRendererBundlePendingActivation({
      schemaVersion: 1,
      disabled: true,
      disabledReason: 'CODE_AGENT_DISABLE_RENDERER_HOT_UPDATE',
      activeBundle: { version: '0.16.94', contentHash: 'hash-new' },
      lastAttempt: null,
    }, {
      version: '0.16.94',
      contentHash: 'hash-new',
    })).toBe(true);
  });

  it('blocks renderer bundle page refresh while work is running', () => {
    expect(getRendererBundleReloadBlockedReason({
      runningSessionCount: 2,
      processingSessionCount: 0,
      isProcessing: false,
    })).toBe('有 2 个会话正在运行，完成后再刷新');
    expect(getRendererBundleReloadBlockedReason({
      runningSessionCount: 0,
      processingSessionCount: 1,
      isProcessing: false,
    })).toBe('任务执行中，完成后再刷新');
    expect(getRendererBundleReloadBlockedReason({
      runningSessionCount: 0,
      processingSessionCount: 0,
      isProcessing: true,
    })).toBe('任务执行中，完成后再刷新');
    expect(getRendererBundleReloadBlockedReason({
      runningSessionCount: 0,
      processingSessionCount: 0,
      isProcessing: false,
      activeTaskCount: 1,
    })).toBe('任务执行中，完成后再刷新');
    expect(getRendererBundleReloadBlockedReason({
      runningSessionCount: 0,
      processingSessionCount: 0,
      isProcessing: false,
      backgroundTaskCount: 1,
    })).toBe('有 1 个后台任务正在运行，完成后再刷新');
    expect(getRendererBundleReloadBlockedReason({
      runningSessionCount: 0,
      processingSessionCount: 0,
      isProcessing: false,
    })).toBeNull();
  });

  it('detects focused text entry elements before auto reload', () => {
    const element = (input: { tagName: string; type?: string; isContentEditable?: boolean }) =>
      input as unknown as Element;

    expect(isRendererBundleTextEntryElement(null)).toBe(false);
    expect(isRendererBundleTextEntryElement(element({ tagName: 'TEXTAREA' }))).toBe(true);
    expect(isRendererBundleTextEntryElement(element({ tagName: 'INPUT', type: 'text' }))).toBe(true);
    expect(isRendererBundleTextEntryElement(element({ tagName: 'INPUT', type: 'checkbox' }))).toBe(false);
    expect(isRendererBundleTextEntryElement(element({ tagName: 'DIV', isContentEditable: true }))).toBe(true);
  });

  it('auto-reloads renderer bundle only after the page is idle and no work can be interrupted', () => {
    const status: RendererBundleStatus = {
      schemaVersion: 1,
      activeBundle: { version: '0.16.94', contentHash: 'hash-new' },
      lastAttempt: null,
    };
    const loadedBundle = { version: '0.16.93', contentHash: 'hash-old' };
    const textarea = { tagName: 'TEXTAREA' } as unknown as Element;

    expect(shouldAutoReloadRendererBundle({
      status,
      loadedBundle,
      runningSessionCount: 0,
      processingSessionCount: 0,
      isProcessing: false,
      idleMs: 10_000,
      minIdleMs: 5_000,
    })).toBe(true);

    expect(shouldAutoReloadRendererBundle({
      status,
      loadedBundle,
      runningSessionCount: 0,
      processingSessionCount: 0,
      isProcessing: false,
      activeTaskCount: 1,
      idleMs: 10_000,
      minIdleMs: 5_000,
    })).toBe(false);

    expect(shouldAutoReloadRendererBundle({
      status,
      loadedBundle,
      runningSessionCount: 0,
      processingSessionCount: 0,
      isProcessing: false,
      documentHidden: true,
      idleMs: 10_000,
      minIdleMs: 5_000,
    })).toBe(false);

    expect(shouldAutoReloadRendererBundle({
      status,
      loadedBundle,
      runningSessionCount: 0,
      processingSessionCount: 0,
      isProcessing: false,
      focusedElement: textarea,
      idleMs: 10_000,
      minIdleMs: 5_000,
    })).toBe(false);

    expect(shouldAutoReloadRendererBundle({
      status,
      loadedBundle,
      runningSessionCount: 0,
      processingSessionCount: 0,
      isProcessing: false,
      idleMs: 1_000,
      minIdleMs: 5_000,
    })).toBe(false);
  });
});
