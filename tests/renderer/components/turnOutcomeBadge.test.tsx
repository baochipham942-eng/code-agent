// @vitest-environment jsdom
// TurnOutcomeBadge 测试：TurnCard 消费印章降级态
// verified → 完成有据 / self_claimed → 自称完成 / 无印章（存量会话）不渲染 / 语音轮不渲染
import React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import type { TraceTurn } from '../../../src/shared/contract/trace';
import type { TurnOutcomeStamp } from '../../../src/renderer/components/TaskPanel/SessionInspector/model';

const stampState = vi.hoisted(() => ({
  stamps: [] as TurnOutcomeStamp[],
}));

vi.mock('../../../src/renderer/hooks/useI18n', async () => {
  const { zh } = await import('../../../src/renderer/i18n/zh');
  return { useI18n: () => ({ language: 'zh', t: zh }) };
});

vi.mock('../../../src/renderer/hooks/useTurnOutcomeStamps', async () => {
  const actual = await vi.importActual<typeof import('../../../src/renderer/hooks/useTurnOutcomeStamps')>(
    '../../../src/renderer/hooks/useTurnOutcomeStamps',
  );
  return {
    ...actual,
    useTurnOutcomeStamps: () => stampState.stamps,
  };
});

import { TurnOutcomeBadge } from '../../../src/renderer/components/features/chat/TurnOutcomeBadge';

function turn(overrides: Partial<TraceTurn> = {}): TraceTurn {
  return {
    turnNumber: 1,
    turnId: 't1',
    nodes: [],
    status: 'completed',
    startTime: 1000,
    endTime: 3000,
    ...overrides,
  };
}

function stamp(verdict: TurnOutcomeStamp['verdict'], ts = 2500): TurnOutcomeStamp {
  return { ts, terminal: 'completed', verdict, evidenceCount: 2, source: 'generic' };
}

beforeEach(() => {
  stampState.stamps = [];
});

describe('TurnOutcomeBadge', () => {
  it('verified → 完成有据', () => {
    stampState.stamps = [stamp('verified')];
    render(<TurnOutcomeBadge turn={turn()} sessionId="s1" />);
    const badge = screen.getByTestId('turn-outcome-badge');
    expect(badge.dataset.verdict).toBe('verified');
    expect(badge.textContent).toContain('完成有据');
  });

  it('self_claimed → 自称完成降级态（与 verified 可区分）', () => {
    stampState.stamps = [stamp('self_claimed')];
    render(<TurnOutcomeBadge turn={turn()} sessionId="s1" />);
    const badge = screen.getByTestId('turn-outcome-badge');
    expect(badge.dataset.verdict).toBe('self_claimed');
    expect(badge.textContent).toContain('自称完成');
    expect(badge.className).not.toContain('badge-success');
  });

  it('无印章（存量旧会话）不渲染，不臆造', () => {
    stampState.stamps = [];
    const { container } = render(<TurnOutcomeBadge turn={turn()} sessionId="s1" />);
    expect(container.innerHTML).toBe('');
  });

  it('印章时间戳落在轮窗口外不硬贴（对轮靠时间窗）', () => {
    stampState.stamps = [stamp('verified', 999_999)];
    const { container } = render(<TurnOutcomeBadge turn={turn()} sessionId="s1" />);
    expect(container.innerHTML).toBe('');
  });

  it('语音派活轮不渲染（语音卡有自己的结局 UI）', () => {
    stampState.stamps = [stamp('verified')];
    const { container } = render(
      <TurnOutcomeBadge turn={turn({ voiceWorkOutcome: 'done' })} sessionId="s1" />,
    );
    expect(container.innerHTML).toBe('');
  });

  it('streaming 轮不渲染', () => {
    stampState.stamps = [stamp('verified')];
    const { container } = render(
      <TurnOutcomeBadge turn={turn({ status: 'streaming', endTime: undefined })} sessionId="s1" />,
    );
    expect(container.innerHTML).toBe('');
  });

  it('n_a 印章不渲染（终态原因由既有 run 状态 UI 承担）', () => {
    stampState.stamps = [stamp('n_a')];
    const { container } = render(<TurnOutcomeBadge turn={turn()} sessionId="s1" />);
    expect(container.innerHTML).toBe('');
  });

  it('无 sessionId 不渲染', () => {
    stampState.stamps = [stamp('verified')];
    const { container } = render(<TurnOutcomeBadge turn={turn()} />);
    expect(container.innerHTML).toBe('');
  });
});
