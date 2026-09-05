// ============================================================================
// 上线后质量卡的透视模型（N-EVAL-POSTLAUNCH-CARDPIVOT）
// ----------------------------------------------------------------------------
// 维度做行、分组做列。这里只做「摆列 + 减法」，一个比率都不重算：
// 通过率仍是 passed/judged 四舍五入到整数，Δ 是两个**已经显示出来的**整数百分数
// 相减——卡上看到 33 与 50，差就一定是 17，不会出现显示值与差值对不上的裂缝。
//
// 三条不许越的线（对齐页「决策点」爸已点头）：
//   ① 任一侧没有判决（—）就不算 Δ，不跨列去找上上列当基线；
//   ② 该轮类型 0 轮的列整列留空，「没有这类轮」不是「通过率为 0」；
//   ③ 失败类别 / 信号 / 成本 / 会话仍是整组口径，不按轮类型重新分拆——
//      报告里压根没有分拆后的计数，编一个出来比不显示更糟。
// ============================================================================
import type {
  PostLaunchDimension,
  PostLaunchReport,
  PostLaunchReportGroup,
  PostLaunchScopeRow,
} from '@shared/contract/postLaunchScore';
import { POST_LAUNCH_DIMENSIONS } from '@shared/contract/postLaunchScore';

/** 少于这么多轮的列整列置灰并标「样本少」。展示规则，不是统计显著性阈值。 */
const LOW_SAMPLE_TURNS = 5;
/** 超过这么多列才折叠——4 列还能一眼扫完。 */
const COLLAPSE_ABOVE_COLUMNS = 4;
/** 折叠时保留的最近列数。 */
const COLLAPSED_COLUMNS = 3;

interface PostLaunchPivotCell {
  /** 整数百分比；无判决为 null（渲染成 —）。 */
  rate: number | null;
  /** 与左邻可见列的百分点差；任一侧无值、或本列是可见首列时为 null。 */
  delta: number | null;
}

export interface PostLaunchPivotColumn {
  weekStart: string;
  appVersion: string;
  promptVersion: string | null;
  /** 当前轮类型下的轮数（列头 N）。 */
  turns: number;
  /** N < 5：整列置灰。0 轮也算样本少。 */
  lowSample: boolean;
  /** 当前轮类型一轮都没有：整列 —，整组明细也不展开。 */
  empty: boolean;
  cells: Record<PostLaunchDimension, PostLaunchPivotCell>;
  failureClasses: PostLaunchReportGroup['failureClasses'];
  signals: PostLaunchReportGroup['signals'];
  costUsd: number;
  sessionIds: string[];
}

export interface PostLaunchPivot {
  /** 时间从左到右；折叠时只含可见的那几列。 */
  columns: PostLaunchPivotColumn[];
  /** 折叠掉的更早列数；0 表示没折叠。 */
  hiddenCount: number;
}

/** sys-v9 要排在 sys-v10 左边，字典序会把它排到右边，所以走 numeric 比较。 */
function natural(left: string, right: string): number {
  return left.localeCompare(right, undefined, { numeric: true });
}

function compareGroups(left: PostLaunchReportGroup, right: PostLaunchReportGroup): number {
  return natural(left.weekStart, right.weekStart)
    || natural(left.appVersion, right.appVersion)
    || natural(left.promptVersion ?? '', right.promptVersion ?? '');
}

function rateOf(row: PostLaunchScopeRow | undefined, dimension: PostLaunchDimension): number | null {
  const rate = row?.dims?.[dimension];
  if (!rate || rate.judged === 0) return null;
  return Math.round((rate.passed / rate.judged) * 100);
}

/**
 * 把报告的分组平铺转成「维度做行、分组做列」的透视。
 *
 * @param scope 当前看的轮类型；信号轮与抽样轮各自成表，列结构一样、值不一样。
 * @param expanded 是否已展开「更早」。折叠时 Δ 只在可见窗口内相减，
 *   可见首列不去引用被折起来的那一列当基线（否则用户看不到基线却看得到差）。
 */
export function pivotPostLaunchReport(
  report: PostLaunchReport | null | undefined,
  scope: PostLaunchScopeRow['scope'],
  expanded = false,
): PostLaunchPivot {
  const groups = Array.isArray(report?.groups) ? [...report.groups] : [];
  groups.sort(compareGroups);

  const hiddenCount = !expanded && groups.length > COLLAPSE_ABOVE_COLUMNS
    ? groups.length - COLLAPSED_COLUMNS
    : 0;

  const columns: PostLaunchPivotColumn[] = [];
  for (const group of groups.slice(hiddenCount)) {
    const row = group.rows?.find((candidate) => candidate.scope === scope);
    const turns = row?.turns ?? 0;
    const previous = columns[columns.length - 1];
    const cells = {} as Record<PostLaunchDimension, PostLaunchPivotCell>;
    for (const dimension of POST_LAUNCH_DIMENSIONS) {
      const rate = turns === 0 ? null : rateOf(row, dimension);
      const before = previous?.cells[dimension].rate ?? null;
      cells[dimension] = {
        rate,
        delta: rate === null || before === null ? null : rate - before,
      };
    }
    columns.push({
      weekStart: group.weekStart,
      appVersion: group.appVersion,
      promptVersion: group.promptVersion,
      turns,
      lowSample: turns < LOW_SAMPLE_TURNS,
      empty: turns === 0,
      failureClasses: group.failureClasses ?? [],
      signals: group.signals ?? [],
      costUsd: group.costUsd,
      sessionIds: group.sessionIds ?? [],
      cells,
    });
  }

  return { columns, hiddenCount };
}
