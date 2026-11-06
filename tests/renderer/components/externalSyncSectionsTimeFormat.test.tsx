// @vitest-environment jsdom
// ============================================================================
// 设置页「保持聊天/技能同步」状态行时间口径（N-CRON-DETAIL-TIME-FORMAT-MIXED-FU1 返修）：
// statusOnLast 模板里的 {time} 改走 utils/formatDateTime(at, language)，
// zh 24 小时制带年份、绝不跟机器 locale 出 AM/PM；en 维持 en-US 原样。
// ============================================================================
import React from 'react';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
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

import { ExternalChatsImportSection } from '../../../src/renderer/components/features/settings/tabs/ExternalChatsImportSection';
import { ExternalSkillsSyncSection } from '../../../src/renderer/components/features/settings/tabs/ExternalSkillsSyncSection';
import { useAppStore } from '../../../src/renderer/stores/appStore';

// 本地时区构造（不跨时区换算），任何 TZ 下时分字段都是构造值本身。
const LAST_RUN_AT = new Date(2026, 10, 9, 16, 5, 0).getTime(); // 2026-11-09 16:05
const ZH = '2026/11/09 16:05';
const EN = '11/9/2026, 4:05:00 PM';

beforeEach(() => {
  invokeDomain.mockReset();
  useAppStore.setState({ language: 'zh' });
});

afterEach(cleanup);

describe('ExternalSkillsSyncSection 状态行（跟随 UI language）', () => {
  it('zh UI：statusOnLast 的 {time} 为 24 小时制带年份，无 AM/PM', async () => {
    invokeDomain.mockResolvedValue({ mode: 'on', lastRun: { at: LAST_RUN_AT, imported: 2, keptNeo: 0 } });
    render(<ExternalSkillsSyncSection />);
    await waitFor(() => {
      expect(screen.getByTestId('external-skills-sync-status').textContent).toContain(ZH);
    });
    expect(screen.getByTestId('external-skills-sync-status').textContent).not.toMatch(/AM|PM/);
  });

  it('en UI：维持 en-US 原样（英文 UI 行为不变）', async () => {
    useAppStore.setState({ language: 'en' });
    invokeDomain.mockResolvedValue({ mode: 'on', lastRun: { at: LAST_RUN_AT, imported: 2, keptNeo: 0 } });
    render(<ExternalSkillsSyncSection />);
    await waitFor(() => {
      expect(screen.getByTestId('external-skills-sync-status').textContent).toContain(EN);
    });
    expect(screen.getByTestId('external-skills-sync-status').textContent).not.toContain('16:05');
  });
});

describe('ExternalChatsImportSection 保持聊天同步状态行（跟随 UI language）', () => {
  it('zh UI：statusOnLast 的 {time} 为 24 小时制带年份，无 AM/PM', async () => {
    invokeDomain.mockResolvedValue({ mode: 'on', lastRun: { at: LAST_RUN_AT, imported: 3 } });
    render(<ExternalChatsImportSection />);
    await waitFor(() => {
      expect(screen.getByTestId('external-chats-sync-status').textContent).toContain(ZH);
    });
    expect(screen.getByTestId('external-chats-sync-status').textContent).not.toMatch(/AM|PM/);
  });

  it('en UI：维持 en-US 原样（英文 UI 行为不变）', async () => {
    useAppStore.setState({ language: 'en' });
    invokeDomain.mockResolvedValue({ mode: 'on', lastRun: { at: LAST_RUN_AT, imported: 3 } });
    render(<ExternalChatsImportSection />);
    await waitFor(() => {
      expect(screen.getByTestId('external-chats-sync-status').textContent).toContain(EN);
    });
    expect(screen.getByTestId('external-chats-sync-status').textContent).not.toContain('16:05');
  });
});
