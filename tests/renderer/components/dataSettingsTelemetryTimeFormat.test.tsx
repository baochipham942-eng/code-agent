// @vitest-environment jsdom
// ============================================================================
// DataSettings 遥测最近事件行时间口径（N-CRON-DETAIL-TIME-FORMAT-MIXED-FU1 返修）：
// formatLastEventAt 走相对时段分支之外（>=24h）落到 utils/formatDateTime(ts, lang)，
// zh 24 小时制带年份、绝不跟机器 locale 出 AM/PM；en 维持 en-US 原样。
// 这是返修④的「设置页渲染证据」：中文 UI 下 DataSettings 真渲染出 24 小时制串。
// ============================================================================
import React from 'react';
import { cleanup, render, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ invoke: vi.fn(), invokeDomain: vi.fn() }));

vi.mock('../../../src/renderer/services/ipcService', () => ({
  default: {
    isAvailable: () => false,
    invoke: h.invoke,
    invokeDomain: h.invokeDomain,
    on: () => () => {},
    off: vi.fn(),
  },
}));
vi.mock('../../../src/renderer/services/persistenceHealth', () => ({
  describePersistenceBanner: () => null,
  fetchWebPersistenceHealth: async () => null,
  getPersistenceWarningText: () => '',
  shouldShowPersistenceWarning: () => false,
}));
vi.mock('../../../src/renderer/stores/authStore', () => ({
  useAuthStore: (selector: (state: { user: { isAdmin: boolean } | null }) => unknown) =>
    selector({ user: { isAdmin: true } }),
}));
vi.mock('../../../src/renderer/components/features/settings/WebModeBanner', () => ({
  WebModeBanner: () => null,
}));

import { DataSettings } from '../../../src/renderer/components/features/settings/tabs/DataSettings';
import { useAppStore } from '../../../src/renderer/stores/appStore';

// formatLastEventAt 对 <24h 的时间走「刚刚/N分钟前」相对分支，永远到不了 formatDateTime；
// 这里取一个固定早于当下的本地时间戳（2025-01-09 16:05 本地，不做时区换算），稳定落进
// formatDateTime 分支，时分字段在任何 TZ 下都是构造值本身。
const LAST_EVENT_AT = new Date(2025, 0, 9, 16, 5, 0).getTime();
const ZH = '2025/01/09 16:05';
const EN = '1/9/2025, 4:05:00 PM';

beforeEach(() => {
  h.invoke.mockReset();
  h.invokeDomain.mockReset();
  h.invoke.mockImplementation((channel: string) => {
    if (channel === 'telemetry:health') {
      return Promise.resolve({
        enabled: true,
        sessionCount: 7,
        storageBytes: 4096,
        lastEventAt: LAST_EVENT_AT,
        lastUploadError: 'UPLOAD_FAILED',
        lastUploadErrorAt: LAST_EVENT_AT,
        uploadFailureCount: 2,
      });
    }
    return Promise.resolve(null);
  });
  h.invokeDomain.mockResolvedValue(null);
  useAppStore.setState({ language: 'zh' });
});

afterEach(cleanup);

describe('DataSettings 遥测最近事件行（跟随 UI language）', () => {
  it('zh UI：最近事件与上传失败摘要 24 小时制带年份，无 AM/PM', async () => {
    const { container } = render(<DataSettings />);
    await waitFor(() => {
      expect(container.textContent).toContain(`最近事件：${ZH}`);
    });
    // 第二个调用点：上传失败摘要模板里的 {time} 同走 formatDateTime
    expect(container.textContent).toContain(`上传失败 2 次 · 最近 ${ZH}`);
    expect(container.textContent).not.toMatch(/AM|PM/);
  });

  it('en UI：维持 en-US 原样（英文 UI 行为不变）', async () => {
    useAppStore.setState({ language: 'en' });
    const { container } = render(<DataSettings />);
    await waitFor(() => {
      expect(container.textContent).toContain(`Latest event: ${EN}`);
    });
    expect(container.textContent).toContain(`Upload failed 2 times · latest ${EN}`);
    expect(container.textContent).not.toContain('16:05');
  });
});
