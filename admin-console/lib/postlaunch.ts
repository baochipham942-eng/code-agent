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
  /** 该桶里最新一条分数的 scored_at；挑「最近口径」用它排序，不靠 day_start + 返回顺序。 */
  last_scored_at: number | string;
  judge_unavailable_turns: number;
  cost_usd: number | string;
  failure_classes: Record<string, number> | null;
};

export type DimTally = { judged: number; passed: number };

/**
 * 口径 = judge 版本 + rubric 版本。契约允许只升 rubric（改评分口径不改提示词），
 * 所以 judge 相同**不代表**两批分数可比，两个都得进键（ADR-063 §2）。
 */
export type RubricKey = { judgeVersion: string; rubricVersion: string };

export function rubricKeyOf(row: QualityRow): RubricKey {
  return { judgeVersion: row.judge_version, rubricVersion: row.rubric_version };
}

export function formatRubricKey(key: RubricKey): string {
  return `${key.judgeVersion} · ${key.rubricVersion}`;
}

export type QualityBucket = {
  key: string;
  weekStart: string;
  /** 该桶里最新一条分数的 scored_at。 */
  lastScoredAt: number;
  appVersion: string | null;
  promptVersion: string | null;
  judgeVersion: string;
  rubricVersion: string;
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
    lastScoredAt: 0,
    appVersion: row.app_version,
    promptVersion: row.prompt_version,
    judgeVersion: row.judge_version,
    rubricVersion: row.rubric_version,
    sampledBy: row.sampled_by,
    turns: 0,
    judgeUnavailableTurns: 0,
    costUsd: 0,
    dims: emptyDims(),
    failureClasses: {},
  };
}

/**
 * 按周 × 版本 × 口径 × 采样来源卷起来（跨用户合并）。
 * 信号轮与抽样轮**不合并**；judge + rubric 一起进 key——换了提示词或口径，两批分数不可相比。
 */
export function rollupByWeek(rows: QualityRow[]): QualityBucket[] {
  const buckets = new Map<string, QualityBucket>();
  for (const row of rows) {
    const key = `${row.week_start}|${row.app_version ?? ''}|${row.prompt_version ?? ''}|${row.judge_version}|${row.rubric_version}|${row.sampled_by}`;
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
 * 挑「更新的那套口径」。**必须是确定的全序**，不能靠数组返回顺序：
 * 同一天可能同时躺着两版 rubric 的行，只比日期时两种返回顺序会给出两个答案。
 * 判据：`last_scored_at` 大者胜；完全相等时按 `judge|rubric` 串比较，大者胜。
 */
export function isNewerRubric(
  a: { lastScoredAt: number } & RubricKey,
  b: { lastScoredAt: number } & RubricKey,
): boolean {
  if (a.lastScoredAt !== b.lastScoredAt) return a.lastScoredAt > b.lastScoredAt;
  return `${a.judgeVersion}|${a.rubricVersion}` > `${b.judgeVersion}|${b.rubricVersion}`;
}

/** 一个用户在「当前口径」下的两行：信号轮与抽样轮分开，**不给合并值**（ADR-063 §4）。 */
export type UserQuality = {
  rubric: RubricKey;
  signal: QualityBucket | null;
  sample: QualityBucket | null;
};

/**
 * 按 user_id 卷起来，用于用户页那两列。
 *
 * 两条口径纪律都在这里：
 *   - 一个人窗口内可能横跨两套口径（升级那几天）。把两套加在一起 = 两把尺子量出来的过率，
 *     所以先挑出这个人**最近那套 (judge, rubric)**，只卷这一套的行。
 *   - 信号轮与抽样轮不合并：信号轮是命中问题信号才评的，天然偏低，
 *     和抽样轮加在一起得到的数字什么都不代表。
 */
export function rollupByUser(rows: QualityRow[]): Map<string, UserQuality> {
  const latest = new Map<string, { lastScoredAt: number } & RubricKey>();
  for (const row of rows) {
    const candidate = { lastScoredAt: Number(row.last_scored_at ?? 0), ...rubricKeyOf(row) };
    const seen = latest.get(row.user_id);
    if (!seen || isNewerRubric(candidate, seen)) latest.set(row.user_id, candidate);
  }

  const result = new Map<string, UserQuality>();
  for (const row of rows) {
    const current = latest.get(row.user_id);
    if (!current) continue;
    if (row.judge_version !== current.judgeVersion || row.rubric_version !== current.rubricVersion) continue;

    let entry = result.get(row.user_id);
    if (!entry) {
      entry = { rubric: { judgeVersion: current.judgeVersion, rubricVersion: current.rubricVersion }, signal: null, sample: null };
      result.set(row.user_id, entry);
    }
    if (!entry[row.sampled_by]) {
      entry[row.sampled_by] = { ...newBucket(`${row.user_id}|${row.sampled_by}`, row), appVersion: null, promptVersion: null };
    }
    addRow(entry[row.sampled_by] as QualityBucket, row);
  }
  return result;
}

function addRow(bucket: QualityBucket, row: QualityRow): void {
  bucket.lastScoredAt = Math.max(bucket.lastScoredAt, Number(row.last_scored_at ?? 0));
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
