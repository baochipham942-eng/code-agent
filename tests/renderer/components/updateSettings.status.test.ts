import { describe, expect, it } from 'vitest';
import type { UpdateInfo } from '../../../src/shared/contract';
import {
  getRuntimeAssetStatusText,
  getRuntimeAssetsPrepareText,
  getRuntimeAssetsSummaryText,
  getVisibleUpdateInfo,
  shouldShowRuntimeAssetsPrepare,
  shouldClearUpdateInfoBeforeCheck,
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
    })).toBe('使用内置能力组件');
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
    })).toBe('已准备 1 个本地能力组件');
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
    })).toBe('内置图片能力可用，可选能力可准备');
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
    })).toBe('内置能力组件缺失');
  });

  it('labels bundled Sharp fallback separately from optional runtime preparation', () => {
    expect(getRuntimeAssetStatusText({
      id: 'sharp-image-runtime',
      label: 'Image processing components',
      delivery: 'bundled',
      state: 'bundledFallback',
      nodeModules: [],
    })).toBe('随包内置');
    expect(getRuntimeAssetStatusText({
      id: 'playwright-browser-runtime',
      label: 'Browser automation components',
      delivery: 'optional',
      state: 'missing',
      nodeModules: [],
    })).toBe('可选准备');
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
    expect(getRuntimeAssetsPrepareText(false)).toBe('准备本地能力组件');
    expect(getRuntimeAssetsPrepareText(true)).toBe('正在准备本地能力组件...');
  });
});
