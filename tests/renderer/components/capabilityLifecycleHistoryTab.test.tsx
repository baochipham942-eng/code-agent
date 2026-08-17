// @vitest-environment jsdom
// 装卸历史 tab 组件测试（N-LEDGER-P5 判据②③④⑤）：
// 四类动作人话文案 / failed 带 detail / 脏数据不炸 / null 与 missing 走空态 / 组内折叠展开
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { TraceLedgerEvent, TraceSessionRead } from '../../../src/renderer/services/traceLedgerClient';

const traceApi = vi.hoisted(() => ({
  read: null as TraceSessionRead | null,
}));

vi.mock('../../../src/renderer/hooks/useI18n', async () => {
  const { zh } = await import('../../../src/renderer/i18n/zh');
  return { useI18n: () => ({ language: 'zh', t: zh }) };
});

vi.mock('../../../src/renderer/services/traceLedgerClient', () => ({
  fetchSessionTrace: vi.fn(async () => traceApi.read),
}));

import { CapabilityLifecycleHistoryTab } from '../../../src/renderer/components/features/capabilityHub/CapabilityLifecycleHistoryTab';
import { fetchSessionTrace } from '../../../src/renderer/services/traceLedgerClient';

function read(events: TraceLedgerEvent[], state: TraceSessionRead['state'] = 'present'): TraceSessionRead {
  return { sessionId: 'capability-runtime', state, events, skippedLines: 0, cursor: 0 };
}

function lifecycle(capabilityKey: string, action: string, ts: number, detail?: string): TraceLedgerEvent {
  return {
    ts,
    sessionId: 'capability-runtime',
    turnIndex: 0,
    type: 'capability_lifecycle',
    data: detail === undefined ? { capabilityKey, action } : { capabilityKey, action, detail },
  };
}

const NOW = Date.now();

beforeEach(() => {
  traceApi.read = null;
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('CapabilityLifecycleHistoryTab', () => {
  it('② 四类动作各出人话文案；failed 带 detail 时 detail 可见', async () => {
    traceApi.read = read([
      lifecycle('skill-alpha', 'loaded', NOW - 1000),
      lifecycle('skill-alpha', 'unloaded', NOW - 2000),
      lifecycle('skill-beta', 'rolled_back', NOW - 3000),
      lifecycle('skill-gamma', 'failed', NOW - 4000, 'ENOENT: broken skill dir'),
    ]);
    render(<CapabilityLifecycleHistoryTab />);

    await waitFor(() => expect(screen.getAllByTestId('capability-history-event')).toHaveLength(4));
    expect(screen.getByText('装上了')).toBeTruthy();
    expect(screen.getByText('卸下了')).toBeTruthy();
    expect(screen.getByText('回滚了')).toBeTruthy();
    expect(screen.getByText('失败了')).toBeTruthy();
    expect(screen.getByText('ENOENT: broken skill dir')).toBeTruthy();
    // 实现词不许进 UI
    expect(screen.queryByText(/lifecycle|turnTrace|rollback|账本/i)).toBeNull();
  });

  it('②b 每行带 data-capability-key / data-action，按组分容器', async () => {
    traceApi.read = read([
      lifecycle('skill-alpha', 'loaded', NOW - 1000),
      lifecycle('skill-beta', 'failed', NOW - 2000),
    ]);
    render(<CapabilityLifecycleHistoryTab />);

    await waitFor(() => expect(screen.getAllByTestId('capability-history-group')).toHaveLength(2));
    const groups = screen.getAllByTestId('capability-history-group');
    // 组间按最新 ts 倒序：skill-alpha 在前
    expect(groups[0].getAttribute('data-capability-key')).toBe('skill-alpha');
    expect(groups[1].getAttribute('data-capability-key')).toBe('skill-beta');
    const event = within(groups[1]).getByTestId('capability-history-event');
    expect(event.getAttribute('data-action')).toBe('failed');
  });

  it('③ 脏数据混入不炸：安静丢弃，有效事件正常渲染', async () => {
    traceApi.read = read([
      { ts: 1, type: 'turn_outcome', data: { capabilityKey: 'ghost', action: 'loaded' } },
      { ts: 2, type: 'capability_lifecycle', data: null },
      { ts: 3, type: 'capability_lifecycle', data: { capabilityKey: 'skill-a', action: 'exploded' } },
      lifecycle('skill-a', 'loaded', NOW - 1000),
    ]);
    render(<CapabilityLifecycleHistoryTab />);

    await waitFor(() => expect(screen.getAllByTestId('capability-history-event')).toHaveLength(1));
    expect(screen.queryByText('ghost')).toBeNull();
    expect(screen.getByText('skill-a')).toBeTruthy();
  });

  it('④ fetchSessionTrace 返回 null（服务不可用）→ 空态，不报错不臆造', async () => {
    traceApi.read = null;
    render(<CapabilityLifecycleHistoryTab />);

    await waitFor(() => expect(screen.getByText('还没有装卸记录')).toBeTruthy());
    expect(screen.queryByTestId('capability-history-event')).toBeNull();
  });

  it('④b state=missing（账本文件不存在）→ 同样走空态', async () => {
    traceApi.read = read([], 'missing');
    render(<CapabilityLifecycleHistoryTab />);

    await waitFor(() => expect(screen.getByText('还没有装卸记录')).toBeTruthy());
    expect(screen.queryByTestId('capability-history-event')).toBeNull();
  });

  it('⑤ 组内 >3 条默认折叠，点展开后全部可见', async () => {
    traceApi.read = read([
      lifecycle('skill-a', 'loaded', NOW - 5000),
      lifecycle('skill-a', 'unloaded', NOW - 4000),
      lifecycle('skill-a', 'loaded', NOW - 3000),
      lifecycle('skill-a', 'unloaded', NOW - 2000),
      lifecycle('skill-a', 'loaded', NOW - 1000),
    ]);
    render(<CapabilityLifecycleHistoryTab />);

    await waitFor(() => expect(screen.getAllByTestId('capability-history-event')).toHaveLength(3));
    const toggle = screen.getByTestId('capability-history-fold-toggle');
    expect(toggle.textContent).toContain('展开剩余 2 条');

    fireEvent.click(toggle);
    expect(screen.getAllByTestId('capability-history-event')).toHaveLength(5);
    expect(screen.getByTestId('capability-history-fold-toggle').textContent).toContain('收起');
  });

  it('零打断纪律：只在挂载拉一次，点刷新再拉一次（无轮询无订阅）', async () => {
    traceApi.read = read([lifecycle('skill-a', 'loaded', NOW - 1000)]);
    render(<CapabilityLifecycleHistoryTab />);

    await waitFor(() => expect(screen.getAllByTestId('capability-history-event')).toHaveLength(1));
    expect(fetchSessionTrace).toHaveBeenCalledTimes(1);
    expect(fetchSessionTrace).toHaveBeenCalledWith('capability-runtime');

    fireEvent.click(screen.getByLabelText('刷新'));
    await waitFor(() => expect(fetchSessionTrace).toHaveBeenCalledTimes(2));
  });
});
