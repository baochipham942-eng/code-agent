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

// 用本地时区构造，断言字符串才不随跑测机器的 TZ 漂
const STARTED_AT = new Date(2026, 8, 5, 12, 12).getTime();

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
      sessions: [{ id: 'session-abcdef123', title: '给券组加灰度开关', startedAt: STARTED_AT }],
    }],
    judgeUnavailableTurns: 0,
    calibration: { state: 'insufficient', reason: 'no_record' },
    budget: { day: '2026-09-05', spentUsd: 0.12, limitUsd: 0.5, sampledCount: 3, sampleLimit: 20, assumedUsd: 0, stopped: false },
    ...overrides,
  };
}

const noop = (): void => {};

describe('上线后质量卡', () => {
  // CARDPIVOT 起：信号轮/抽样轮从「两行」改成「两个分段页签」，默认抽样轮。
  // 原来的 postlaunch-row-<scope> 断言跟着改成 postlaunch-panel-<scope>——
  // 维度成了行，scope 成了整张表的口径，再叫 row 是骗人的。
  it('默认看抽样轮，切到信号轮换的是值不是列结构', () => {
    render(<PostLaunchCard report={report()} running={false} error={null} days={7} onRun={noop} onOpenSession={noop} />);
    expect(screen.getByTestId('postlaunch-panel-sample')).toBeTruthy();
    expect(screen.queryByTestId('postlaunch-panel-signal')).toBeNull();
    expect(screen.getByTestId('postlaunch-sample-goal').textContent).toBe('100%');
    const columnsBefore = screen.getAllByTestId(/^postlaunch-col-/).map((th) => th.textContent);

    fireEvent.click(screen.getByTestId('postlaunch-scope-signal'));
    expect(screen.getByTestId('postlaunch-panel-signal')).toBeTruthy();
    expect(screen.queryByTestId('postlaunch-panel-sample')).toBeNull();
    expect(screen.getByTestId('postlaunch-signal-goal').textContent).toBe('50%');
    // 列结构不变：还是那一列，只有列头 N 跟着轮类型改
    const columnsAfter = screen.getAllByTestId(/^postlaunch-col-/);
    expect(columnsAfter).toHaveLength(columnsBefore.length);
    expect(columnsAfter[0].textContent).toContain('2 轮');
  });

  it('没判决的维度显示占位，不显示 0%——0% 和「没评过」不是一回事', () => {
    render(<PostLaunchCard report={report()} running={false} error={null} days={7} onRun={noop} onOpenSession={noop} />);
    fireEvent.click(screen.getByTestId('postlaunch-scope-signal'));
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

  it('会话收进弹层：点「会话 N」才出芯片，芯片仍下钻到现有会话回放', () => {
    const onOpenSession = vi.fn();
    render(<PostLaunchCard report={report()} running={false} error={null} days={7} onRun={noop} onOpenSession={onOpenSession} />);
    // 弹层没开时芯片不在卡上，卡片不再被几十个芯片撑长
    expect(screen.queryByTestId('postlaunch-session-session-abcdef123')).toBeNull();
    fireEvent.click(screen.getByTestId('postlaunch-sessions-0'));
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

  it('Nit①judge 不可用的提示要说准：安全/产物仍算，重跑不会重评', () => {
    render(
      <PostLaunchCard
        report={report({ judgeUnavailableTurns: 2 })}
        running={false} error={null} days={7} onRun={noop} onOpenSession={noop}
      />,
    );
    const hint = screen.getByTestId('postlaunch-judge-unavailable').textContent ?? '';
    expect(hint).toContain('安全与产物');
    expect(hint).toContain('跳过');
    // 别再说「六维都没有」——那是假的
    expect(hint).not.toContain('六维');
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

  it('⑨卡头写出分组口径，校准角标与预算行位置不动', () => {
    const { container } = render(
      <PostLaunchCard report={report()} running={false} error={null} days={7} onRun={noop} onOpenSession={noop} />,
    );
    expect(container.querySelector('h3')?.textContent).toContain('按周 × app 版本 × 提示词版本');
    // 角标与预算行仍在表格之前——K2 那两行提示的落位没被透视改掉
    const order = [...container.querySelectorAll('[data-testid]')].map((node) => node.getAttribute('data-testid'));
    expect(order.indexOf('postlaunch-calibration')).toBeLessThan(order.indexOf('postlaunch-budget'));
    expect(order.indexOf('postlaunch-budget')).toBeLessThan(order.indexOf('postlaunch-panel-sample'));
  });
});

// ── 多分组：透视的列、Δ、灰列、折叠都要在真组件上看得见 ────────────────────
function multi(): PostLaunchReport {
  const dims = (rates: Array<[number, number]>) => ({
    goal: { judged: rates[0][0], passed: rates[0][1] },
    orchestration: { judged: rates[1][0], passed: rates[1][1] },
    tools: { judged: rates[2][0], passed: rates[2][1] },
    permission: { judged: rates[3][0], passed: rates[3][1] },
    safety: { judged: rates[4][0], passed: rates[4][1] },
    artifact: { judged: rates[5][0], passed: rates[5][1] },
  });
  const none: Array<[number, number]> = [[0, 0], [0, 0], [0, 0], [0, 0], [0, 0], [0, 0]];
  // 报告真实是 weekStart 倒序出来的，故意这么摆，看组件有没有把时间正过来
  return report({
    groups: [
      {
        weekStart: '2026-08-31', appVersion: '0.33.0', promptVersion: 'sys-v45',
        rows: [
          { scope: 'signal', turns: 0, dims: dims(none) },
          { scope: 'sample', turns: 19, dims: dims([[18, 6], [18, 17], [18, 14], [19, 19], [19, 19], [19, 19]]) },
        ],
        failureClasses: [{ code: 'unknown', count: 12 }], signals: [], costUsd: 0,
        sessions: [
          { id: 's1', title: '排查卡券核销超时', startedAt: STARTED_AT },
          { id: 's2', title: '', startedAt: STARTED_AT },
        ],
      },
      {
        weekStart: '2026-08-24', appVersion: '0.33.0', promptVersion: 'sys-v45',
        rows: [
          { scope: 'signal', turns: 15, dims: dims([[14, 2], [15, 15], [14, 12], [15, 14], [15, 14], [15, 15]]) },
          { scope: 'sample', turns: 13, dims: dims([[12, 6], [13, 13], [13, 13], [13, 13], [13, 13], [13, 13]]) },
        ],
        failureClasses: [], signals: [{ kind: 'error_terminated', count: 12 }], costUsd: 0,
        sessions: [{ id: 's3', title: '改遥测页布局', startedAt: 0 }],
      },
      {
        weekStart: '2026-08-24', appVersion: '0.33.0', promptVersion: 'sys-v44',
        rows: [
          { scope: 'signal', turns: 1, dims: dims([[1, 0], [1, 1], [1, 1], [1, 1], [1, 1], [1, 1]]) },
          { scope: 'sample', turns: 1, dims: dims([[0, 0], [0, 0], [0, 0], [0, 0], [1, 1], [1, 1]]) },
        ],
        failureClasses: [], signals: [], costUsd: 0,
        sessions: [{ id: 's4', title: '写周报', startedAt: STARTED_AT }],
      },
    ],
  });
}

describe('上线后质量卡 · 透视与环比', () => {
  it('⑤维度做行、分组做列，时间从左到右，列头带样本数', () => {
    render(<PostLaunchCard report={multi()} running={false} error={null} days={7} onRun={noop} onOpenSession={noop} />);
    const columns = screen.getAllByTestId(/^postlaunch-col-/);
    expect(columns.map((th) => th.textContent)).toEqual([
      expect.stringContaining('2026-08-24'),
      expect.stringContaining('2026-08-24'),
      expect.stringContaining('2026-08-31'),
    ]);
    expect(columns[0].textContent).toContain('sys-v44');
    expect(columns[1].textContent).toContain('sys-v45');
    expect(columns[2].textContent).toContain('19 轮');
    // 六维各一行
    expect(screen.getAllByTestId(/^postlaunch-row-/)).toHaveLength(6);
  });

  it('⑤N < 5 的列标「样本少」，够样本的列不标', () => {
    render(<PostLaunchCard report={multi()} running={false} error={null} days={7} onRun={noop} onOpenSession={noop} />);
    expect(screen.getByTestId('postlaunch-col-0').textContent).toContain('样本少');
    expect(screen.getByTestId('postlaunch-col-1').textContent).not.toContain('样本少');
  });

  it('⑤该轮类型 0 轮的列整列 —，标「无该类轮」，整组明细也不冒充', () => {
    render(<PostLaunchCard report={multi()} running={false} error={null} days={7} onRun={noop} onOpenSession={noop} />);
    fireEvent.click(screen.getByTestId('postlaunch-scope-signal'));
    expect(screen.getByTestId('postlaunch-col-2').textContent).toContain('无该类轮');
    expect(screen.getByTestId('postlaunch-cell-goal-2').textContent).toBe('—');
    expect(screen.getByTestId('postlaunch-cell-safety-2').textContent).toBe('—');
    // 空列的失败类别不显示 unknown 12——那是整组的数，不是这一类轮的
    const failures = screen.getByTestId('postlaunch-failure-classes');
    expect(failures.textContent).not.toContain('unknown 12');
    // 真阴：切回抽样轮，同一列的整组明细看得见
    fireEvent.click(screen.getByTestId('postlaunch-scope-sample'));
    expect(screen.getByTestId('postlaunch-failure-classes').textContent).toContain('unknown 12');
  });

  it('⑥Δ 只跟左邻列比，掉了红、升了绿、持平弱化', () => {
    render(<PostLaunchCard report={multi()} running={false} error={null} days={7} onRun={noop} onOpenSession={noop} />);
    const tools = screen.getByTestId('postlaunch-delta-tools-2');
    expect(tools.textContent).toContain('▼ 22');
    expect(tools.className).toContain('text-badge-danger');
    expect(tools.getAttribute('title')).toBe('算得：78 − 100 = -22 个百分点');
    // 持平既不红也不绿
    const permission = screen.getByTestId('postlaunch-delta-permission-2');
    expect(permission.textContent).toContain('持平');
    expect(permission.className).not.toContain('text-badge');
    // 升了是绿的：信号轮目标维 0% → 14%
    fireEvent.click(screen.getByTestId('postlaunch-scope-signal'));
    const goal = screen.getByTestId('postlaunch-delta-goal-1');
    expect(goal.textContent).toContain('▲ +14');
    expect(goal.className).toContain('text-badge-success');
  });

  it('⑥可见首列与「—」相邻的格子都不标 Δ', () => {
    render(<PostLaunchCard report={multi()} running={false} error={null} days={7} onRun={noop} onOpenSession={noop} />);
    expect(screen.queryByTestId('postlaunch-delta-goal-0')).toBeNull();
    // 左邻（sys-v44 抽样轮）目标维是 —，第二列的目标维就不算 Δ
    expect(screen.getByTestId('postlaunch-cell-goal-0').textContent).toBe('—');
    expect(screen.queryByTestId('postlaunch-delta-goal-1')).toBeNull();
    // 真阳对照：同一列的安全维两侧都有值，Δ 标出来了
    expect(screen.getByTestId('postlaunch-delta-safety-1')).toBeTruthy();
  });

  it('⑧失败类别/信号/成本按列摆，标「整组」；会话是弹层按钮不是一排芯片', () => {
    render(<PostLaunchCard report={multi()} running={false} error={null} days={7} onRun={noop} onOpenSession={noop} />);
    expect(screen.getByTestId('postlaunch-failure-classes').textContent).toContain('整组');
    expect(screen.getByTestId('postlaunch-signals').textContent).toContain('error_terminated 12');
    expect(screen.getByTestId('postlaunch-cost').textContent).toContain('$0.0000');
    expect(screen.getByTestId('postlaunch-sessions-2').textContent).toContain('会话 2');
    expect(screen.queryByTestId('postlaunch-session-s1')).toBeNull();
  });

  it('⑧会话弹层能开能关，关掉后芯片不再留在卡上', () => {
    render(<PostLaunchCard report={multi()} running={false} error={null} days={7} onRun={noop} onOpenSession={noop} />);
    fireEvent.click(screen.getByTestId('postlaunch-sessions-2'));
    expect(screen.getByTestId('postlaunch-session-s1')).toBeTruthy();
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByTestId('postlaunch-session-s1')).toBeNull();
  });

  it('⑤超过 4 列时默认最近 3 列，点「更早」补回全部', () => {
    const many = report({
      groups: ['2026-07-06', '2026-07-13', '2026-07-20', '2026-07-27', '2026-08-03'].map((weekStart) => ({
        weekStart,
        appVersion: '0.33.0',
        promptVersion: 'p1',
        rows: [
          { scope: 'signal' as const, turns: 6, dims: report().groups[0].rows[0].dims },
          { scope: 'sample' as const, turns: 6, dims: report().groups[0].rows[1].dims },
        ],
        failureClasses: [], signals: [], costUsd: 0, sessions: [],
      })),
    });
    render(<PostLaunchCard report={many} running={false} error={null} days={7} onRun={noop} onOpenSession={noop} />);
    expect(screen.getAllByTestId(/^postlaunch-col-/)).toHaveLength(3);
    expect(screen.getByTestId('postlaunch-col-0').textContent).toContain('2026-07-20');

    fireEvent.click(screen.getByTestId('postlaunch-earlier'));
    expect(screen.getAllByTestId(/^postlaunch-col-/)).toHaveLength(5);
    expect(screen.getByTestId('postlaunch-col-0').textContent).toContain('2026-07-06');
  });

  it('⑤只有 3 列时不出「更早」按钮', () => {
    render(<PostLaunchCard report={multi()} running={false} error={null} days={7} onRun={noop} onOpenSession={noop} />);
    expect(screen.queryByTestId('postlaunch-earlier')).toBeNull();
  });

  // ⑦芯片得认得出是哪条会话。原来是 id.slice(0, 8)：真机上 CLI 会话全长成 cli_sess、
  // App 会话是 8 位随机 hex，一排看下来完全一样（09-05 shot-4 实付）。
  it('⑦有标题的会话芯片显示标题 + 开始时间，不是 id 前 8 位', () => {
    render(<PostLaunchCard report={multi()} running={false} error={null} days={7} onRun={noop} onOpenSession={noop} />);
    fireEvent.click(screen.getByTestId('postlaunch-sessions-2'));
    const chip = screen.getByTestId('postlaunch-session-s1');
    expect(chip.textContent).toBe('排查卡券核销超时 · 09-05 12:12');
    // 真阴：不能再是 id 前缀
    expect(chip.textContent).not.toContain('s1');
  });

  it('⑦没标题才回落 id 前 8 位；没开始时间就只剩名字', () => {
    render(<PostLaunchCard report={multi()} running={false} error={null} days={7} onRun={noop} onOpenSession={noop} />);
    fireEvent.click(screen.getByTestId('postlaunch-sessions-2'));
    // s2 标题是空串 ⇒ 回落 id 前缀，时间照挂
    expect(screen.getByTestId('postlaunch-session-s2').textContent).toBe('s2 · 09-05 12:12');
    fireEvent.keyDown(document, { key: 'Escape' });
    // s3 有标题但 startedAt=0（会话已删，JOIN 落空）⇒ 只出名字，不出 1970
    fireEvent.click(screen.getByTestId('postlaunch-sessions-1'));
    expect(screen.getByTestId('postlaunch-session-s3').textContent).toBe('改遥测页布局');
  });

  it('⑦芯片文字换了，testid 与跳转行为没换', () => {
    const onOpenSession = vi.fn();
    render(<PostLaunchCard report={multi()} running={false} error={null} days={7} onRun={noop} onOpenSession={onOpenSession} />);
    fireEvent.click(screen.getByTestId('postlaunch-sessions-2'));
    fireEvent.click(screen.getByTestId('postlaunch-session-s1'));
    expect(onOpenSession).toHaveBeenCalledWith('s1');
  });

  it('200 场候选渲染时回流入口可用，传给预览的 sessionIds 不超过 20', () => {
    const onOpenHarvest = vi.fn();
    const reflowCandidates = Array.from({ length: 200 }, (_, index) => ({
      sessionId: `sess-${String(index).padStart(3, '0')}`,
      turnId: `t-${index}`,
      judgeVersion: 'postlaunch-judge-v1',
      redDimensions: ['goal'] as Array<'goal'>,
      signals: [],
      failureClass: null,
      sources: ['judge'] as Array<'judge'>,
    }));
    render(
      <PostLaunchCard
        report={report()}
        running={false}
        error={null}
        days={7}
        onRun={noop}
        onOpenSession={noop}
        reflowCandidates={reflowCandidates}
        onOpenHarvest={onOpenHarvest}
      />,
    );
    expect(screen.getByTestId('postlaunch-reflow-entry')).toBeTruthy();
    const open = screen.getByTestId('postlaunch-reflow-open') as HTMLButtonElement;
    expect(open.disabled).toBe(false);
    fireEvent.click(open);
    expect(onOpenHarvest).toHaveBeenCalledTimes(1);
    const sessionIds = onOpenHarvest.mock.calls[0]?.[0] as string[];
    expect(sessionIds.length).toBeLessThanOrEqual(20);
    expect(sessionIds).toHaveLength(20);
    expect(sessionIds.every((id) => /^sess-\d{3}$/.test(id))).toBe(true);
  });

  it('无评分报告但有点踩候选时，卡面回流入口可见可用，传出 sessionIds ≤20', () => {
    const onOpenHarvest = vi.fn();
    const reflowCandidates = Array.from({ length: 25 }, (_, index) => ({
      sessionId: `down-${String(index).padStart(2, '0')}`,
      turnId: `aaaaaaaa-bbbb-4ccc-8ddd-${String(index).padStart(12, '0')}`,
      judgeVersion: null,
      redDimensions: [] as Array<'goal'>,
      signals: [],
      failureClass: null,
      sources: ['feedback'] as Array<'feedback'>,
    }));
    render(
      <PostLaunchCard
        report={null}
        running={false}
        error={null}
        days={7}
        onRun={noop}
        onOpenSession={noop}
        reflowCandidates={reflowCandidates}
        onOpenHarvest={onOpenHarvest}
      />,
    );
    expect(screen.getByTestId('postlaunch-empty')).toBeTruthy();
    expect(screen.queryByTestId('postlaunch-sessions-0')).toBeNull();
    expect(screen.getByTestId('postlaunch-reflow-entry')).toBeTruthy();
    fireEvent.click(screen.getByTestId('postlaunch-reflow-open'));
    expect(onOpenHarvest).toHaveBeenCalledTimes(1);
    const sessionIds = onOpenHarvest.mock.calls[0]?.[0] as string[];
    expect(sessionIds.length).toBeLessThanOrEqual(20);
    expect(sessionIds).toHaveLength(20);
    expect(sessionIds.every((id) => /^down-\d{2}$/.test(id))).toBe(true);
  });
});
