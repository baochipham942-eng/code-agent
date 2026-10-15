// @vitest-environment jsdom
// ============================================================================
// Settings「本机功能」python-env 失败行渲染 — N-PY-RUNTIME-K2 rework r2
//
// 复检缺口：失败态把 host 英文原文当主文案塞进中文 UI，且 1440px 下徽章/按钮
// 被挤到换行、原因截断。这里钉住修复后的行为：本地化文案为主、原文只进
// title 提示、重试/查看日志按钮存在、失败原因独占主行下方一行（徽章与按钮
// nowrap 不 shrink）。zh 与 en 双语。
// ============================================================================

import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { RuntimeAssetStatusEntry } from '../../../src/shared/contract';
import { getPythonEnvAssetRowDisplay } from '../../../src/renderer/components/features/settings/tabs/pythonEnvAssetRow';
import { RuntimeAssetRow } from '../../../src/renderer/components/features/settings/tabs/RuntimeAssetRow';
import { zh } from '../../../src/renderer/i18n/zh';
import { en } from '../../../src/renderer/i18n/en';

const RAW_HOST_ERROR =
  'Python runtime install needs a package index, but both PyPI and the mirror are unreachable. Check the network and try again.';
const LOG_PATH = '/Users/tester/.code-agent/runtimes/python/install.log';

function pythonEnvAsset(state: RuntimeAssetStatusEntry['state']): RuntimeAssetStatusEntry {
  return {
    id: 'python-env',
    label: 'Python data runtime',
    delivery: 'optional',
    state,
    nodeModules: [],
  };
}

function renderFailedRow(text: typeof zh.settings.update.runtimeAssets, logPath?: string) {
  const asset = pythonEnvAsset('missing');
  const pythonEnvRow = getPythonEnvAssetRowDisplay(
    asset,
    { assetId: 'python-env', phase: 'failed', errorCode: 'PYTHON_RUNTIME_OFFLINE', error: RAW_HOST_ERROR, logPath },
    text,
  );
  const onPrepare = vi.fn();
  const onOpenInstallLog = vi.fn();
  const utils = render(
    <RuntimeAssetRow
      asset={asset}
      pythonEnvRow={pythonEnvRow}
      text={text}
      preparingAssetId={null}
      isPreparing={false}
      forceRetryLabel={false}
      actionsDisabled={false}
      onPrepare={onPrepare}
      onOpenInstallLog={onOpenInstallLog}
    />,
  );
  return { ...utils, onPrepare, onOpenInstallLog };
}

afterEach(cleanup);

describe('python-env 失败行渲染（rework r2）', () => {
  it.each([
    ['zh', zh.settings.update.runtimeAssets],
    ['en', en.settings.update.runtimeAssets],
  ] as const)('%s：本地化失败文案为主，host 原文不进可见文本、只在 title 提示里可达', (_lang, text) => {
    renderFailedRow(text, LOG_PATH);

    // 本地化主文案可见
    expect(screen.getByTestId('runtime-asset-failure-python-env').textContent).toBe(
      text.failureReasons.offline,
    );
    // host 英文原文绝不作为可见主文案
    expect(bodyText()).not.toContain(RAW_HOST_ERROR);
    // 原文经 title 提示保留可达（排查用）
    expect(screen.getByTestId('runtime-asset-failure-python-env').getAttribute('title')).toBe(RAW_HOST_ERROR);
  });

  it.each([
    ['zh', zh.settings.update.runtimeAssets],
    ['en', en.settings.update.runtimeAssets],
  ] as const)('%s：重试与查看日志按钮都在，查看日志带回日志路径', (_lang, text) => {
    const { onPrepare, onOpenInstallLog } = renderFailedRow(text, LOG_PATH);

    const retry = screen.getByRole('button', { name: text.retryAsset });
    fireEvent.click(retry);
    expect(onPrepare).toHaveBeenCalledWith('python-env');

    const openLog = screen.getByTestId('runtime-asset-open-log-python-env');
    expect(openLog.textContent).toBe(text.openInstallLog);
    fireEvent.click(openLog);
    expect(onOpenInstallLog).toHaveBeenCalledWith(LOG_PATH);
  });

  it('没有日志路径时不渲染「查看日志」按钮，重试仍在', () => {
    renderFailedRow(zh.settings.update.runtimeAssets, undefined);
    expect(screen.queryByTestId('runtime-asset-open-log-python-env')).toBeNull();
    expect(screen.getByRole('button', { name: zh.settings.update.runtimeAssets.retryAsset })).toBeTruthy();
  });

  it('失败原因独占主行下方一行：徽章与按钮 nowrap 不 shrink，不被原因挤压', () => {
    renderFailedRow(zh.settings.update.runtimeAssets, LOG_PATH);

    const row = screen.getByTestId('runtime-asset-row-python-env');
    // 两行结构：主行（名称+徽章+按钮）与失败原因行
    expect(row.children.length).toBe(2);
    const [mainLine, failureLine] = Array.from(row.children);

    // 徽章与重试按钮在主行，且不换行、不被压缩
    const badge = mainLine.querySelector('span.border') as HTMLElement;
    expect(badge.classList.contains('whitespace-nowrap')).toBe(true);
    expect(badge.classList.contains('shrink-0')).toBe(true);
    const retry = screen.getByRole('button', { name: zh.settings.update.runtimeAssets.retryAsset });
    expect(mainLine.contains(retry)).toBe(true);
    expect(retry.classList.contains('whitespace-nowrap')).toBe(true);
    expect(retry.classList.contains('shrink-0')).toBe(true);

    // 失败原因 + 查看日志在第二行，不在主行里
    expect(failureLine.contains(screen.getByTestId('runtime-asset-failure-python-env'))).toBe(true);
    expect(failureLine.contains(screen.getByTestId('runtime-asset-open-log-python-env'))).toBe(true);
    expect(mainLine.contains(screen.getByTestId('runtime-asset-failure-python-env'))).toBe(false);
  });

  it('非 python 资产（helper 返回 null）走通用渲染：无失败行', () => {
    const asset: RuntimeAssetStatusEntry = {
      id: 'playwright-browser-runtime',
      label: 'Browser automation components',
      delivery: 'optional',
      state: 'missing',
      nodeModules: [],
    };
    render(
      <RuntimeAssetRow
        asset={asset}
        pythonEnvRow={null}
        text={zh.settings.update.runtimeAssets}
        preparingAssetId={null}
        isPreparing={false}
        forceRetryLabel={false}
        actionsDisabled={false}
        onPrepare={() => {}}
        onOpenInstallLog={() => {}}
      />,
    );
    expect(screen.queryByTestId('runtime-asset-failure-playwright-browser-runtime')).toBeNull();
    expect(screen.getByText('首次使用时下载')).toBeTruthy();
  });
});

// document.body 的可见文本（title 属性不算 textContent，正好用来区分主文案与提示）
function bodyText(): string {
  return document.body.textContent ?? '';
}
