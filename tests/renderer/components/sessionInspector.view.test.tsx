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
