// 上线后质量卡的透视纯函数：摆列、算 Δ、判灰列、折叠更早。
// 每条判据都配一真阳一真阴——只写真阳的话，一个「delta 永远返回 null」的实现能全绿。
// 数据取 2026-09-05 对齐页那三组真实分组（08-24 sys-v44 / 08-24 sys-v45 / 08-31 sys-v45）。
import { describe, expect, it } from 'vitest';

import { pivotPostLaunchReport } from '@internal-evaluation/renderer/telemetry/postLaunchPivot';
import type {
  PostLaunchDimension,
  PostLaunchDimRate,
  PostLaunchReport,
  PostLaunchReportGroup,
} from '../../../src/shared/contract/postLaunchScore';

type Rates = Partial<Record<PostLaunchDimension, [judged: number, passed: number]>>;

function dims(rates: Rates): Record<PostLaunchDimension, PostLaunchDimRate> {
  const empty: PostLaunchDimRate = { judged: 0, passed: 0 };
  const build = (dimension: PostLaunchDimension): PostLaunchDimRate => {
    const pair = rates[dimension];
    return pair ? { judged: pair[0], passed: pair[1] } : empty;
  };
  return {
    goal: build('goal'),
    orchestration: build('orchestration'),
    tools: build('tools'),
    permission: build('permission'),
    safety: build('safety'),
    artifact: build('artifact'),
  };
}

function group(
  weekStart: string,
  promptVersion: string | null,
  signal: { turns: number; rates: Rates },
  sample: { turns: number; rates: Rates },
  extra: Partial<PostLaunchReportGroup> = {},
): PostLaunchReportGroup {
  return {
    weekStart,
    appVersion: '0.33.0',
    promptVersion,
    rows: [
      { scope: 'signal', turns: signal.turns, dims: dims(signal.rates) },
      { scope: 'sample', turns: sample.turns, dims: dims(sample.rates) },
    ],
    failureClasses: [],
    signals: [],
    costUsd: 0,
    sessions: [],
    ...extra,
  };
}

function report(groups: PostLaunchReportGroup[]): PostLaunchReport {
  return {
    generatedAt: 0,
    days: 7,
    judgeVersion: 'postlaunch-judge-v1',
    rubricVersion: 'postlaunch-rubric-v1',
    scoredTurns: 0,
    groups,
    judgeUnavailableTurns: 0,
    calibration: { state: 'insufficient', reason: 'no_record' },
    budget: { day: '2026-09-05', spentUsd: 0, limitUsd: 0.5, sampledCount: 0, sampleLimit: 20, assumedUsd: 0, stopped: false },
  };
}

// 对齐页那三组真实数据。故意按报告真实的出场顺序（weekStart 倒序）摆，
// 因为 postLaunchScoreStore 就是这么排的——透视自己得把时间正过来。
const v44 = group(
  '2026-08-24', 'sys-v44',
  { turns: 1, rates: { goal: [1, 0], orchestration: [1, 1], tools: [1, 1], permission: [1, 1], safety: [1, 1], artifact: [1, 1] } },
  { turns: 1, rates: { safety: [1, 1], artifact: [1, 1] } },
  { failureClasses: [{ code: 'missing_artifact', count: 1 }], signals: [{ kind: 'error_terminated', count: 1 }], costUsd: 0, sessions: [{ id: 'web-sess-1', title: '看券组', startedAt: 1 }, { id: 'web-sess-2', title: '', startedAt: 0 }] },
);
const v45Week1 = group(
  '2026-08-24', 'sys-v45',
  { turns: 15, rates: { goal: [14, 2], orchestration: [15, 15], tools: [14, 12], permission: [15, 14], safety: [15, 14], artifact: [15, 15] } },
  { turns: 13, rates: { goal: [12, 6], orchestration: [13, 13], tools: [13, 13], permission: [13, 13], safety: [13, 13], artifact: [13, 13] } },
);
const v45Week2 = group(
  '2026-08-31', 'sys-v45',
  { turns: 0, rates: {} },
  { turns: 19, rates: { goal: [18, 6], orchestration: [18, 17], tools: [18, 14], permission: [19, 19], safety: [19, 19], artifact: [19, 19] } },
);
const threeGroups = report([v45Week2, v45Week1, v44]);

function keys(pivot: ReturnType<typeof pivotPostLaunchReport>): string[] {
  return pivot.columns.map((column) => `${column.weekStart}|${column.promptVersion}`);
}

