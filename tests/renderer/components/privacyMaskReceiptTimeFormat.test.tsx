// @vitest-environment jsdom
// ============================================================================
// PrivacySettings 出站掩码回执卡时间口径（N-CRON-DETAIL-TIME-FORMAT-MIXED-FU1 返修）：
// metaLine 的裸 toLocaleTimeString 改走 utils/formatDateTime(ts, language)，
// zh 24 小时制带年份、绝不跟机器 locale 出 AM/PM；en 维持 en-US 原样。
// web 模式（isWebMode=true）短路桌面专属段，只走 SETTINGS 域 IPC。
// ============================================================================
import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { IPC_DOMAINS } from '../../../src/shared/ipc';

const invokeDomain = vi.hoisted(() => vi.fn());
const isWebMode = vi.hoisted(() => vi.fn(() => true));

vi.mock('../../../src/renderer/utils/platform', () => ({ isWebMode }));
vi.mock('../../../src/renderer/stores/authStore', () => ({
  useAuthStore: (selector: (state: { user: { isAdmin: boolean } | null }) => unknown) =>
    selector({ user: { isAdmin: true } }),
}));
vi.mock('../../../src/renderer/services/ipcService', () => ({
  default: { invokeDomain: (...args: unknown[]) => invokeDomain(...args), on: vi.fn() },
}));

import PrivacySettings from '../../../src/renderer/components/features/settings/tabs/PrivacySettings';
import { useAppStore } from '../../../src/renderer/stores/appStore';

// 本地时区构造（不跨时区换算），任何 TZ 下时分字段都是构造值本身。
const RECORD_AT = new Date(2026, 10, 9, 16, 5, 0).getTime(); // 2026-11-09 16:05
const ZH = '2026/11/09 16:05';
const EN = '11/9/2026, 4:05:00 PM';

beforeEach(() => {
  invokeDomain.mockReset();
  invokeDomain.mockImplementation((domain: string, action: string) => {
    if (domain === IPC_DOMAINS.SETTINGS && action === 'get') {
      // outboundSecretMask=true 才会触发回执记录的读取（getOutboundMaskRecords）
      return Promise.resolve({ privacy: { outboundSecretMask: true } });
    }
    if (domain === IPC_DOMAINS.SETTINGS && action === 'getOutboundMaskRecords') {
      return Promise.resolve([
        { timestamp: RECORD_AT, provider: 'openai', model: 'gpt-5', replacements: [] },
      ]);
    }
    if (domain === IPC_DOMAINS.SETTINGS && action === 'listPermissionGrants') return Promise.resolve([]);
    return Promise.resolve(null);
  });
  useAppStore.setState({ language: 'zh' });
});

afterEach(() => {
  cleanup();
  isWebMode.mockReturnValue(true);
});

describe('PrivacySettings 出站掩码回执 metaLine（跟随 UI language）', () => {
  it('zh UI：回执 metaLine 为 24 小时制带年份，无 AM/PM', async () => {
    render(<PrivacySettings />);
    await waitFor(() => {
      expect(screen.getByTestId('privacy-outbound-mask-receipt-summary')).toBeTruthy();
    });
    // metaLine（provider · model · 时间）只在展开区渲染
    fireEvent.click(screen.getByTestId('privacy-outbound-mask-receipt-toggle'));
    const rows = screen.getByTestId('privacy-outbound-mask-receipt-rows');
    expect(rows.textContent).toContain(ZH);
    expect(rows.textContent).toContain('openai · gpt-5');
    expect(rows.textContent).not.toMatch(/AM|PM/);
  });

  it('en UI：维持 en-US 原样（英文 UI 行为不变）', async () => {
    useAppStore.setState({ language: 'en' });
    render(<PrivacySettings />);
    await waitFor(() => {
      expect(screen.getByTestId('privacy-outbound-mask-receipt-summary')).toBeTruthy();
    });
    fireEvent.click(screen.getByTestId('privacy-outbound-mask-receipt-toggle'));
    const rows = screen.getByTestId('privacy-outbound-mask-receipt-rows');
    expect(rows.textContent).toContain(EN);
    expect(rows.textContent).not.toContain('16:05');
  });
});
