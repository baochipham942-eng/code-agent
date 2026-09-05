// @vitest-environment jsdom
// 上线后质量卡：卡片自己不算比率，只渲染报告里的数；两行不合并、校准不足要挂角标、
// 预算停评与评分失败都要有人话提示（不是把 IPC 报错原样甩给用户）。
import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';

vi.mock('@internal-evaluation/renderer/i18n/useEvaluationI18n', async () => {
  const { evalCenterZh } = await import('@internal-evaluation/renderer/i18n/evaluationCenter');
  return { useEvaluationI18n: () => ({ t: evalCenterZh }) };
});

import { PostLaunchCard } from '@internal-evaluation/renderer/telemetry/PostLaunchCard';
import type { PostLaunchReport } from '../../../src/shared/contract/postLaunchScore';

afterEach(cleanup);

function report(overrides: Partial<PostLaunchReport> = {}): PostLaunchReport {
  return {
    generatedAt: 0,
    days: 7,
    judgeVersion: 'postlaunch-judge-v1',
    rubricVersion: 'postlaunch-rubric-v1',
    scoredTurns: 3,
    groups: [{
      weekStart: '2026-08-31',
      appVersion: '0.33.0',
      promptVersion: 'p7',
      rows: [
        {
          scope: 'signal',
          turns: 2,
          dims: {
            goal: { judged: 2, passed: 1 },
            orchestration: { judged: 2, passed: 2 },
            tools: { judged: 2, passed: 2 },
            permission: { judged: 0, passed: 0 },
            safety: { judged: 2, passed: 2 },
            artifact: { judged: 2, passed: 1 },
          },
        },
        {
          scope: 'sample',
          turns: 1,
          dims: {
            goal: { judged: 1, passed: 1 },
            orchestration: { judged: 1, passed: 1 },
            tools: { judged: 1, passed: 1 },
            permission: { judged: 1, passed: 1 },
            safety: { judged: 1, passed: 1 },
            artifact: { judged: 1, passed: 1 },
          },
        },
      ],
      failureClasses: [{ code: 'timeout', count: 1 }],
      signals: [{ kind: 'timeout', count: 1 }],
      costUsd: 0.0123,
      sessionIds: ['session-abcdef123'],
    }],
    judgeUnavailableTurns: 0,
    calibration: { state: 'insufficient', reason: 'no_record' },
    budget: { day: '2026-09-05', spentUsd: 0.12, limitUsd: 0.5, sampledCount: 3, sampleLimit: 20, assumedUsd: 0, stopped: false },
    ...overrides,
  };
}

const noop = (): void => {};

