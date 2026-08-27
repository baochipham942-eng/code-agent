// @vitest-environment jsdom
// 装卸历史 tab 组件测试（N-LEDGER-P5B 判据⑦~⑪）：
// 四类动作人话文案 / failed detail / 单能力行内名字 / 多能力折叠流式名单 /
// 空态两态 / 零打断纪律
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
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

function burst(keys: string[], action: string, startTs: number): TraceLedgerEvent[] {
  return keys.map((key, index) => lifecycle(key, action, startTs + index));
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
  it('⑦ 四类动作各出人话文案；failed 单能力批次 detail 可见；实现词不进 UI', async () => {
    traceApi.read = read([
      lifecycle('skill:alpha', 'loaded', NOW - 1000),
      lifecycle('skill:beta', 'unloaded', NOW - 6000),
      lifecycle('skill:gamma', 'rolled_back', NOW - 12000),
      lifecycle('skill:delta', 'failed', NOW - 18000, 'ENOENT: broken skill dir'),
    ]);
    render(<CapabilityLifecycleHistoryTab />);

    await waitFor(() => expect(screen.getAllByTestId('capability-history-batch')).toHaveLength(4));
    expect(screen.getByText('装上了 · 技能 · alpha')).toBeTruthy();
    expect(screen.getByText('卸下了 · 技能 · beta')).toBeTruthy();
    expect(screen.getByText('回滚了 · 技能 · gamma')).toBeTruthy();
    expect(screen.getByText('不可用 · 技能 · delta')).toBeTruthy();
    expect(screen.getByTestId('capability-history-failure-reason').textContent)
      .toBe('所需工具或运行环境不可用');
    expect(screen.getByText('ENOENT: broken skill dir')).toBeTruthy();
    // 实现词不许进 UI（「批次」是内部说法，同样不许上屏）
    expect(screen.queryByText(/lifecycle|turnTrace|rollback|账本|批次|batch/i)).toBeNull();
  });

  it('⑦b 批次行带 data-action / data-count，按 ts 倒序', async () => {
    traceApi.read = read([
      lifecycle('skill-a', 'loaded', NOW - 9000),
      lifecycle('skill-b', 'failed', NOW - 1000),
    ]);
    render(<CapabilityLifecycleHistoryTab />);

    await waitFor(() => expect(screen.getAllByTestId('capability-history-batch')).toHaveLength(2));
    const rows = screen.getAllByTestId('capability-history-batch');
    expect(rows[0].getAttribute('data-action')).toBe('failed'); // 晚的在前
    expect(rows[0].getAttribute('data-count')).toBe('1');
    expect(rows[1].getAttribute('data-action')).toBe('loaded');
  });

  it('⑧ 单能力批次行内直接出名字，且不渲染折叠开关', async () => {
    traceApi.read = read([
      lifecycle('skill:internal-comms', 'loaded', NOW - 1000),
    ]);
    render(<CapabilityLifecycleHistoryTab />);

    await waitFor(() => expect(screen.getByText('装上了 · 技能 · internal-comms')).toBeTruthy());
    expect(screen.queryByTestId('capability-history-fold-toggle')).toBeNull();
    expect(screen.queryByTestId('capability-history-batch-member')).toBeNull();
    // 原始 key 形态（带命名空间冒号）不许出现在屏上
    expect(screen.queryByText(/skill:internal-comms/)).toBeNull();
  });

  it('⑨ 多能力批次默认折叠，点开后全部名字可见且都是人话形态', async () => {
    const keys = Array.from({ length: 50 }, (_, i) => `skill:k${String(i).padStart(2, '0')}`);
    traceApi.read = read(burst(keys, 'loaded', NOW - 5000));
    const { container } = render(<CapabilityLifecycleHistoryTab />);

    await waitFor(() => expect(screen.getByText('装上了 50 个能力')).toBeTruthy());
    // 默认折叠：名字不上屏
    expect(screen.queryByTestId('capability-history-batch-member')).toBeNull();

    fireEvent.click(screen.getByTestId('capability-history-fold-toggle'));
    const members = screen.getAllByTestId('capability-history-batch-member');
    expect(members).toHaveLength(50);
    expect(members[0].getAttribute('data-capability-key')).toBe('skill:k00');
    // 整批同属一个命名空间 ⇒ 名字不再各带一遍「技能 ·」（50 遍等于噪音）
    expect(members[0].textContent).toBe('k00');
    // 整屏不许出现 skill: 原始 key 形态
    expect(container.textContent).not.toContain('skill:');
    // 再点收起
    fireEvent.click(screen.getByTestId('capability-history-fold-toggle'));
    expect(screen.queryByTestId('capability-history-batch-member')).toBeNull();
  });

  it('⑨c 混合命名空间的批次：命名空间是真区分信息，逐个名字都要带', async () => {
    traceApi.read = read([
      lifecycle('skill:alpha', 'loaded', NOW - 2000),
      lifecycle('connector:lark', 'loaded', NOW - 1999),
    ]);
    render(<CapabilityLifecycleHistoryTab />);

    await waitFor(() => expect(screen.getByText('装上了 2 个能力')).toBeTruthy());
    fireEvent.click(screen.getByTestId('capability-history-fold-toggle'));
    const members = screen.getAllByTestId('capability-history-batch-member');
    expect(members.map((m) => m.textContent)).toEqual(['连接器 · lark', '技能 · alpha']);
  });

  it('⑨b 多能力 failed 批次展开后每个名字带自己的 detail 原文', async () => {
    traceApi.read = read([
      lifecycle('skill:a', 'failed', NOW - 2000, 'ENOENT: a broken'),
      lifecycle('skill:b', 'failed', NOW - 1999, 'EACCES: b denied'),
    ]);
    render(<CapabilityLifecycleHistoryTab />);

    await waitFor(() => expect(screen.getByText('不可用 2 个能力')).toBeTruthy());
    fireEvent.click(screen.getByTestId('capability-history-fold-toggle'));
    const members = screen.getAllByTestId('capability-history-batch-member');
    expect(members).toHaveLength(2);
    expect(members[0].textContent).toContain('a');   // 同质批：名字不带命名空间前缀
    expect(members[0].textContent).toContain('ENOENT: a broken');
    expect(members[1].textContent).toContain('EACCES: b denied');
  });

  it('⑩ fetchSessionTrace 返回 null（服务不可用）→ 空态，不报错不臆造', async () => {
    traceApi.read = null;
    render(<CapabilityLifecycleHistoryTab />);

    await waitFor(() => expect(screen.getByText('还没有装卸记录')).toBeTruthy());
    expect(screen.queryByTestId('capability-history-batch')).toBeNull();
  });

  it('⑩b state=missing（账本文件不存在）→ 同样走空态', async () => {
    traceApi.read = read([], 'missing');
    render(<CapabilityLifecycleHistoryTab />);

    await waitFor(() => expect(screen.getByText('还没有装卸记录')).toBeTruthy());
    expect(screen.queryByTestId('capability-history-batch')).toBeNull();
  });

  it('⑩c 账本有内容但一行都读不懂 → 空态说实话，不与「还没有记录」同形', async () => {
    traceApi.read = read([
      { ts: 1, type: 'capability_lifecycle', data: null },
      { ts: 2, type: 'capability_lifecycle', data: { capabilityKey: 'skill-a', action: 'exploded' } },
    ]);
    render(<CapabilityLifecycleHistoryTab />);

    await waitFor(() => expect(screen.getByText('有 2 条记录读不出来，先当没有记录处理。')).toBeTruthy());
    expect(screen.queryByText('等你关掉再打开某个技能、或有能力装载失败时，这里会自己出现记录。')).toBeNull();
  });

  it('脏数据混入不炸：安静丢弃，有效事件正常聚批渲染', async () => {
    traceApi.read = read([
      { ts: 1, type: 'turn_outcome', data: { capabilityKey: 'ghost', action: 'loaded' } },
      { ts: 2, type: 'capability_lifecycle', data: null },
      { ts: 3, type: 'capability_lifecycle', data: { capabilityKey: 'skill-a', action: 'exploded' } },
      lifecycle('skill:a', 'loaded', NOW - 1000),
    ]);
    render(<CapabilityLifecycleHistoryTab />);

    await waitFor(() => expect(screen.getAllByTestId('capability-history-batch')).toHaveLength(1));
    expect(screen.queryByText(/ghost/)).toBeNull();
    expect(screen.getByText('装上了 · 技能 · a')).toBeTruthy();
  });

  it('⑪ 零打断纪律：只在挂载拉一次，点刷新再拉一次（无轮询无订阅）', async () => {
    traceApi.read = read([lifecycle('skill-a', 'loaded', NOW - 1000)]);
    render(<CapabilityLifecycleHistoryTab />);

    await waitFor(() => expect(screen.getAllByTestId('capability-history-batch')).toHaveLength(1));
    expect(fetchSessionTrace).toHaveBeenCalledTimes(1);
    expect(fetchSessionTrace).toHaveBeenCalledWith('capability-runtime');

    fireEvent.click(screen.getByLabelText('刷新'));
    await waitFor(() => expect(fetchSessionTrace).toHaveBeenCalledTimes(2));
  });
});
