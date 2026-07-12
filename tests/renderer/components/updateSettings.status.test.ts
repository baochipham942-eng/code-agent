import { describe, expect, it } from 'vitest';
import type { DesktopShellDiagnostics, RendererBundleStatus, UpdateInfo } from '../../../src/shared/contract';
import {
  getDesktopShellDiagnosticRows,
  getDesktopShellSummaryText,
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
import { zh } from '../../../src/renderer/i18n/zh';

const updateText = zh.settings.update;

const upToDateInfo: UpdateInfo = {
  hasUpdate: false,
  currentVersion: '0.16.75',
};

const availableUpdateInfo: UpdateInfo = {
  hasUpdate: true,
  currentVersion: '0.16.75',
  latestVersion: '0.16.76',
};

type DesktopShellDiagnosticsOverrides = Partial<Omit<DesktopShellDiagnostics, 'app' | 'boot' | 'webServer'>> & {
  app?: Partial<DesktopShellDiagnostics['app']>;
  boot?: Partial<DesktopShellDiagnostics['boot']>;
  webServer?: Partial<DesktopShellDiagnostics['webServer']>;
};

function desktopShellDiagnostics(overrides: DesktopShellDiagnosticsOverrides = {}): DesktopShellDiagnostics {
  const base: DesktopShellDiagnostics = {
    schemaVersion: 1,
    generatedAt: '2026-06-24T00:00:00.000Z',
    app: {
      version: '0.16.102',
      mode: 'tauri',
      bundleId: 'com.linchen.code-agent',
      dataDir: '/Users/x/.code-agent',
      webPort: 8180,
      pid: 100,
    },
    boot: {
      stage: 'window-navigated',
      bootId: 'abc123',
      pid: 100,
      webServerPid: 200,
      diagnosticFile: '/Users/x/.code-agent/logs/desktop-shell-boot-latest.json',
      healthMatchedBootToken: true,
    },
    webServer: {
      url: 'http://localhost:8180',
      health: 'ok',
      pid: 200,
      serverRoot: '/Applications/Agent Neo.app/Contents/Resources/_up_',
    },
    renderer: {
      source: 'builtin',
      reason: 'no-active-meta',
      serveDir: '/app/dist/renderer',
      builtinDir: '/app/dist/renderer',
      activeDir: '/Users/x/.code-agent/renderer-cache/active',
      activeBundle: null,
      currentShellVersion: '0.16.102',
    },
    resources: [
      {
        id: 'web-server-script',
        label: 'webServer bundle',
        kind: 'web-server',
        path: '/app/dist/web/webServer.cjs',
        required: true,
        status: 'present',
      },
      {
        id: 'renderer-index',
        label: 'builtin renderer index',
        kind: 'renderer',
        path: '/app/dist/renderer/index.html',
        required: true,
        status: 'present',
      },
    ],
    runtimeAssets: null,
    rendererBundle: null,
    issues: [],
  };
  return {
    ...base,
    ...overrides,
    app: { ...base.app, ...overrides.app },
    boot: { ...base.boot, ...overrides.boot },
    webServer: { ...base.webServer, ...overrides.webServer },
  };
}

describe('UpdateSettings status visibility', () => {
  it('hides stale success status while a fresh check is running or failed', () => {
    expect(getVisibleUpdateInfo(upToDateInfo, false, null)).toBe(upToDateInfo);
    expect(getVisibleUpdateInfo(upToDateInfo, true, null)).toBeNull();
    expect(getVisibleUpdateInfo(upToDateInfo, false, updateText.checkError)).toBeNull();
  });

  it('treats a failed check as failure, not as up-to-date', () => {
    expect(isFailedUpdateCheck(null)).toBe(false);
    expect(isFailedUpdateCheck(upToDateInfo)).toBe(false);
    expect(isFailedUpdateCheck(availableUpdateInfo)).toBe(false);
    expect(isFailedUpdateCheck({ hasUpdate: false, currentVersion: '0.16.91', checkFailed: true })).toBe(true);
    // 检查失败时必须连同 error 一起隐藏旧的成功状态，不能渲染"已是最新"
    expect(getVisibleUpdateInfo(upToDateInfo, false, updateText.checkError)).toBeNull();
  });

  it('renders install progress: percent → install → relaunch', () => {
    expect(getInstallButtonLabel(false, null, updateText)).toBe(updateText.download);
    expect(getInstallButtonLabel(true, null, updateText)).toBe(updateText.install.preparing);
    expect(getInstallButtonLabel(true, { phase: 'download', downloaded: 5_000_000, total: 10_000_000 }, updateText))
      .toBe(`${updateText.install.downloadingPrefix}50%`);
    expect(getInstallButtonLabel(true, { phase: 'download', downloaded: 2_097_152 }, updateText))
      .toBe(`${updateText.install.downloadingPrefix}2.0${updateText.install.downloadedMbSuffix}`);
    expect(getInstallButtonLabel(true, { phase: 'install', downloaded: 10, total: 10 }, updateText)).toBe(updateText.install.installing);
    expect(getInstallButtonLabel(true, { phase: 'relaunch', downloaded: 10, total: 10 }, updateText)).toBe(updateText.install.relaunching);

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
    expect(getRuntimeAssetsSummaryText(null, updateText.runtimeAssets)).toBeNull();
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
      summary: { installed: 0, bundledFallback: 1, missing: 0, unsupported: 0 },
    }, updateText.runtimeAssets)).toBe(updateText.runtimeAssets.summary.imageReady);
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
      summary: { installed: 1, bundledFallback: 0, missing: 0, unsupported: 0 },
    }, updateText.runtimeAssets)).toBe(updateText.runtimeAssets.summary.allReady);
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
      summary: { installed: 0, bundledFallback: 1, missing: 1, unsupported: 0 },
    }, updateText.runtimeAssets)).toBe(updateText.runtimeAssets.summary.optionalWithBundled);
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
      summary: { installed: 0, bundledFallback: 0, missing: 1, unsupported: 0 },
    }, updateText.runtimeAssets)).toBe(
      `${updateText.runtimeAssets.displayNames.imageUnderstanding}${updateText.runtimeAssets.summary.unavailableSuffix}`,
    );
  });

  it('labels bundled Sharp fallback separately from optional runtime downloads', () => {
    expect(getRuntimeAssetStatusText({
      id: 'sharp-image-runtime',
      label: 'Image processing components',
      delivery: 'bundled',
      state: 'bundledFallback',
      nodeModules: [],
    }, updateText.runtimeAssets.status)).toBe(updateText.runtimeAssets.status.available);
    expect(getRuntimeAssetStatusText({
      id: 'playwright-browser-runtime',
      label: 'Browser automation components',
      delivery: 'optional',
      state: 'missing',
      nodeModules: [],
    }, updateText.runtimeAssets.status)).toBe(updateText.runtimeAssets.status.firstUseDownload);
    expect(getRuntimeAssetStatusText({
      id: 'onnxruntime-vad',
      label: 'Local audio capability components',
      delivery: 'optional',
      state: 'unsupported',
      nodeModules: [],
    }, updateText.runtimeAssets.status)).toBe(updateText.runtimeAssets.status.unsupported);
  });

  it('uses user-facing runtime capability names instead of package labels', () => {
    expect(getRuntimeAssetDisplayName({
      id: 'onnxruntime-vad',
      label: 'Local audio capability components',
      delivery: 'optional',
      state: 'missing',
      nodeModules: [],
    }, updateText.runtimeAssets.displayNames)).toBe(updateText.runtimeAssets.displayNames.audioInput);
    expect(getRuntimeAssetDisplayName({
      id: 'playwright-browser-runtime',
      label: 'Browser automation components',
      delivery: 'optional',
      state: 'missing',
      nodeModules: [],
    }, updateText.runtimeAssets.displayNames)).toBe(updateText.runtimeAssets.displayNames.browserAutomation);
    expect(getRuntimeAssetDisplayName({
      id: 'sharp-image-runtime',
      label: 'Image processing components',
      delivery: 'bundled',
      state: 'bundledFallback',
      nodeModules: [],
    }, updateText.runtimeAssets.displayNames)).toBe(updateText.runtimeAssets.displayNames.imageUnderstanding);
    expect(getRuntimeAssetDisplayName({
      id: 'computer-use-app',
      label: 'Agent Neo Computer Use app',
      delivery: 'bundled',
      state: 'bundledFallback',
      nodeModules: [],
    }, updateText.runtimeAssets.displayNames)).toBe(updateText.runtimeAssets.displayNames.computerUse);
    expect(getRuntimeAssetDisplayName({
      id: 'uv',
      label: 'uv sidecar binary',
      delivery: 'bundled',
      state: 'bundledFallback',
      nodeModules: [],
    }, updateText.runtimeAssets.displayNames)).toBe(updateText.runtimeAssets.displayNames.uv);
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
    expect(getRuntimeAssetsPrepareText(false, updateText.runtimeAssets)).toBe(updateText.runtimeAssets.prepareIdle);
    expect(getRuntimeAssetsPrepareText(true, updateText.runtimeAssets)).toBe(updateText.runtimeAssets.prepareBusy);
  });

  it('summarizes renderer bundle hot-update status', () => {
    const builtinStatus: RendererBundleStatus = {
      schemaVersion: 1,
      activeBundle: null,
      lastAttempt: null,
    };
    expect(getRendererBundleSummaryText(builtinStatus, updateText.rendererBundle.summary))
      .toBe(updateText.rendererBundle.summary.builtin);
    expect(getRendererBundleSummaryText({
      schemaVersion: 1,
      disabled: true,
      disabledReason: 'CODE_AGENT_DISABLE_RENDERER_HOT_UPDATE',
      activeBundle: { version: '0.16.93', contentHash: 'abc' },
      lastAttempt: null,
    }, updateText.rendererBundle.summary)).toBe(updateText.rendererBundle.summary.disabled);

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
    }, updateText.rendererBundle.summary)).toBe(`${updateText.rendererBundle.summary.appliedPrefix}0.16.94`);

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
    }, updateText.rendererBundle.summary)).toBe(updateText.rendererBundle.summary.rolledBack);

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
    }, updateText.rendererBundle.summary)).toBe(`${updateText.rendererBundle.summary.shellTooOldPrefix}0.16.93`);

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
    }, updateText.rendererBundle.summary)).toBe(updateText.rendererBundle.summary.missingCapability);

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
    }, updateText.rendererBundle.summary)).toBe(`${updateText.rendererBundle.summary.failedPrefix}envelope-untrusted`);
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

    expect(getRendererBundleDiagnosticRows(status, updateText.rendererBundle)).toEqual([
      { label: updateText.rendererBundle.diagnosticLabels.current, value: 'v0.16.93 · abcdef123456' },
      { label: updateText.rendererBundle.diagnosticLabels.recentCheck, value: 'skipped · already-current · 2026-06-06T00:00:00.000Z' },
      { label: updateText.rendererBundle.diagnosticLabels.candidateVersion, value: 'v0.16.93 · min shell v0.16.93 · 180 capabilities · 2 runtime assets · 1 resources' },
      { label: updateText.rendererBundle.diagnosticLabels.candidateHash, value: 'abcdef123456' },
      { label: updateText.rendererBundle.diagnosticLabels.manifest, value: 'https://oss.example/renderer-bundle/latest/manifest.json' },
      { label: updateText.rendererBundle.diagnosticLabels.policyDecision, value: 'use-manifest · policy-1 · fallback · rollout-percent-excluded' },
      { label: updateText.rendererBundle.diagnosticLabels.runtimePrepare, value: '1 installed · 1 skipped' },
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
    }, updateText.rendererBundle)).toEqual([
      { label: updateText.rendererBundle.diagnosticLabels.current, value: updateText.rendererBundle.diagnosticLabels.builtinVersion },
      { label: updateText.rendererBundle.diagnosticLabels.sourceEntry, value: 'channel · beta' },
      { label: updateText.rendererBundle.diagnosticLabels.manifestConfig, value: 'https://oss.example/renderer-bundle/channels/beta/manifest.json' },
      { label: updateText.rendererBundle.diagnosticLabels.policyEntry, value: 'https://agentneo.example/api/v1/control-plane?kind=renderer_bundle_rollout' },
      { label: updateText.rendererBundle.diagnosticLabels.cohort, value: 'staff' },
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
    }, updateText.rendererBundle)).toEqual([
      { label: updateText.rendererBundle.diagnosticLabels.current, value: updateText.rendererBundle.diagnosticLabels.builtinVersion },
      { label: updateText.rendererBundle.diagnosticLabels.sourceEntry, value: 'channel · ../beta' },
      {
        label: updateText.rendererBundle.diagnosticLabels.sourceError,
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
    }, updateText.rendererBundle)).toEqual([
      { label: updateText.rendererBundle.diagnosticLabels.current, value: updateText.rendererBundle.diagnosticLabels.builtinVersion },
      { label: updateText.rendererBundle.diagnosticLabels.disabledReason, value: 'CODE_AGENT_DISABLE_RENDERER_HOT_UPDATE' },
    ]);
  });

  it('summarizes desktop shell diagnostics across ok, warning, and error states', () => {
    expect(getDesktopShellSummaryText(desktopShellDiagnostics(), updateText.desktopShell.summary))
      .toBe(updateText.desktopShell.summary.ok);

    expect(getDesktopShellSummaryText(desktopShellDiagnostics({
      resources: [
        {
          id: 'control-plane-public-keys',
          label: 'control-plane public keys',
          kind: 'resource',
          path: '/app/dist/web/control-plane-public-keys.json',
          required: false,
          status: 'missing',
        },
      ],
      issues: [{ severity: 'warning', code: 'desktop-shell-optional-resource-missing', message: 'optional missing' }],
    }), updateText.desktopShell.summary)).toBe(updateText.desktopShell.summary.warning);

    expect(getDesktopShellSummaryText(desktopShellDiagnostics({
      boot: { stage: 'failed' },
      issues: [{ severity: 'error', code: 'desktop-shell-healthcheck-failed', message: 'timeout' }],
    }), updateText.desktopShell.summary)).toBe(updateText.desktopShell.summary.error);
  });

  it('renders desktop shell diagnostics rows without exposing raw tokens', () => {
    const rows = getDesktopShellDiagnosticRows(desktopShellDiagnostics({
      renderer: {
        source: 'active',
        reason: 'active-healthy',
        serveDir: '/data/renderer-cache/active',
        builtinDir: '/app/dist/renderer',
        activeDir: '/data/renderer-cache/active',
        activeBundle: { version: '0.16.103', contentHash: 'abcdef1234567890' },
        currentShellVersion: '0.16.103',
      },
      runtimeAssets: {
        runtimeBaseDir: '/runtime',
        activeManifestPath: '/runtime/active.json',
        assets: [{
          id: 'uv',
          label: 'uv sidecar binary',
          kind: 'tool-binary',
          delivery: 'bundled',
          state: 'bundledFallback',
          nodeModules: [],
          files: [{
            name: 'uv',
            path: '/app/scripts/uv',
            exists: true,
            executable: true,
            source: 'bundled',
          }],
          version: '0.11.16',
          minShellVersion: '0.16.103',
          platform: 'darwin-arm64',
          registry: {
            id: 'uv',
            label: 'uv sidecar binary',
            kind: 'tool-binary',
            delivery: 'bundled',
            state: 'bundledFallback',
            source: 'bundled',
            path: '/app/scripts/uv',
            version: '0.11.16',
            minShellVersion: '0.16.103',
            platform: 'darwin-arm64',
            hash: 'f63ec276fa13f8f392542a334c0f58f36833b24304831e5f4c221e2edf7a16f3',
            hashKind: 'pinnedBinarySha256',
            required: true,
          },
        }],
        summary: { installed: 1, bundledFallback: 1, missing: 0, unsupported: 0 },
      },
      boot: {
        previousFailure: {
          stage: 'web-server-spawned',
          recordedStage: 'failed',
          generatedAt: '2026-06-23T23:59:00.000Z',
          code: 'desktop-shell-healthcheck-failed',
          message: 'healthcheck timed out',
        },
      },
      repairActions: [
        {
          kind: 'clear-webserver-port',
          label: '清理 webServer 端口',
          reason: 'healthcheck 未确认当前壳进程',
        },
        {
          kind: 'disable-hot-renderer',
          label: '禁用 hot renderer',
          reason: 'renderer 热更可能影响当前壳加载',
        },
      ],
      channelIsolation: {
        channel: 'dev',
        status: 'ok',
        bundleId: 'com.linchen.code-agent.dev',
        dataDir: '/Users/x/.code-agent-dev',
        webPort: 8181,
        expectedWebPort: 8181,
        checks: [
          { id: 'data-dir', label: 'data dir', status: 'ok', detail: '/Users/x/.code-agent-dev' },
          { id: 'web-port', label: 'web port', status: 'ok', detail: '8181 (expected 8181)' },
          { id: 'bundle-id', label: 'bundle id', status: 'ok', detail: 'com.linchen.code-agent.dev' },
          { id: 'permission-bundle-id', label: 'permission bundle id', status: 'ok', detail: 'com.linchen.code-agent.dev' },
        ],
      },
      nativePermissions: {
        schemaVersion: 1,
        platform: 'darwin',
        checkedAtMs: 1000,
        bundleId: 'com.linchen.code-agent.dev',
        permissions: [
          {
            kind: 'microphone',
            label: 'Microphone',
            status: 'wrong_bundle_id',
            required: true,
            action: 'open_microphone_settings_for_current_bundle',
            bundleId: 'com.linchen.code-agent.dev',
          },
          {
            kind: 'screenCapture',
            label: 'Screen Recording',
            status: 'needs_restart',
            required: false,
            action: 'restart_after_grant',
            bundleId: 'com.linchen.code-agent.dev',
          },
        ],
        summary: {
          granted: 0,
          denied: 0,
          needsRestart: 1,
          wrongBundleId: 1,
          unknown: 0,
          unsupported: 0,
        },
      },
    }), updateText);

    expect(rows).toContainEqual({ label: updateText.desktopShell.diagnosticLabels.bootStage, value: 'window-navigated' });
    expect(rows).toContainEqual({ label: 'boot token', value: 'matched' });
    expect(rows).toContainEqual({ label: 'renderer', value: 'active · active-healthy' });
    expect(rows).toContainEqual({ label: 'active bundle', value: 'v0.16.103 · abcdef123456' });
    expect(rows).toContainEqual({
      label: updateText.desktopShell.diagnosticLabels.channelIsolation,
      value: 'dev · ok · port 8181/8181 · com.linchen.code-agent.dev',
    });
    expect(rows).toContainEqual({
      label: 'channel:data dir',
      value: 'ok · /Users/x/.code-agent-dev',
    });
    expect(rows).toContainEqual({ label: updateText.desktopShell.diagnosticLabels.runtimeLedger, value: '1 registered · 1 hashed · 1 min-shell' });
    expect(rows).toContainEqual({
      label: 'asset:uv',
      value: 'bundledFallback · bundled · darwin-arm64 · v0.11.16 · min 0.16.103 · pinnedBinarySha256:f63ec276fa13',
    });
    expect(rows).toContainEqual({
      label: updateText.desktopShell.diagnosticLabels.previousFailure,
      value: 'web-server-spawned · desktop-shell-healthcheck-failed · 2026-06-23T23:59:00.000Z',
    });
    expect(rows).toContainEqual({
      label: updateText.desktopShell.diagnosticLabels.repairActions,
      value: '清理 webServer 端口 · 禁用 hot renderer',
    });
    expect(rows).toContainEqual({ label: updateText.desktopShell.diagnosticLabels.systemPermissions, value: '0 granted · 1 needs_restart · 1 wrong_bundle_id' });
    expect(rows).toContainEqual({
      label: 'Microphone',
      value: 'wrong_bundle_id · required · open_microphone_settings_for_current_bundle · bundle com.linchen.code-agent.dev',
    });
    expect(rows.map((row) => row.value).join('\n')).not.toContain('tauri-');
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