describe('pivotPostLaunchReport', () => {
  it('①列按时间升序、同周按提示词版本自然序，不沿用报告的倒序', () => {
    const pivot = pivotPostLaunchReport(threeGroups, 'sample');
    expect(keys(pivot)).toEqual(['2026-08-24|sys-v44', '2026-08-24|sys-v45', '2026-08-31|sys-v45']);
    // 真阴：报告给进来的就是倒序，输出必须跟它不一样，否则等于没排
    expect(keys(pivot)).not.toEqual(threeGroups.groups.map((g) => `${g.weekStart}|${g.promptVersion}`));
  });

  it('①sys-v9 排在 sys-v10 左边（自然序，不是字典序）', () => {
    const pivot = pivotPostLaunchReport(
      report([
        group('2026-08-24', 'sys-v10', { turns: 5, rates: {} }, { turns: 5, rates: {} }),
        group('2026-08-24', 'sys-v9', { turns: 5, rates: {} }, { turns: 5, rates: {} }),
      ]),
      'sample',
    );
    expect(pivot.columns.map((column) => column.promptVersion)).toEqual(['sys-v9', 'sys-v10']);
  });

  it('①通过率取报告的分子分母四舍五入；没判决是 null 不是 0', () => {
    const [v44Column, , latest] = pivotPostLaunchReport(threeGroups, 'sample').columns;
    expect(latest.cells.goal.rate).toBe(33);
    expect(latest.cells.tools.rate).toBe(78);
    // 真阴：抽样轮里 v44 那组目标维一轮判决都没有，得是 null，不能算成 0%
    expect(v44Column.cells.goal.rate).toBeNull();
    expect(v44Column.cells.safety.rate).toBe(100);
  });

  it('②Δ 只跟左邻列比，方向与数值都对得上显示值', () => {
    const columns = pivotPostLaunchReport(threeGroups, 'sample').columns;
    expect(columns[2].cells.tools.delta).toBe(-22); // 78 − 100
    expect(columns[2].cells.goal.delta).toBe(-17); // 33 − 50
    expect(columns[2].cells.orchestration.delta).toBe(-6); // 94 − 100
    // 持平是 0，不是 null——0 要显示「持平」，null 什么都不显示
    expect(columns[2].cells.permission.delta).toBe(0);
    // 真阴：最左侧可见列没有左邻，一格 Δ 都不该有
    expect(Object.values(columns[0].cells).every((cell) => cell.delta === null)).toBe(true);
  });

  it('②任一侧是「—」就不算 Δ，也不跨列去找上上列当基线', () => {
    const columns = pivotPostLaunchReport(threeGroups, 'sample').columns;
    // 左邻（v44 抽样轮）的目标维是 —，所以第二列的目标维没有 Δ
    expect(columns[1].cells.goal.rate).toBe(50);
    expect(columns[1].cells.goal.delta).toBeNull();
    // 真阳对照：同一列的安全维两侧都有值，Δ 照算
    expect(columns[1].cells.safety.delta).toBe(0);
  });

  it('③N < 5 整列置灰，N ≥ 5 不灰', () => {
    const columns = pivotPostLaunchReport(threeGroups, 'sample').columns;
    expect(columns[0].turns).toBe(1);
    expect(columns[0].lowSample).toBe(true);
    // 真阴：13 轮那列不灰
    expect(columns[1].lowSample).toBe(false);
  });

  it('③灰列的边界正好落在 5：4 轮灰、5 轮不灰', () => {
    const boundary = report([
      group('2026-08-24', 'p4', { turns: 4, rates: {} }, { turns: 4, rates: {} }),
      group('2026-08-31', 'p5', { turns: 5, rates: {} }, { turns: 5, rates: {} }),
    ]);
    const columns = pivotPostLaunchReport(boundary, 'sample').columns;
    expect(columns.map((column) => column.lowSample)).toEqual([true, false]);
  });

  it('④该轮类型 0 轮的列整列 —，标 empty，且不产生 Δ', () => {
    const columns = pivotPostLaunchReport(threeGroups, 'signal').columns;
    const zero = columns[2];
    expect(zero.turns).toBe(0);
    expect(zero.empty).toBe(true);
    expect(zero.lowSample).toBe(true);
    expect(Object.values(zero.cells).every((cell) => cell.rate === null && cell.delta === null)).toBe(true);
    // 真阴：同一份数据切成抽样轮，这一列有 19 轮，不是空列
    expect(pivotPostLaunchReport(threeGroups, 'sample').columns[2].empty).toBe(false);
  });

  it('④信号轮的值跟抽样轮不是一套，但列结构（列数与列身份）一样', () => {
    const sample = pivotPostLaunchReport(threeGroups, 'sample');
    const signal = pivotPostLaunchReport(threeGroups, 'signal');
    expect(keys(signal)).toEqual(keys(sample));
    expect(signal.columns[1].cells.goal.rate).toBe(14);
    expect(sample.columns[1].cells.goal.rate).toBe(50);
    // 整组明细两套一样：报告里就只有整组口径，不按轮类型分拆
    expect(signal.columns[0].failureClasses).toEqual(sample.columns[0].failureClasses);
    expect(signal.columns[0].sessions).toEqual(sample.columns[0].sessions);
  });

  it('⑤超过 4 列时默认只留最近 3 列，可见首列不引用被折起来的基线', () => {
    const many = report(['2026-07-06', '2026-07-13', '2026-07-20', '2026-07-27', '2026-08-03'].map(
      (week) => group(week, 'p1', { turns: 6, rates: { goal: [6, 3] } }, { turns: 6, rates: { goal: [6, 3] } }),
    ));
    const collapsed = pivotPostLaunchReport(many, 'sample');
    expect(collapsed.hiddenCount).toBe(2);
    expect(keys(collapsed)).toEqual(['2026-07-20|p1', '2026-07-27|p1', '2026-08-03|p1']);
    expect(collapsed.columns[0].cells.goal.delta).toBeNull();
    // 展开后补回全部列，原来的可见首列这才拿到左邻
    const opened = pivotPostLaunchReport(many, 'sample', true);
    expect(opened.hiddenCount).toBe(0);
    expect(opened.columns).toHaveLength(5);
    expect(opened.columns[2].cells.goal.delta).toBe(0);
  });

  it('⑤正好 4 列不折叠', () => {
    const four = report(['2026-07-13', '2026-07-20', '2026-07-27', '2026-08-03'].map(
      (week) => group(week, 'p1', { turns: 6, rates: {} }, { turns: 6, rates: {} }),
    ));
    const pivot = pivotPostLaunchReport(four, 'sample');
    expect(pivot.hiddenCount).toBe(0);
    expect(pivot.columns).toHaveLength(4);
  });

  it('报告为空或形状不对时给空透视，不抛', () => {
    expect(pivotPostLaunchReport(null, 'sample')).toEqual({ columns: [], hiddenCount: 0 });
    expect(pivotPostLaunchReport(report([]), 'signal').columns).toHaveLength(0);
  });
});
