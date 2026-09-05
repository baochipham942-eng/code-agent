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
  appVersion: string | null;
  promptVersion: string | null;
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

/**
 * 拉视图。`sinceDays` 之前的天不要（视图粒度是天，按 day_start 切）。
 * 视图是 security_invoker：非 admin 读到的是空集，页面不用自己判权。
 */
export async function fetchQualityRows(
  supabase: SupabaseClient,
  sinceDays: number,
): Promise<QualityRow[]> {
  const since = new Date(Date.now() - sinceDays * 24 * 60 * 60 * 1000).toISOString();
  const { data } = await supabase
    .from('admin_postlaunch_quality')
    .select('*')
    .gte('day_start', since)
    .order('day_start', { ascending: false })
    .limit(2000)
    .returns<QualityRow[]>();
  return data ?? [];
}

/** 按周 × 版本 × 采样来源卷起来（跨用户合并）。信号轮与抽样轮**不合并**：两行分开。 */
export function rollupByWeek(rows: QualityRow[]): QualityBucket[] {
  const buckets = new Map<string, QualityBucket>();
  for (const row of rows) {
    const key = `${row.week_start}|${row.app_version ?? ''}|${row.prompt_version ?? ''}|${row.sampled_by}`;
    let bucket = buckets.get(key);
    if (!bucket) {
      bucket = {
        key,
        weekStart: row.week_start,
        appVersion: row.app_version,
        promptVersion: row.prompt_version,
        sampledBy: row.sampled_by,
        turns: 0,
        judgeUnavailableTurns: 0,
        costUsd: 0,
        dims: emptyDims(),
        failureClasses: {},
      };
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

/** 按 user_id 卷起来，用于用户页那一列。 */
export function rollupByUser(rows: QualityRow[]): Map<string, QualityBucket> {
  const buckets = new Map<string, QualityBucket>();
  for (const row of rows) {
    let bucket = buckets.get(row.user_id);
    if (!bucket) {
      bucket = {
        key: row.user_id,
        weekStart: row.week_start,
        appVersion: null,
        promptVersion: null,
        sampledBy: row.sampled_by,
        turns: 0,
        judgeUnavailableTurns: 0,
        costUsd: 0,
        dims: emptyDims(),
        failureClasses: {},
      };
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
