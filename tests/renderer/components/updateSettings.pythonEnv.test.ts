// ============================================================================
// Settings「本机功能」python-env 行四态展示 — N-PY-RUNTIME-K2
//
// installed / 首次使用下载 / 安装中+百分比 / 失败+原因+重试，zh 与 en 双语。
// 状态映射集中在 pythonEnvAssetRow helper（不进 UpdateSettings.tsx，god-file 限行）。
// ============================================================================

import { describe, expect, it } from 'vitest';
import type { RuntimeAssetStatusEntry } from '../../../src/shared/contract';
import { getRuntimeAssetDisplayKind } from '../../../src/shared/contract/update';
import { getPythonEnvAssetRowDisplay } from '../../../src/renderer/components/features/settings/tabs/pythonEnvAssetRow';
import { zh } from '../../../src/renderer/i18n/zh';
import { en } from '../../../src/renderer/i18n/en';

function pythonEnvAsset(state: RuntimeAssetStatusEntry['state']): RuntimeAssetStatusEntry {
  return {
    id: 'python-env',
    label: 'Python data runtime',
    delivery: 'optional',
    state,
    nodeModules: [],
  };
}

describe('python-env settings row', () => {
  it('maps the python-env asset to its own display kind', () => {
    expect(getRuntimeAssetDisplayKind(pythonEnvAsset('missing'))).toBe('pythonEnv');
    expect(getRuntimeAssetDisplayKind(pythonEnvAsset('installed'))).toBe('pythonEnv');
  });

  it('installed ⇒ ready label in both languages', () => {
    for (const text of [zh.settings.update.runtimeAssets, en.settings.update.runtimeAssets]) {
      const row = getPythonEnvAssetRowDisplay(pythonEnvAsset('installed'), null, text);
      expect(row?.statusText).toBe(text.status.available);
      expect(row?.failure).toBeUndefined();
      expect(row?.action).toBe('default');
    }
  });

  it('missing and idle ⇒ downloads-on-first-use label in both languages', () => {
    for (const text of [zh.settings.update.runtimeAssets, en.settings.update.runtimeAssets]) {
      const row = getPythonEnvAssetRowDisplay(pythonEnvAsset('missing'), null, text);
      expect(row?.statusText).toBe(text.status.firstUseDownload);
      expect(row?.action).toBe('default');
      expect(row?.failure).toBeUndefined();
    }
  });

  it('preparation installing 42% ⇒ installing label with percent, action hidden', () => {
    for (const text of [zh.settings.update.runtimeAssets, en.settings.update.runtimeAssets]) {
      const row = getPythonEnvAssetRowDisplay(
        pythonEnvAsset('missing'),
        { assetId: 'python-env', phase: 'installing', percent: 42.4 },
        text,
      );
      expect(row?.statusText).toBe(`${text.status.installing} 42%`);
      expect(row?.action).toBe('hide');
      expect(row?.failure).toBeUndefined();
    }
  });

  it('preparation installing without percent ⇒ bare installing label', () => {
    const row = getPythonEnvAssetRowDisplay(
      pythonEnvAsset('missing'),
      { assetId: 'python-env', phase: 'installing' },
      zh.settings.update.runtimeAssets,
    );
    expect(row?.statusText).toBe(zh.settings.update.runtimeAssets.status.installing);
  });

  it('preparation failed ⇒ failed label with localized reason (raw host string only as detail) and retry, zh+en', () => {
    const rawError = 'Python runtime install needs a package index, but both PyPI and the mirror are unreachable.';
    const logPath = '/Users/tester/.code-agent/runtimes/python/install.log';
    for (const text of [zh.settings.update.runtimeAssets, en.settings.update.runtimeAssets]) {
      const row = getPythonEnvAssetRowDisplay(
        pythonEnvAsset('missing'),
        { assetId: 'python-env', phase: 'failed', errorCode: 'PYTHON_RUNTIME_OFFLINE', error: rawError, logPath },
        text,
      );
      expect(row?.statusText).toBe(text.status.installFailed);
      // 主文案是本地化失败原因，不是 host 英文原文
      expect(row?.failure?.reasonText).toBe(text.failureReasons.offline);
      expect(row?.failure?.reasonText).not.toBe(rawError);
      // host 原文经 detail（title 提示）保留可达
      expect(row?.failure?.detail).toBe(rawError);
      expect(row?.failure?.logPath).toBe(logPath);
      expect(row?.action).toBe('retry');
    }
  });

  it('failed with PYTHON_RUNTIME_INSTALL_FAILED ⇒ installFailed copy in both languages', () => {
    const rawError = 'Python runtime install failed. See the install log and try again.';
    for (const text of [zh.settings.update.runtimeAssets, en.settings.update.runtimeAssets]) {
      const row = getPythonEnvAssetRowDisplay(
        pythonEnvAsset('missing'),
        { assetId: 'python-env', phase: 'failed', errorCode: 'PYTHON_RUNTIME_INSTALL_FAILED', error: rawError },
        text,
      );
      expect(row?.failure?.reasonText).toBe(text.failureReasons.installFailed);
      expect(row?.failure?.reasonText).not.toBe(rawError);
      expect(row?.failure?.detail).toBe(rawError);
    }
  });

  it('failed with unknown or missing code ⇒ localized fallback copy, never the raw host string', () => {
    const rawError = 'Python runtime install failed. See the install log and try again.';
    for (const errorCode of [undefined, 'SOME_FUTURE_CODE']) {
      const row = getPythonEnvAssetRowDisplay(
        pythonEnvAsset('missing'),
        { assetId: 'python-env', phase: 'failed', errorCode, error: rawError },
        zh.settings.update.runtimeAssets,
      );
      expect(row?.failure?.reasonText).toBe(zh.settings.update.runtimeAssets.failureReasons.fallback);
      expect(row?.failure?.reasonText).not.toBe(rawError);
      expect(row?.failure?.detail).toBe(rawError);
    }
  });

  it('unsupported platform ⇒ unsupported label', () => {
    const row = getPythonEnvAssetRowDisplay(pythonEnvAsset('unsupported'), null, zh.settings.update.runtimeAssets);
    expect(row?.statusText).toBe(zh.settings.update.runtimeAssets.status.unsupported);
  });

  it('non-python assets fall through to the generic renderer (helper returns null)', () => {
    const asset: RuntimeAssetStatusEntry = {
      id: 'playwright-browser-runtime',
      label: 'Browser automation components',
      delivery: 'optional',
      state: 'missing',
      nodeModules: [],
    };
    expect(getPythonEnvAssetRowDisplay(asset, null, zh.settings.update.runtimeAssets)).toBeNull();
  });
});
