// @vitest-environment jsdom
// ============================================================================
// ProviderDoctorDialog 诊断摘要行时间口径（N-CRON-DETAIL-TIME-FORMAT-MIXED-FU1 返修）：
// 摘要里的裸 toLocaleTimeString 改走 utils/formatDateTime(ts, language)，
// zh 24 小时制带年份、绝不跟机器 locale 出 AM/PM；en 维持 en-US 原样。
// run_doctor 经按钮触发：开弹窗 → 点「开始诊断」→ 等摘要行上屏。
// ============================================================================
import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const invokeDomain = vi.hoisted(() => vi.fn());

vi.mock('../../../src/renderer/services/ipcService', () => ({
  default: {
    isAvailable: () => false,
    invoke: vi.fn(),
    invokeDomain: (...args: unknown[]) => invokeDomain(...args),
    on: () => () => {},
    off: vi.fn(),
  },
}));
vi.mock('../../../src/renderer/hooks/useToast', () => ({
  toast: { show: vi.fn(), success: vi.fn(), error: vi.fn() },
}));

import { ProviderDoctorDialog } from '../../../src/renderer/components/features/settings/ProviderDoctorDialog';
import { useAppStore } from '../../../src/renderer/stores/appStore';

// 本地时区构造（不跨时区换算），任何 TZ 下时分字段都是构造值本身。
const REPORT_AT = new Date(2026, 10, 9, 16, 5, 0).getTime(); // 2026-11-09 16:05
const ZH = '2026/11/09 16:05';
const EN = '11/9/2026, 4:05:00 PM';

const REPORT = {
  timestamp: REPORT_AT,
  durationMs: 1234,
  items: [
    { category: 'environment', name: 'Node.js version', status: 'pass', message: 'Node.js v22' },
  ],
  summary: { pass: 1, warn: 0, fail: 0, skip: 0 },
};

beforeEach(() => {
  invokeDomain.mockReset();
  invokeDomain.mockResolvedValue(REPORT);
  useAppStore.setState({ language: 'zh' });
});

afterEach(cleanup);

describe('ProviderDoctorDialog 诊断摘要时间（跟随 UI language）', () => {
  it('zh UI：摘要行为 24 小时制带年份，无 AM/PM', async () => {
    render(<ProviderDoctorDialog isOpen onClose={() => {}} />);
    fireEvent.click(screen.getByText('开始诊断'));
    await waitFor(() => {
      expect(document.body.textContent ?? '').toContain(`1.2s · ${ZH}`);
    });
    expect(document.body.textContent ?? '').not.toMatch(/AM|PM/);
  });

  it('en UI：维持 en-US 原样（英文 UI 行为不变）', async () => {
    useAppStore.setState({ language: 'en' });
    render(<ProviderDoctorDialog isOpen onClose={() => {}} />);
    fireEvent.click(screen.getByText('Start diagnostics'));
    await waitFor(() => {
      expect(document.body.textContent ?? '').toContain(`1.2s · ${EN}`);
    });
    expect(document.body.textContent ?? '').not.toContain('16:05');
  });
});
