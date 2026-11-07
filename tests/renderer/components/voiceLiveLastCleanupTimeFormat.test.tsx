// @vitest-environment jsdom
// ============================================================================
// VoiceLiveSettingsSection 录音台账「最近清理」时间口径（N-CRON-DETAIL-TIME-FORMAT-MIXED-FU1 返修）：
// recordCallsLastCleanup 模板里的 {time} 改走 utils/formatDateTime(at, uiLanguage)，
// zh 24 小时制带年份、绝不跟机器 locale 出 AM/PM；en 维持 en-US 原样。
// 注意组件内的 language state 是语音会话语言（auto/zh/en），与 UI 语言无关——
// 这里只驱动 useI18n 的 UI 语言。
// ============================================================================
import React from 'react';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const invokeDomainMock = vi.hoisted(() => vi.fn());
const availability = vi.hoisted(() => ({
  enabled: true,
  configured: true,
  usage: { monthSeconds: 0, monthCalls: 0, monthFailedAttempts: 0 } as import('../../../src/shared/contract/voice').VoiceStatusResponse['usage'],
}));

vi.mock('../../../src/renderer/services/ipcService', () => ({
  default: {
    isAvailable: () => false,
    invoke: vi.fn(),
    invokeDomain: (...args: unknown[]) => invokeDomainMock(...args),
    on: () => () => {},
    off: vi.fn(),
  },
}));
vi.mock('../../../src/renderer/components/features/voice/useVoiceLiveAvailability', () => ({
  useVoiceLiveAvailability: () => availability,
}));
vi.mock('../../../src/renderer/utils/logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

import { VoiceLiveSettingsSection } from '../../../src/renderer/components/features/settings/tabs/VoiceLiveSettingsSection';
import { useAppStore } from '../../../src/renderer/stores/appStore';

// 本地时区构造（不跨时区换算），任何 TZ 下时分字段都是构造值本身。
const CLEANUP_AT = new Date(2026, 10, 9, 16, 5, 0).getTime(); // 2026-11-09 16:05
const ZH = '2026/11/09 16:05';
const EN = '11/9/2026, 4:05:00 PM';

const OVERVIEW = {
  dir: '/tmp/voice-recordings',
  count: 2,
  totalBytes: 2 * 1024 * 1024,
  lastCleanup: {
    at: CLEANUP_AT,
    deleted: 3,
    freedBytes: 1024 * 1024,
    byRule: { age: 1, count: 0, bytes: 0 },
  },
  limits: { retentionDays: 30, maxBytes: 0, maxCalls: 0 },
};

beforeEach(() => {
  invokeDomainMock.mockReset();
  invokeDomainMock.mockImplementation((_domain: string, action: string) => {
    if (action === 'recordingOverview') return Promise.resolve(OVERVIEW);
    return Promise.resolve(undefined);
  });
  useAppStore.setState({ language: 'zh' });
  (navigator as unknown as { mediaDevices?: unknown }).mediaDevices = {
    enumerateDevices: vi.fn(() => Promise.resolve([])),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  };
});

afterEach(() => {
  cleanup();
  delete (navigator as unknown as { mediaDevices?: unknown }).mediaDevices;
});

describe('VoiceLiveSettingsSection 录音最近清理行（跟随 UI language）', () => {
  it('zh UI：最近清理的 {time} 为 24 小时制带年份，无 AM/PM', async () => {
    render(<VoiceLiveSettingsSection />);
    await waitFor(() => {
      expect(screen.getByTestId('call-recording-cleanup').textContent).toContain(`最近清理：${ZH}`);
    });
    expect(screen.getByTestId('call-recording-cleanup').textContent).not.toMatch(/AM|PM/);
  });

  it('en UI：维持 en-US 原样（英文 UI 行为不变）', async () => {
    useAppStore.setState({ language: 'en' });
    render(<VoiceLiveSettingsSection />);
    await waitFor(() => {
      expect(screen.getByTestId('call-recording-cleanup').textContent).toContain(`Last cleanup: ${EN}`);
    });
    expect(screen.getByTestId('call-recording-cleanup').textContent).not.toContain('16:05');
  });
});
