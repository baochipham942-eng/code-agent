import { describe, expect, it } from 'vitest';
import type { UpdateInfo } from '../../../src/shared/contract';
import {
  getRuntimeAssetDisplayName,
  getRuntimeAssetStatusText,
  getRuntimeAssetsPrepareText,
  getRuntimeAssetsSummaryText,
  getVisibleUpdateInfo,
  shouldShowRuntimeAssetsPrepare,
  shouldClearUpdateInfoBeforeCheck,
  shouldDisableUpdateActions,
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
    })).toBe('基础图片处理已就绪');
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
    })).toBe('语音和浏览器操作已就绪');
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
    })).toBe('图片已可用；需要语音或浏览器操作时再下载');
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
    })).toBe('随应用提供的基础能力缺失');
  });

  it('labels bundled Sharp fallback separately from optional runtime downloads', () => {
    expect(getRuntimeAssetStatusText({
      id: 'sharp-image-runtime',
      label: 'Image processing components',
      delivery: 'bundled',
      state: 'bundledFallback',
      nodeModules: [],
    })).toBe('已内置');
    expect(getRuntimeAssetStatusText({
      id: 'playwright-browser-runtime',
      label: 'Browser automation components',
      delivery: 'optional',
      state: 'missing',
      nodeModules: [],
    })).toBe('按需下载');
  });

  it('uses user-facing runtime capability names instead of package labels', () => {
    expect(getRuntimeAssetDisplayName({
      id: 'onnxruntime-vad',
      label: 'Local audio capability components',
      delivery: 'optional',
      state: 'missing',
      nodeModules: [],
    })).toBe('音频处理');
    expect(getRuntimeAssetDisplayName({
      id: 'playwright-browser-runtime',
      label: 'Browser automation components',
      delivery: 'optional',
      state: 'missing',
      nodeModules: [],
    })).toBe('浏览器操控');
    expect(getRuntimeAssetDisplayName({
      id: 'sharp-image-runtime',
      label: 'Image processing components',
      delivery: 'bundled',
      state: 'bundledFallback',
      nodeModules: [],
    })).toBe('图片处理');
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
    expect(getRuntimeAssetsPrepareText(false)).toBe('下载语音和浏览器能力');
    expect(getRuntimeAssetsPrepareText(true)).toBe('正在下载语音和浏览器能力...');
  });
});
