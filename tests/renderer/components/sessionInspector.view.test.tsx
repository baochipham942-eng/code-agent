// @vitest-environment jsdom
// SessionInspector 视图测试：层1 印章三态 / 层2 manifest 三态 / 坏行如实显示 / tail 增量不重复
import React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { TraceLedgerEvent, TraceSessionRead } from '../../../src/renderer/services/traceLedgerClient';

const traceApi = vi.hoisted(() => ({
  read: null as TraceSessionRead | null,
  tails: [] as TraceSessionRead[],
  tailCalls: 0,
}));

vi.mock('../../../src/renderer/hooks/useI18n', async () => {
  const { zh } = await import('../../../src/renderer/i18n/zh');
  return { useI18n: () => ({ language: 'zh', t: zh }) };
});

vi.mock('../../../src/renderer/stores/sessionStore', () => ({
  useSessionStore: (selector?: (state: { currentSessionId: string }) => unknown) => (
    selector ? selector({ currentSessionId: 'session_test' }) : { currentSessionId: 'session_test' }
  ),
}));

vi.mock('../../../src/renderer/services/traceLedgerClient', () => ({
  fetchSessionTrace: vi.fn(async () => traceApi.read),
  tailSessionTrace: vi.fn(async () => {
    const tail = traceApi.tails[Math.min(traceApi.tailCalls, traceApi.tails.length - 1)];
    traceApi.tailCalls += 1;
    return tail ?? null;
  }),
}));

import { SessionInspector } from '../../../src/renderer/components/TaskPanel/SessionInspector';

function event(type: string, data: unknown, turnIndex = 1, ts = 1000): TraceLedgerEvent {
  return { ts, sessionId: 'session_test', turnIndex, type, data };
}

function outcome(verdict: string, terminal = 'completed', ts: number): TraceLedgerEvent {
  return event('turn_outcome', { terminal, verdict, evidenceRefs: [], source: 'generic' }, 1, ts);
}

function manifest(requestId: string, degraded = false): TraceLedgerEvent {
  return event('request_manifest', {
    requestId,
    messageRefs: [
      { kind: 'system_prompt', contentHash: 'a'.repeat(64) },
      { kind: 'ledger_message', messageId: 'm1' },
    ],
    toolSchemaHash: 'd'.repeat(64),
    toolNames: ['Read', 'Edit', 'Bash'],
    requested: { provider: 'p', model: 'model-x', temperature: 0.7, maxTokens: null, reasoningEffort: null, thinkingBudget: null },
    actualProvider: 'p',
    actualModel: 'model-x',
    appVersion: '0.32.0',
    adapterDefaults: { engine: 'aisdk', temperature: null, maxTokens: null },
    compactionReplacements: [],
    degraded,
  }, 1, 1500);
}

function readWith(events: TraceLedgerEvent[], skippedLines = 0): TraceSessionRead {
  return { sessionId: 'session_test', state: 'present', events, skippedLines, cursor: 1000 };
}

beforeEach(() => {
  traceApi.read = null;
  traceApi.tails = [];
  traceApi.tailCalls = 0;
});

describe('层1 人话时间线', () => {
  it('印章三态轮头：verified / self_claimed / n_a(失败终态)', async () => {
    traceApi.read = readWith([
      event('inference', { inputTokens: 1200, outputTokens: 300 }, 1, 1000),
      outcome('verified', 'completed', 2000),
      outcome('self_claimed', 'completed', 4000),
      outcome('n_a', 'failed', 6000),
    ]);
    render(<SessionInspector />);
    const stamps = await screen.findAllByTestId('inspector-stamp');
    expect(stamps.map((stamp) => stamp.dataset.verdict)).toEqual(['verified', 'self_claimed', 'n_a']);
    expect(stamps[0].textContent).toContain('完成有据');
    expect(stamps[1].textContent).toContain('自称完成');
    expect(stamps[2].textContent).toContain('失败了');
    // 轮行按序三条
    expect(screen.getAllByTestId('inspector-turn')).toHaveLength(3);
  });

  it('无账本（missing）与空账本（empty）走各自空态', async () => {
    traceApi.read = { sessionId: 'session_test', state: 'missing', events: [], skippedLines: 0, cursor: 0 };
    const { unmount } = render(<SessionInspector />);
    expect(await screen.findByTestId('inspector-state-missing')).not.toBeNull();
    unmount();
    traceApi.read = { sessionId: 'session_test', state: 'empty', events: [], skippedLines: 0, cursor: 0 };
    render(<SessionInspector />);
    expect(await screen.findByTestId('inspector-state-empty')).not.toBeNull();
  });

  it('坏行 skippedLines 如实显示', async () => {
    traceApi.read = readWith([outcome('verified', 'completed', 2000)], 3);
    render(<SessionInspector />);
    const banner = await screen.findByTestId('inspector-skipped-lines');
    expect(banner.textContent).toContain('3');
  });
});

