// @vitest-environment jsdom

import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import type { DeliverableShareLinkInfo } from '../../../src/shared/contract';

const mocks = vi.hoisted(() => ({
  invokeDomain: vi.fn(),
  openSettingsTab: vi.fn(),
  toastSuccess: vi.fn(),
  toastError: vi.fn(),
}));

vi.mock('../../../src/renderer/hooks/useI18n', async () => {
  const { zh } = await import('../../../src/renderer/i18n/zh');
  return { useI18n: () => ({ t: zh, language: 'zh' as const }) };
});

vi.mock('../../../src/renderer/stores/appStore', () => ({
  useAppStore: (selector: (state: { openSettingsTab: typeof mocks.openSettingsTab }) => unknown) => selector({
    openSettingsTab: mocks.openSettingsTab,
  }),
}));

vi.mock('../../../src/renderer/services/ipcService', () => ({
  default: { invokeDomain: mocks.invokeDomain },
}));

vi.mock('../../../src/renderer/hooks/useToast', () => ({
  toast: { success: mocks.toastSuccess, error: mocks.toastError },
}));

import { ShareLinkPanel } from '../../../src/renderer/components/features/chat/MessageBubble/ShareLinkPanel';

const activeShare = {
  token: 'token-1',
  url: 'https://share.llmxy.xyz/d/token-1',
  expiresAt: null,
  createdAt: 1_700_000_000_000,
  ttlSeconds: 0,
  pushedVersion: 2,
  pushedHash: 'hash-v2',
};

function renderState(info: DeliverableShareLinkInfo) {
  mocks.invokeDomain.mockResolvedValue(info);
  return render(
    <ShareLinkPanel
      isOpen
      filePath="/workspace/report.md"
      title="季度报告"
      onClose={vi.fn()}
    />,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  window.localStorage.clear();
});

afterEach(cleanup);

describe('ShareLinkPanel states', () => {
  it('shows the first-upload disclosure and defaults to seven days before generation', async () => {
    renderState({ share: null, stale: false, latestPublishedVersion: 1, tokenConfigured: true });

    expect(await screen.findByTestId('share-link-empty')).toBeTruthy();
    expect(screen.getByText('发布版文件将离开本机')).toBeTruthy();
    expect(screen.getByRole('button', { name: '7 天' }).getAttribute('aria-pressed')).toBe('true');
    expect(screen.getByRole('button', { name: '上传并生成链接' })).toBeTruthy();
  });

  it('shows a generated link, current content version, expiry, and the single audience tier', async () => {
    renderState({ share: activeShare, stale: false, latestPublishedVersion: 2, tokenConfigured: true });

    expect(await screen.findByTestId('share-link-active')).toBeTruthy();
    expect(screen.getByDisplayValue(activeShare.url)).toBeTruthy();
    expect(screen.getByText('内容 = v2')).toBeTruthy();
    expect(screen.getByText('有链接的人')).toBeTruthy();
    expect(screen.getAllByText('永久')).toHaveLength(2);
  });

  it('shows stale content with the latest version and a retry action', async () => {
    renderState({ share: activeShare, stale: true, latestPublishedVersion: 3, tokenConfigured: true });

    expect(await screen.findByTestId('share-link-stale')).toBeTruthy();
    expect(screen.getByText('链接内容落后于 v3')).toBeTruthy();
    expect(screen.getByRole('button', { name: '重新推送' })).toBeTruthy();
  });

  it('shows revoked state, 24-hour grace copy, and generation of a new token', async () => {
    renderState({
      share: { ...activeShare, revokedAt: 1_700_000_100_000 },
      stale: false,
      latestPublishedVersion: 2,
      tokenConfigured: true,
    });

    expect(await screen.findByTestId('share-link-inactive')).toBeTruthy();
    expect(screen.getByText('链接已撤销')).toBeTruthy();
    expect(screen.getByText('已打开的人 24 小时内仍能看。')).toBeTruthy();
    expect(screen.getByRole('button', { name: '重新生成' })).toBeTruthy();
  });

  it('shows the settings route when the upload token is missing', async () => {
    renderState({ share: null, stale: false, latestPublishedVersion: 1, tokenConfigured: false });

    expect(await screen.findByTestId('share-link-token-missing')).toBeTruthy();
    expect(screen.getByText('去设置填分享服务 token。')).toBeTruthy();
    expect((screen.getByRole('button', { name: '上传并生成链接' }) as HTMLButtonElement).disabled).toBe(true);
  });
});