describe('上线后质量卡', () => {
  it('信号轮与抽样轮各一行，比率直接取报告的分子分母', () => {
    render(<PostLaunchCard report={report()} running={false} error={null} days={7} onRun={noop} onOpenSession={noop} />);
    expect(screen.getByTestId('postlaunch-row-signal')).toBeTruthy();
    expect(screen.getByTestId('postlaunch-row-sample')).toBeTruthy();
    expect(screen.getByTestId('postlaunch-signal-goal').textContent).toBe('50%');
    expect(screen.getByTestId('postlaunch-sample-goal').textContent).toBe('100%');
  });

  it('没判决的维度显示占位，不显示 0%——0% 和「没评过」不是一回事', () => {
    render(<PostLaunchCard report={report()} running={false} error={null} days={7} onRun={noop} onOpenSession={noop} />);
    expect(screen.getByTestId('postlaunch-signal-permission').textContent).toBe('—');
  });

  it('κ 缺失时挂「校准不足」角标', () => {
    render(<PostLaunchCard report={report()} running={false} error={null} days={7} onRun={noop} onOpenSession={noop} />);
    expect(screen.getByTestId('postlaunch-calibration').textContent).toContain('校准不足');
  });

  it('已校准时不挂角标', () => {
    render(
      <PostLaunchCard
        report={report({ calibration: { state: 'calibrated' } })}
        running={false} error={null} days={7} onRun={noop} onOpenSession={noop}
      />,
    );
    expect(screen.queryByTestId('postlaunch-calibration')).toBeNull();
  });

  it('预算停评是人话提示，不是错误码', () => {
    const stopped = report();
    stopped.budget = { ...stopped.budget, stopped: true };
    render(<PostLaunchCard report={stopped} running={false} error={null} days={7} onRun={noop} onOpenSession={noop} />);
    expect(screen.getByTestId('postlaunch-budget-stopped').textContent).toContain('只记信号');
  });

  it('评分失败给一句人话 + 原因，不是空白', () => {
    render(
      <PostLaunchCard report={report()} running={false} error="Quick model not configured" days={7} onRun={noop} onOpenSession={noop} />,
    );
    expect(screen.getByTestId('postlaunch-error').textContent).toContain('评分没跑成');
    expect(screen.getByTestId('postlaunch-error').textContent).toContain('Quick model not configured');
  });

  it('没有分数时给出下一步动作，并说明会花谁的额度', () => {
    render(<PostLaunchCard report={null} running={false} error={null} days={7} onRun={noop} onOpenSession={noop} />);
    expect(screen.getByTestId('postlaunch-empty').textContent).toContain('你自己的模型额度');
  });

  it('报告形状不对时退回空态，不把整个遥测页崩掉', () => {
    const malformed = [] as unknown as PostLaunchReport;
    render(<PostLaunchCard report={malformed} running={false} error={null} days={7} onRun={noop} onOpenSession={noop} />);
    expect(screen.getByTestId('postlaunch-empty')).toBeTruthy();
    expect(screen.queryByTestId('postlaunch-budget')).toBeNull();
  });

  it('点评分触发跑分；跑分中按钮禁用', () => {
    const onRun = vi.fn();
    const { rerender } = render(
      <PostLaunchCard report={report()} running={false} error={null} days={7} onRun={onRun} onOpenSession={noop} />,
    );
    fireEvent.click(screen.getByTestId('postlaunch-run'));
    expect(onRun).toHaveBeenCalledTimes(1);

    rerender(<PostLaunchCard report={report()} running error={null} days={7} onRun={onRun} onOpenSession={noop} />);
    expect((screen.getByTestId('postlaunch-run') as HTMLButtonElement).disabled).toBe(true);
  });

  it('点会话芯片下钻到现有会话回放', () => {
    const onOpenSession = vi.fn();
    render(<PostLaunchCard report={report()} running={false} error={null} days={7} onRun={noop} onOpenSession={onOpenSession} />);
    fireEvent.click(screen.getByTestId('postlaunch-session-session-abcdef123'));
    expect(onOpenSession).toHaveBeenCalledWith('session-abcdef123');
  });

  it('⑦打分模型没给出判决时卡上出一行人话，不是静默（09-05 真机截图上这里什么都没有）', () => {
    render(
      <PostLaunchCard
        report={report({ judgeUnavailableTurns: 3 })}
        running={false} error={null} days={7} onRun={noop} onOpenSession={noop}
      />,
    );
    const hint = screen.getByTestId('postlaunch-judge-unavailable').textContent ?? '';
    expect(hint).toContain('3 轮');
    expect(hint).toContain('评分模型');
  });

  it('⑦judge 都正常时不出这行', () => {
    render(<PostLaunchCard report={report()} running={false} error={null} days={7} onRun={noop} onOpenSession={noop} />);
    expect(screen.queryByTestId('postlaunch-judge-unavailable')).toBeNull();
  });

  it('②预算里有按保守默认价估的部分时说明白，别让人以为是真实账单', () => {
    const assumed = report();
    assumed.budget = { ...assumed.budget, assumedUsd: 0.08 };
    render(<PostLaunchCard report={assumed} running={false} error={null} days={7} onRun={noop} onOpenSession={noop} />);
    expect(screen.getByTestId('postlaunch-budget-assumed').textContent).toContain('保守默认价');
    // 没有兜底价的那份报告不出这行
    render(<PostLaunchCard report={report()} running={false} error={null} days={7} onRun={noop} onOpenSession={noop} />);
    expect(screen.queryAllByTestId('postlaunch-budget-assumed')).toHaveLength(1);
  });

  it('失败类别与信号分布都渲染出来', () => {
    render(<PostLaunchCard report={report()} running={false} error={null} days={7} onRun={noop} onOpenSession={noop} />);
    expect(screen.getByTestId('postlaunch-failure-classes').textContent).toContain('timeout 1');
    expect(screen.getByTestId('postlaunch-signals').textContent).toContain('timeout 1');
  });
});