describe('层2 DevTools', () => {
  it('存量会话无 manifest → 「不可回放」降级态', async () => {
    traceApi.read = readWith([
      event('inference', { inputTokens: 10, outputTokens: 5 }, 1, 1000),
      outcome('verified', 'completed', 2000),
    ]);
    render(<SessionInspector />);
    fireEvent.click(await screen.findByTestId('inspector-turn-toggle'));
    expect(await screen.findByTestId('inspector-replay-unavailable')).not.toBeNull();
  });

  it('有 manifest → 还原视图（工具面/消息清单/引擎）', async () => {
    traceApi.read = readWith([
      manifest('req-1'),
      event('tool_dispatch', { toolName: 'Read', success: true, durationMs: 12, error: null, fromCache: false }, 1, 1600),
      event('inference', { inputTokens: 100, outputTokens: 50, finishReason: 'stop', durationMs: 800 }, 1, 1700),
      outcome('verified', 'completed', 2000),
    ]);
    render(<SessionInspector />);
    fireEvent.click(await screen.findByTestId('inspector-turn-toggle'));
    const view = await screen.findByTestId('inspector-manifest');
    expect(view.textContent).toContain('model-x');
    expect(view.textContent).toContain('aisdk');
    expect(within(view).getByTestId('inspector-manifest-refs')).not.toBeNull();
    // 逐 step 工具行 + 结束原因
    expect(screen.getByTestId('inspector-steps').textContent).toContain('Read');
    expect(screen.getByTestId('inspector-inferences').textContent).toContain('stop');
  });

  it('degraded manifest 如实标注降级', async () => {
    traceApi.read = readWith([manifest('req-d', true), outcome('verified', 'completed', 2000)]);
    render(<SessionInspector />);
    fireEvent.click(await screen.findByTestId('inspector-turn-toggle'));
    const view = await screen.findByTestId('inspector-manifest');
    expect(view.dataset.degraded).toBe('true');
  });
});

