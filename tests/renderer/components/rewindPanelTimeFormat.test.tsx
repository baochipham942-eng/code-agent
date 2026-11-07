// @vitest-environment jsdom
// ============================================================================
// RewindPanel 检查点时间口径（N-CRON-DETAIL-TIME-FORMAT-MIXED-FU1 返修）：
// 检查点行的裸 toLocaleTimeString 改走 utils/formatDateTime(ts, language)，
// zh 24 小时制带年份、绝不跟机器 locale 出 AM/PM；en 维持 en-US 原样。
// 检查点经 ipcService.invoke(CHECKPOINT_LIST) 拉取（effect 驱动，jsdom 真 render）。
// ============================================================================
import React from 'react';
import { cleanup, render, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const invoke = vi.hoisted(() => vi.fn());

vi.mock('../../../src/renderer/services/ipcService', () => ({
  default: {
    isAvailable: () => false,
    invoke: (...args: unknown[]) => invoke(...args),
    invokeDomain: vi.fn(),
    on: () => () => {},
    off: vi.fn(),
  },
}));

import { IPC_CHANNELS } from '../../../src/shared/ipc';
import { RewindPanel } from '../../../src/renderer/components/RewindPanel';
import { useAppStore } from '../../../src/renderer/stores/appStore';
import { useSessionStore } from '../../../src/renderer/stores/sessionStore';

// 本地时区构造（不跨时区换算），任何 TZ 下时分字段都是构造值本身。
const CHECKPOINT_AT = new Date(2026, 10, 9, 16, 5, 0).getTime(); // 2026-11-09 16:05
const ZH = '2026/11/09 16:05';
const EN = '11/9/2026, 4:05:00 PM';

const CHECKPOINTS = [
  { id: 'cp-1', timestamp: CHECKPOINT_AT, messageId: 'msg-1', fileCount: 2 },
];

beforeEach(() => {
  invoke.mockReset();
  invoke.mockImplementation((channel: string) => {
    if (channel === IPC_CHANNELS.CHECKPOINT_LIST) return Promise.resolve(CHECKPOINTS);
    return Promise.resolve(null);
  });
  useSessionStore.setState({ currentSessionId: 'sess-1' });
  useAppStore.setState({ language: 'zh' });
  Element.prototype.scrollIntoView = vi.fn();
});

afterEach(cleanup);

describe('RewindPanel 检查点时间（跟随 UI language）', () => {
  it('zh UI：检查点时间为 24 小时制带年份，无 AM/PM', async () => {
    render(<RewindPanel isOpen onClose={() => {}} />);
    await waitFor(() => {
      expect(invoke).toHaveBeenCalledWith(IPC_CHANNELS.CHECKPOINT_LIST, 'sess-1');
    });
    await waitFor(() => {
      expect(document.body.textContent ?? '').toContain(ZH);
    });
    expect(document.body.textContent ?? '').not.toMatch(/AM|PM/);
  });

  it('en UI：维持 en-US 原样（英文 UI 行为不变）', async () => {
    useAppStore.setState({ language: 'en' });
    render(<RewindPanel isOpen onClose={() => {}} />);
    await waitFor(() => {
      expect(document.body.textContent ?? '').toContain(EN);
    });
    expect(document.body.textContent ?? '').not.toContain('16:05');
  });
});
