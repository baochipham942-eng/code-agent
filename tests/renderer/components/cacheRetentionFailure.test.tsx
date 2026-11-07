// @vitest-environment jsdom
import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { en } from '../../../src/renderer/i18n/en';
import { zh } from '../../../src/renderer/i18n/zh';

const h = vi.hoisted(() => ({
  invokeDomain: vi.fn(),
  openNativePath: vi.fn(async () => undefined),
}));

vi.mock('../../../src/renderer/services/tauriPluginFacade', () => ({ openNativePath: h.openNativePath }));
vi.mock('../../../src/renderer/services/ipcService', () => ({
  default: { invokeDomain: h.invokeDomain },
}));
vi.mock('../../../src/renderer/services/persistenceHealth', () => ({
  describePersistenceBanner: () => null,
  fetchWebPersistenceHealth: async () => null,
  getPersistenceWarningText: () => '',
  shouldShowPersistenceWarning: () => false,
}));
vi.mock('../../../src/renderer/hooks/useI18n', () => ({ useI18n: () => ({ t: zh, language: 'zh' }) }));
vi.mock('../../../src/renderer/components/features/settings/WebModeBanner', () => ({ WebModeBanner: () => null }));

import { DataSettings } from '../../../src/renderer/components/features/settings/tabs/DataSettings';
import { CacheRetentionFailureLine } from '../../../src/renderer/components/features/settings/sections/cacheRetentionFailure';

const EACCES_RAW = "EACCES: permission denied, unlink '/Users/x/.code-agent/appshots/a.png'";
const DATA_DIR = '/Users/x/.code-agent';

function status(failedCurrent: number, lastError?: string) {
  return { lastSweepAt: 1, deletedTotal: 0, failedTotal: failedCurrent, failedCurrent, lastError, dataDir: DATA_DIR };
}

afterEach(() => cleanup());

describe('CacheRetentionFailureLine', () => {
  it('权限类错误：权限主文案 + 两个按钮 + 折叠详情里才有原始错误', () => {
    const onRetry = vi.fn();
    const { container } = render(
      <CacheRetentionFailureLine failedCount={2} lastError={EACCES_RAW} dataDir={DATA_DIR} text={zh.settings.data.cacheRetention} onRetry={onRetry} />,
    );
    expect(screen.getByText(/有 2 项应用缓存删不掉：没有删除权限/)).toBeTruthy();
    // 主文案不含裸 errno / 路径
    expect(screen.getByText(/有 2 项/).textContent).not.toMatch(/EACCES|\/Users/);
    fireEvent.click(screen.getByText('打开数据文件夹'));
    expect(h.openNativePath).toHaveBeenCalledWith(DATA_DIR);
    fireEvent.click(screen.getByText('重试'));
    expect(onRetry).toHaveBeenCalledTimes(1);
    const details = container.querySelector('details');
    expect(details).toBeTruthy();
    expect(details!.hasAttribute('open')).toBe(false);
    expect(details!.textContent).toContain(EACCES_RAW);
  });

  it('其他错误走通用主文案', () => {
    render(<CacheRetentionFailureLine failedCount={3} lastError="database is locked" dataDir={DATA_DIR} text={zh.settings.data.cacheRetention} onRetry={() => {}} />);
    expect(screen.getByText(/有 3 项应用缓存删不掉，这次清理没有完成/)).toBeTruthy();
  });
});

describe('DataSettings cache retention wiring', () => {
  beforeEach(() => {
    h.invokeDomain.mockReset();
    h.openNativePath.mockClear();
  });

  function mockIpc(statuses: unknown[]) {
    h.invokeDomain.mockImplementation(async (_domain: string, action: string) => {
      if (action === 'getCacheRetentionStatus') return statuses[0];
      if (action === 'retryCacheRetention') return statuses[1];
      return null;
    });
  }

  it('failedCurrent=2 + EACCES：显示失败行；点重试调 retry action，成功后行消失', async () => {
    mockIpc([status(2, EACCES_RAW), status(0)]);
    render(<DataSettings />);
    expect(await screen.findByText(/有 2 项应用缓存删不掉：没有删除权限/)).toBeTruthy();
    fireEvent.click(screen.getByText('重试'));
    await waitFor(() => expect(screen.queryByText(/应用缓存删不掉/)).toBeNull());
    expect(h.invokeDomain.mock.calls.map((c) => c[1])).toContain('retryCacheRetention');
  });

  it('failedCurrent=0：什么都不渲染', async () => {
    mockIpc([status(0)]);
    render(<DataSettings />);
    await waitFor(() => expect(h.invokeDomain.mock.calls.map((c) => c[1])).toContain('getCacheRetentionStatus'));
    expect(screen.queryByText(/应用缓存删不掉/)).toBeNull();
    expect(screen.queryByText('打开数据文件夹')).toBeNull();
  });
});

describe('cacheRetention i18n', () => {
  it('zh/en 键对称', () => {
    expect(Object.keys(en.settings.data.cacheRetention).sort()).toEqual(Object.keys(zh.settings.data.cacheRetention).sort());
    for (const key of Object.keys(zh.settings.data.cacheRetention) as Array<keyof typeof zh.settings.data.cacheRetention>) {
      expect(en.settings.data.cacheRetention[key]).toBeTruthy();
    }
  });
});