describe('活会话 tail 跟随', () => {
  it('增量事件追加新轮，已有轮不重复渲染', async () => {
    traceApi.read = readWith([outcome('verified', 'completed', 2000)]);
    traceApi.tails = [
      {
        sessionId: 'session_test',
        state: 'present',
        events: [outcome('self_claimed', 'completed', 4000)],
        skippedLines: 0,
        cursor: 2000,
      },
    ];
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      render(<SessionInspector />);
      await screen.findAllByTestId('inspector-turn');
      expect(screen.getAllByTestId('inspector-turn')).toHaveLength(1);
      // 触发一次 tail 轮询（组件内部 interval 2500ms）
      await vi.advanceTimersByTimeAsync(2600);
      await waitFor(() => {
        expect(screen.getAllByTestId('inspector-turn')).toHaveLength(2);
      });
      const stamps = screen.getAllByTestId('inspector-stamp');
      expect(stamps.map((stamp) => stamp.dataset.verdict)).toEqual(['verified', 'self_claimed']);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('A · 层1 工具汇总句（可展开逐条明细）', () => {
  const tool = (toolName: string, ts: number) =>
    event('tool_dispatch', { toolName, success: true, durationMs: 12, error: null, fromCache: false }, 1, ts);

  it('≥2 次工具调用：汇总句 + 明细入口，展开后逐条与账本对上', async () => {
    traceApi.read = readWith([
      tool('Read', 1100), tool('Grep', 1200), tool('Read', 1300),
      tool('Bash', 1400), tool('Bash', 1500),
      outcome('verified', 'completed', 2000),
    ]);
    render(<SessionInspector />);
    const summary = await screen.findByTestId('inspector-turn-activity');
    expect(summary.textContent).toContain('查阅 3 次');
    expect(summary.textContent).toContain('运行命令 2 次');
    // 明细默认收起，点开逐条与账本一致
    expect(screen.queryByTestId('inspector-activity-detail')).toBeNull();
    fireEvent.click(screen.getByTestId('inspector-activity-detail-toggle'));
    const rows = await screen.findAllByTestId('inspector-activity-detail-row');
    expect(rows).toHaveLength(5);
    expect(rows.map((row) => row.textContent)).toEqual([
      expect.stringContaining('Read'),
      expect.stringContaining('Grep'),
      expect.stringContaining('Read'),
      expect.stringContaining('Bash'),
      expect.stringContaining('Bash'),
    ]);
  });

  it('单工具轮不聚合、无明细入口（保持原样）', async () => {
    traceApi.read = readWith([
      event('tool_dispatch', { toolName: 'Read', success: true, durationMs: 5, error: null, fromCache: false }, 1, 1100),
      outcome('verified', 'completed', 2000),
    ]);
    render(<SessionInspector />);
    const summary = await screen.findByTestId('inspector-turn-activity');
    expect(summary.textContent).toContain('查阅 1 次');
    expect(screen.queryByTestId('inspector-activity-detail-toggle')).toBeNull();
  });
});

describe('B · 层1 撤 token 数字，只报异常', () => {
  const turnWithTokens = (total: number, ts: number): TraceLedgerEvent[] => [
    event('inference', { inputTokens: total, outputTokens: 0 }, 1, ts),
    outcome('verified', 'completed', ts + 500),
  ];

  it('正常会话层1 全程零 token 数字', async () => {
    traceApi.read = readWith([
      event('inference', { inputTokens: 6400, outputTokens: 100, cacheReadTokens: 17000 }, 1, 1000),
      outcome('verified', 'completed', 2000),
    ]);
    render(<SessionInspector />);
    await screen.findByTestId('inspector-turn-activity');
    expect(screen.queryByTestId('inspector-turn-tokens')).toBeNull();
    expect(screen.queryByTestId('inspector-token-anomaly')).toBeNull();
    expect(screen.getByTestId('inspector-timeline').textContent).not.toContain('消耗');
    expect(screen.getByTestId('inspector-timeline').textContent).not.toContain('缓存');
  });

  it('高耗轮夹具（>均值×3 且 >20k）→ 黄条出现', async () => {
    traceApi.read = readWith([
      ...turnWithTokens(4_000, 1000),
      ...turnWithTokens(4_000, 3000),
      ...turnWithTokens(4_000, 5000),
      ...turnWithTokens(100_000, 7000),
    ]);
    render(<SessionInspector />);
    const anomalies = await screen.findAllByTestId('inspector-token-anomaly');
    expect(anomalies).toHaveLength(1);
    expect(anomalies[0].textContent).toContain('消耗明显偏高');
    // 层2 数字保留：点开异常轮仍能看到 in/out 数字
    const toggles = screen.getAllByTestId('inspector-turn-toggle');
    fireEvent.click(toggles[3]);
    const calls = await screen.findAllByTestId('inspector-inference-call');
    expect(calls[0].textContent).toContain('100k');
  });
});

describe('D · 层2 per-call 推理调用分卡', () => {
  const manifest = (requestId: string, model: string, ts: number) =>
    event('request_manifest', {
      requestId,
      messageRefs: [],
      toolSchemaHash: 'd'.repeat(64),
      toolNames: ['Read'],
      requested: { provider: 'p', model, temperature: null, maxTokens: null, reasoningEffort: null, thinkingBudget: null },
      actualProvider: 'p',
      actualModel: model,
      appVersion: '0.32.0',
      adapterDefaults: { engine: 'aisdk', temperature: null, maxTokens: null },
      compactionReplacements: [],
      degraded: false,
    }, 1, ts);

  it('多调用轮逐卡：模型/耗时/结束原因/in-out-cache 上卡，工具挂卡下', async () => {
    traceApi.read = readWith([
      manifest('r1', 'model-a', 1000),
      event('inference', { inputTokens: 19216, outputTokens: 45, cacheReadTokens: 17000, durationMs: 15200, finishReason: 'tool_calls' }, 1, 1100),
      event('tool_dispatch', { toolName: 'Read', success: true, durationMs: 51, error: null, fromCache: false }, 1, 1200),
      manifest('r2', 'model-a', 1300),
      event('inference', { inputTokens: 19265, outputTokens: 17, durationMs: 3800, finishReason: 'stop' }, 1, 1400),
      outcome('verified', 'completed', 2000),
    ]);
    render(<SessionInspector />);
    fireEvent.click(await screen.findByTestId('inspector-turn-toggle'));
    const cards = await screen.findAllByTestId('inspector-inference-call');
    expect(cards).toHaveLength(2);
    expect(cards[0].textContent).toContain('#1');
    expect(cards[0].textContent).toContain('model-a');
    expect(cards[0].textContent).toContain('tool_calls');
    expect(cards[0].textContent).toContain('19k');
    expect(cards[0].textContent).toContain('17k');
    // 工具挂在所属 call 卡下
    expect(within(cards[0]).getByTestId('inspector-call-tools').textContent).toContain('Read');
    expect(cards[1].textContent).toContain('#2');
    expect(cards[1].textContent).toContain('stop');
    expect(within(cards[1]).queryByTestId('inspector-call-tools')).toBeNull();
    // 有分卡且无 orphan/决策时平铺 steps 清单不渲染（工具只出现在卡下）
    expect(screen.queryByTestId('inspector-steps')).toBeNull();
  });

  it('存量会话缺 inference 细分 → 降级轮级汇总并如实标注', async () => {
    traceApi.read = readWith([
      event('tool_dispatch', { toolName: 'Read', success: true, durationMs: 5, error: null, fromCache: false }, 1, 1000),
      outcome('verified', 'completed', 2000),
    ]);
    render(<SessionInspector />);
    fireEvent.click(await screen.findByTestId('inspector-turn-toggle'));
    expect(await screen.findByTestId('inspector-steps')).not.toBeNull();
    expect(screen.getByTestId('inspector-steps').textContent).toContain('Read');
    expect(screen.queryByTestId('inspector-inference-call')).toBeNull();
    expect(screen.getByTestId('inspector-calls-degraded').textContent).toContain('轮级汇总');
  });
});
