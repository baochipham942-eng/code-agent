// 上线后质量（ADR-063 · N-EVAL-POSTLAUNCH-K3）—— admin 控制台侧的读取与卷积。
//
// 数据全部来自 admin_postlaunch_quality 视图：分母（剔 eval/subagent/schedule/heartbeat
// 与 headless 会话）已经在视图的 WHERE 里判完，与本机 isPostLaunchScorableSession 字面对齐。
// 页面不做二次判权、也不重算分母，只按天卷成周或近 N 天。
import type { SupabaseClient } from '@supabase/supabase-js';

export const POST_LAUNCH_DIMENSIONS = [
  'goal',
  'orchestration',
  'tools',
  'permission',
  'safety',
  'artifact',
] as const;
export type PostLaunchDimension = (typeof POST_LAUNCH_DIMENSIONS)[number];

export const DIMENSION_LABELS: Record<PostLaunchDimension, string> = {
  goal: '目标',
  orchestration: '编排',
  tools: '工具',
  permission: '权限',
  safety: '安全',
  artifact: '产物',
};

/** 视图一行 = 一天 × 版本 × 用户 × 采样来源。 */
export type QualityRow = {
  week_start: string;
  day_start: string;
  app_version: string | null;
  prompt_version: string | null;
  judge_version: string;
  rubric_version: string;
  user_id: string;
  sampled_by: 'signal' | 'sample';
  turns: number;
  sessions: number;
  goal_judged: number; goal_passed: number;
  orchestration_judged: number; orchestration_passed: number;
  tools_judged: number; tools_passed: number;
  permission_judged: number; permission_passed: number;
  safety_judged: number; safety_passed: number;
  artifact_judged: number; artifact_passed: number;
  judge_unavailable_turns: number;
  cost_usd: number | string;
  failure_classes: Record<string, number> | null;
};

export type DimTally = { judged: number; passed: number };

export type QualityBucket = {
  key: string;
  weekStart: string;
  /** 该桶里最新一天，用户页用它挑「这个人当前那版 judge」。 */
  latestDay: string;
  appVersion: string | null;
  promptVersion: string | null;
  judgeVersion: string;
  sampledBy: 'signal' | 'sample';
  turns: number;
  judgeUnavailableTurns: number;
  costUsd: number;
  dims: Record<PostLaunchDimension, DimTally>;
  failureClasses: Record<string, number>;
};

function emptyDims(): Record<PostLaunchDimension, DimTally> {
  return {
    goal: { judged: 0, passed: 0 },
    orchestration: { judged: 0, passed: 0 },
    tools: { judged: 0, passed: 0 },
    permission: { judged: 0, passed: 0 },
    safety: { judged: 0, passed: 0 },
    artifact: { judged: 0, passed: 0 },
  };
}

/** 一次最多取这么多行；取满了就说明窗口没读全，页面要明说。 */
const ROW_LIMIT = 2000;

export type QualityFetch = {
  rows: QualityRow[];
  /** 命中上限：展示的是窗口的一部分，不是全部。页面必须把这件事说出来。 */
  truncated: boolean;
};

/**
 * 拉视图。`sinceDays` 之前的天不要（视图粒度是天，按 day_start 切）。
 * 可见性完全由底表 RLS 决定，页面不用自己判权。
 *
 * ponytail: 单次取 ROW_LIMIT + 1 行来探测截断，不做分页循环——服务端渲染里
 * 无上限地翻页是更糟的失败模式。真到了常态截断，把这里换成按 day_start 游标分页。
 * 关键是**不静默**：截断了就让页面挂出来，别把半个窗口当整个窗口给人看。
 */
export async function fetchQualityRows(
  supabase: SupabaseClient,
  sinceDays: number,
): Promise<QualityFetch> {
  const since = new Date(Date.now() - sinceDays * 24 * 60 * 60 * 1000).toISOString();
  const { data } = await supabase
    .from('admin_postlaunch_quality')
    .select('*')
    .gte('day_start', since)
    .order('day_start', { ascending: false })
    .limit(ROW_LIMIT + 1)
    .returns<QualityRow[]>();
  const rows = data ?? [];
  return { rows: rows.slice(0, ROW_LIMIT), truncated: rows.length > ROW_LIMIT };
}

