// @vitest-environment jsdom
// ============================================================================
// DoctorSettings 诊断摘要行时间口径（N-CRON-DETAIL-TIME-FORMAT-MIXED-FU1 返修）：
// 摘要里的裸 toLocaleTimeString 改走 utils/formatDateTime(ts, language)，
// zh 24 小时制带年份、绝不跟机器 locale 出 AM/PM；en 维持 en-US 原样。
// 报告经 useDoctorStore 注入（同 doctorSettings.test.tsx 的注入口）。
// ============================================================================
import React from 'react';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { DoctorSettings } from '../../../src/renderer/components/features/settings/tabs/DoctorSettings';
import { useAppStore } from '../../../src/renderer/stores/appStore';
import { useDoctorStore } from '../../../src/renderer/stores/doctorStore';
import { useBundledCapabilityStore } from '../../../src/renderer/stores/bundledCapabilityStore';
import type { DoctorReport } from '../../../src/renderer/types/doctor';

// 本地时区构造（不跨时区换算），任何 TZ 下时分字段都是构造值本身。
const REPORT_AT = new Date(2026, 10, 9, 16, 5, 0).getTime(); // 2026-11-09 16:05
const ZH = '2026/11/09 16:05';
const EN = '11/9/2026, 4:05:00 PM';

const REPORT: DoctorReport = {
  timestamp: REPORT_AT,
  durationMs: 1234,
  items: [
    { category: 'environment', name: 'Node.js version', status: 'pass', message: 'Node.js v22' },
  ],
  summary: { pass: 1, warn: 0, fail: 0, skip: 0 },
};

beforeEach(() => {
  useAppStore.setState({ language: 'zh' });
  useDoctorStore.setState({
    report: REPORT,
    isRunning: false,
    runningCategory: null,
    lastError: null,
    startupCheckDone: true,
  });
  useBundledCapabilityStore.setState({
    installed: { 'builtin.voice-live': false, 'builtin.voice-input': false },
  });
});

afterEach(() => {
  cleanup();
  useDoctorStore.setState({
    report: null,
    isRunning: false,
    runningCategory: null,
    lastError: null,
    startupCheckDone: false,
  });
  useBundledCapabilityStore.setState({
    installed: { 'builtin.voice-live': false, 'builtin.voice-input': false },
  });
});

describe('DoctorSettings 诊断摘要时间（跟随 UI language）', () => {
  it('zh UI：摘要行为 24 小时制带年份，无 AM/PM', () => {
    const { container } = render(<DoctorSettings />);
    expect(container.textContent).toContain(`1.2s · ${ZH}`);
    expect(container.textContent).not.toMatch(/AM|PM/);
  });

  it('en UI：维持 en-US 原样（英文 UI 行为不变）', () => {
    useAppStore.setState({ language: 'en' });
    const { container } = render(<DoctorSettings />);
    expect(container.textContent).toContain(`1.2s · ${EN}`);
    expect(screen.getByText('PASS')).toBeTruthy();
    expect(container.textContent).not.toContain('16:05');
  });
});
