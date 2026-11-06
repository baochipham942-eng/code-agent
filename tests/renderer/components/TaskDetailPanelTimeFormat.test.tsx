// ============================================================================
// TaskDetailPanel 时间口径（N-CRON-DETAIL-TIME-FORMAT-MIXED-FU1）：
// 任务详情 Started/Completed 改走 utils/formatDateTime(value, language)，
// zh 24 小时制带年份、绝不跟机器 locale 出 AM/PM；en 维持 en-US 原样。
// 面板本身无 i18n 文案树，语言经 useAppStore 选择器读取（mock 定桩）。
// ============================================================================
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

const appState = vi.hoisted(() => ({ language: 'zh' as 'zh' | 'en' }));

vi.mock('../../../src/renderer/stores/appStore', () => ({
  useAppStore: (selector: (state: { language: 'zh' | 'en' }) => unknown) => selector(appState),
}));

import { TaskDetailPanel } from '../../../src/renderer/components/features/workflow/TaskDetailPanel';

// 本地时区构造（不跨时区换算），任何 TZ 下时分字段都是构造值本身。
const STARTED = new Date(2026, 10, 9, 16, 5, 0).getTime(); // 2026-11-09 16:05
const COMPLETED = new Date(2026, 10, 9, 17, 30, 0).getTime(); // 2026-11-09 17:30

const TASK = {
  taskId: 'task-1',
  name: 'Build page',
  type: 'agent' as const,
  status: 'completed' as const,
  priority: 'normal' as const,
  retryCount: 0,
  startedAt: STARTED,
  completedAt: COMPLETED,
};

describe('TaskDetailPanel 时间口径（跟随 UI language）', () => {
  it('zh UI：Started/Completed 24 小时制带年份，无 AM/PM', () => {
    appState.language = 'zh';
    const html = renderToStaticMarkup(<TaskDetailPanel task={TASK} onClose={() => {}} />);
    expect(html).toContain('2026/11/09 16:05');
    expect(html).toContain('2026/11/09 17:30');
    expect(html).not.toMatch(/AM|PM/);
  });

  it('en UI：维持 en-US 原样（英文 UI 行为不变）', () => {
    appState.language = 'en';
    const html = renderToStaticMarkup(<TaskDetailPanel task={TASK} onClose={() => {}} />);
    expect(html).toContain('11/9/2026, 4:05:00 PM');
    expect(html).toContain('11/9/2026, 5:30:00 PM');
  });
});