function newBucket(key: string, row: QualityRow): QualityBucket {
  return {
    key,
    weekStart: row.week_start,
    latestDay: row.day_start,
    appVersion: row.app_version,
    promptVersion: row.prompt_version,
    judgeVersion: row.judge_version,
    sampledBy: row.sampled_by,
    turns: 0,
    judgeUnavailableTurns: 0,
    costUsd: 0,
    dims: emptyDims(),
    failureClasses: {},
  };
}

/**
 * 按周 × 版本 × judge 版本 × 采样来源卷起来（跨用户合并）。
 * 信号轮与抽样轮**不合并**；judge 版本也进 key——换了打分提示词，两版分数不可相比（ADR-063 §2）。
 */
export function rollupByWeek(rows: QualityRow[]): QualityBucket[] {
  const buckets = new Map<string, QualityBucket>();
  for (const row of rows) {
    const key = `${row.week_start}|${row.app_version ?? ''}|${row.prompt_version ?? ''}|${row.judge_version}|${row.sampled_by}`;
    let bucket = buckets.get(key);
    if (!bucket) {
      bucket = newBucket(key, row);
      buckets.set(key, bucket);
    }
    addRow(bucket, row);
  }
  return [...buckets.values()].sort(
    (a, b) =>
      b.weekStart.localeCompare(a.weekStart)
      || (a.appVersion ?? '').localeCompare(b.appVersion ?? '')
      || a.sampledBy.localeCompare(b.sampledBy),
  );
}

/**
 * 按 user_id 卷起来，用于用户页那一列。
 *
 * 一个人窗口内可能横跨两版 judge（升级那几天）。把两版加在一起会得出一个
 * 两把尺子量出来的过率，所以先挑出这个人**最近一天用的那版**，只卷那一版的行。
 */
export function rollupByUser(rows: QualityRow[]): Map<string, QualityBucket> {
  const latestJudge = new Map<string, { day: string; judgeVersion: string }>();
  for (const row of rows) {
    const seen = latestJudge.get(row.user_id);
    if (!seen || row.day_start > seen.day) {
      latestJudge.set(row.user_id, { day: row.day_start, judgeVersion: row.judge_version });
    }
  }

  const buckets = new Map<string, QualityBucket>();
  for (const row of rows) {
    if (row.judge_version !== latestJudge.get(row.user_id)?.judgeVersion) continue;
    let bucket = buckets.get(row.user_id);
    if (!bucket) {
      bucket = { ...newBucket(row.user_id, row), appVersion: null, promptVersion: null };
      buckets.set(row.user_id, bucket);
    }
    addRow(bucket, row);
  }
  return buckets;
}

function addRow(bucket: QualityBucket, row: QualityRow): void {
  bucket.turns += row.turns;
  bucket.judgeUnavailableTurns += row.judge_unavailable_turns;
  bucket.costUsd += Number(row.cost_usd ?? 0);
  for (const dimension of POST_LAUNCH_DIMENSIONS) {
    bucket.dims[dimension].judged += row[`${dimension}_judged`];
    bucket.dims[dimension].passed += row[`${dimension}_passed`];
  }
  for (const [code, count] of Object.entries(row.failure_classes ?? {})) {
    bucket.failureClasses[code] = (bucket.failureClasses[code] ?? 0) + count;
  }
}

/** 一个维度的过率。没有判决过（judged=0）返回 null——0% 和「没评过」是两回事。 */
export function passRate(tally: DimTally): number | null {
  return tally.judged > 0 ? tally.passed / tally.judged : null;
}

/** 六维合起来的总过率（所有维度的判决数与通过数各自求和），用户页那一列用。 */
export function overallPassRate(bucket: QualityBucket): number | null {
  let judged = 0;
  let passed = 0;
  for (const dimension of POST_LAUNCH_DIMENSIONS) {
    judged += bucket.dims[dimension].judged;
    passed += bucket.dims[dimension].passed;
  }
  return judged > 0 ? passed / judged : null;
}

export function formatRate(rate: number | null): string {
  return rate === null ? '—' : `${(rate * 100).toFixed(0)}%`;
}
