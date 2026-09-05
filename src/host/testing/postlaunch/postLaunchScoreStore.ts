// ============================================================================
// 上线后分数本地表（ADR-063 §1 · N-EVAL-POSTLAUNCH-K1）
// ----------------------------------------------------------------------------
// 表定义在 schemaTelemetry.ts 的 telemetry_turn_scores，与遥测五表同库同事务。
// 本模块全部函数把 db 作为第一个入参——单测拿自己的 :memory: 库，永远不碰用户
// 真实数据目录（09-05 刚出过单测把夹具写穿到真机的事故）。
// 表里只有分数、维度、失败类别、一行脱敏理由和信号名，没有 prompt / 回复 / 工具入参。
// ============================================================================
import type BetterSqlite3 from 'better-sqlite3';
import {
  POST_LAUNCH_DEFAULTS,
  POST_LAUNCH_DIMENSIONS,
  POST_LAUNCH_JUDGE_VERSION,
  POST_LAUNCH_RUBRIC_VERSION,
  JUDGE_MODEL_UNAVAILABLE,
  isPostLaunchScorableSession,
  type PostLaunchBudgetState,
  type PostLaunchDimension,
  type PostLaunchDimRate,
  type PostLaunchReport,
  type PostLaunchReportGroup,
  type PostLaunchScopeRow,
  type PostLaunchSignalKind,
  type PostLaunchTurnScore,
} from '../../../shared/contract/postLaunchScore';

/** 本地日历日（不是 UTC）：日预算按用户看到的「今天」切。 */
export function localDay(timestamp: number): string {
  const date = new Date(timestamp);
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${date.getFullYear()}-${month}-${day}`;
}

/** 所在自然周的周一（本地时区）。 */
function weekStart(timestamp: number): string {
  const date = new Date(timestamp);
  date.setHours(0, 0, 0, 0);
  const weekday = (date.getDay() + 6) % 7; // 周一 = 0
  date.setDate(date.getDate() - weekday);
  return localDay(date.getTime());
}

export function insertTurnScore(db: BetterSqlite3.Database, score: PostLaunchTurnScore, turnStartedAt: number): void {
  db.prepare(`
    INSERT OR REPLACE INTO telemetry_turn_scores (
      turn_id, session_id, scored_at, scored_day, turn_started_at,
      app_version, prompt_version, judge_version, rubric_version, judge_model, prompt_hash,
      dim_goal, dim_orchestration, dim_tools, dim_permission, dim_safety, dim_artifact,
      failure_class, reason_redacted, redacted, signals, cost_usd, budget_cost_usd, sampled_by
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    score.turnId,
    score.sessionId,
    score.scoredAt,
    score.scoredDay,
    turnStartedAt,
    score.appVersion,
    score.promptVersion,
    score.judgeVersion,
    score.rubricVersion,
    score.judgeModel,
    score.promptHash,
    score.dims.goal,
    score.dims.orchestration,
    score.dims.tools,
    score.dims.permission,
    score.dims.safety,
    score.dims.artifact,
    score.failureClass,
    score.reasonRedacted,
    score.redacted ? 1 : 0,
    JSON.stringify(score.signals),
    score.costUsd,
    score.budgetCostUsd,
    score.sampledBy,
  );
}

export function getScoredTurnIds(db: BetterSqlite3.Database, turnIds: string[], judgeVersions: string[] = [POST_LAUNCH_JUDGE_VERSION]): Set<string> {
  if (turnIds.length === 0 || judgeVersions.length === 0) return new Set();
  const placeholders = turnIds.map(() => '?').join(', ');
  const versionPlaceholders = judgeVersions.map(() => '?').join(', ');
  const rows = db
    .prepare(`SELECT turn_id FROM telemetry_turn_scores WHERE judge_version IN (${versionPlaceholders}) AND turn_id IN (${placeholders})`)
    .all(...judgeVersions, ...turnIds) as Array<{ turn_id: string }>;
  return new Set(rows.map((row) => row.turn_id));
}

// ----------------------------------------------------------------------------
// 评分互斥锁：CLI 与应用内按钮可能同时对同一个库跑评分，两边都会读到同一份预算与未评轮，
// 各自调 judge 各自扣费（ai-review #1645 Important）。锁落在库里而不是进程里，跨进程有效。
// ----------------------------------------------------------------------------
const SCORING_LOCK_STALE_MS = 30 * 60 * 1000;

function ensureScoringLockTable(db: BetterSqlite3.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS telemetry_turn_scores_lock (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      owner TEXT NOT NULL,
      acquired_at INTEGER NOT NULL
    )
  `);
}

/** 拿到锁返回 true；别人持有且未过期返回 false。过期（持有者崩了没释放）视为无主，直接接管。 */
export function acquireScoringLock(db: BetterSqlite3.Database, owner: string, now: number, staleMs: number = SCORING_LOCK_STALE_MS): boolean {
  ensureScoringLockTable(db);
  return db.transaction(() => {
    const current = db.prepare('SELECT owner, acquired_at FROM telemetry_turn_scores_lock WHERE id = 1').get() as
      | { owner: string; acquired_at: number }
      | undefined;
    if (current && current.owner !== owner && now - current.acquired_at < staleMs) return false;
    db.prepare('INSERT OR REPLACE INTO telemetry_turn_scores_lock (id, owner, acquired_at) VALUES (1, ?, ?)').run(owner, now);
    return true;
  })();
}

/** 续租：评分是长任务，每处理完一个会话把 acquired_at 推到现在；返回 false 表示锁已被别人接管，持有者必须停。 */
export function renewScoringLock(db: BetterSqlite3.Database, owner: string, now: number): boolean {
  ensureScoringLockTable(db);
  const info = db.prepare('UPDATE telemetry_turn_scores_lock SET acquired_at = ? WHERE id = 1 AND owner = ?').run(now, owner);
  return info.changes > 0;
}

export function releaseScoringLock(db: BetterSqlite3.Database, owner: string): void {
  ensureScoringLockTable(db);
  db.prepare('DELETE FROM telemetry_turn_scores_lock WHERE id = 1 AND owner = ?').run(owner);
}

/** 日预算看的是 budget_cost_usd（含未知价的保守估算），不是展示用的刊例 cost_usd。 */
export function getBudgetState(
  db: BetterSqlite3.Database,
  day: string,
  limits: { limitUsd: number; sampleLimit: number },
): PostLaunchBudgetState {
  const row = db
    .prepare(`
      SELECT COALESCE(SUM(budget_cost_usd), 0) AS spent,
             COALESCE(SUM(budget_cost_usd - cost_usd), 0) AS assumed,
             COALESCE(SUM(CASE WHEN sampled_by = 'sample' THEN 1 ELSE 0 END), 0) AS sampled
      FROM telemetry_turn_scores WHERE scored_day = ? AND judge_version = ?
    `)
    .get(day, POST_LAUNCH_JUDGE_VERSION) as { spent: number; assumed: number; sampled: number };
  return {
    day,
    spentUsd: row.spent,
    limitUsd: limits.limitUsd,
    sampledCount: row.sampled,
    sampleLimit: limits.sampleLimit,
    assumedUsd: row.assumed,
    stopped: row.spent >= limits.limitUsd,
  };
}

interface ScoreRow {
  turn_id: string;
  session_id: string;
  turn_started_at: number;
  app_version: string | null;
  prompt_version: string | null;
  dim_goal: number | null;
  dim_orchestration: number | null;
  dim_tools: number | null;
  dim_permission: number | null;
  dim_safety: number | null;
  dim_artifact: number | null;
  failure_class: string | null;
  signals: string;
  cost_usd: number;
  judge_model: string | null;
  sampled_by: 'signal' | 'sample';
  /** 关联会话的来源，用来在报告侧复用同一套分母判定（LEFT JOIN，会话被删了就是 null）。 */
  session_type: string | null;
  origin_kind: string | null;
}

const DIM_COLUMN: Record<PostLaunchDimension, keyof ScoreRow> = {
  goal: 'dim_goal',
  orchestration: 'dim_orchestration',
  tools: 'dim_tools',
  permission: 'dim_permission',
  safety: 'dim_safety',
  artifact: 'dim_artifact',
};

function emptyDimRates(): Record<PostLaunchDimension, PostLaunchDimRate> {
  return Object.fromEntries(
    POST_LAUNCH_DIMENSIONS.map((dimension) => [dimension, { judged: 0, passed: 0 }]),
  ) as Record<PostLaunchDimension, PostLaunchDimRate>;
}

function accumulate(row: PostLaunchScopeRow, score: ScoreRow): void {
  row.turns += 1;
  for (const dimension of POST_LAUNCH_DIMENSIONS) {
    const value = score[DIM_COLUMN[dimension]] as number | null;
    if (value === null || value === undefined) continue; // null 不进分母
    row.dims[dimension].judged += 1;
    if (value === 1) row.dims[dimension].passed += 1;
  }
}

function parseSignals(raw: string): PostLaunchSignalKind[] {
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as PostLaunchSignalKind[]) : [];
  } catch {
    return [];
  }
}

export interface PostLaunchReportOptions {
  /** 报告读哪个版本的分数行；dry-run 写的是 'dry-run' 版本，不与真评混 */
  judgeVersion?: string;
  days?: number;
  now?: number;
  dailyBudgetUsd?: number;
  dailySampleLimit?: number;
  calibration?: PostLaunchReport['calibration'];
}

/**
 * 本机上线后报告：周 × app 版本分组，信号轮 / 抽样轮两行不合并。
 * 与本地表读的是同一批行（同一数据只有这一条路径），卡片不另算。
 *
 * 分母判定复用 `isPostLaunchScorableSession`——与打分器同一个函数、同一套口径。
 * 光在打分时剔不够：K2 之前落的探针分数行（`cli_session_*`）已经在表里，
 * 只在写入侧把关，读出来的报告照样被它们污染（ai-review PR #1650 第 2 轮②）。
 * **成本不过滤**：那些轮的钱是真花出去的，从账上抹掉才是假数。
 */
export function buildPostLaunchReport(
  db: BetterSqlite3.Database,
  options: PostLaunchReportOptions = {},
): PostLaunchReport {
  const now = options.now ?? Date.now();
  const days = options.days ?? POST_LAUNCH_DEFAULTS.days;
  const since = now - days * 24 * 60 * 60 * 1000;
  const judgeVersion = options.judgeVersion ?? POST_LAUNCH_JUDGE_VERSION;
  const rows = db
    .prepare(`
      SELECT s.turn_id, s.session_id, s.turn_started_at, s.app_version, s.prompt_version,
             s.dim_goal, s.dim_orchestration, s.dim_tools, s.dim_permission, s.dim_safety, s.dim_artifact,
             s.failure_class, s.signals, s.cost_usd, s.judge_model, s.sampled_by,
             sessions.session_type, sessions.origin_kind
      FROM telemetry_turn_scores AS s
      LEFT JOIN telemetry_sessions AS sessions ON sessions.id = s.session_id
      WHERE s.judge_version = ? AND s.turn_started_at >= ?
      ORDER BY s.turn_started_at DESC
    `)
    .all(judgeVersion, since) as ScoreRow[];

  const groups = new Map<string, PostLaunchReportGroup & {
    failureTally: Map<string, number>;
    signalTally: Map<PostLaunchSignalKind, number>;
    sessionSet: Set<string>;
  }>();

  let scorableTurns = 0;
  let judgeUnavailableTurns = 0;
  for (const row of rows) {
    const scorable = isPostLaunchScorableSession({
      id: row.session_id,
      sessionType: row.session_type,
      originKind: row.origin_kind,
    });
    const week = weekStart(row.turn_started_at);
    const appVersion = row.app_version ?? 'unknown';
    const key = `${week}|${appVersion}|${row.prompt_version ?? ''}`;
    let group = groups.get(key);
    if (!group) {
      group = {
        weekStart: week,
        appVersion,
        promptVersion: row.prompt_version,
        rows: [
          { scope: 'signal', turns: 0, dims: emptyDimRates() },
          { scope: 'sample', turns: 0, dims: emptyDimRates() },
        ],
        failureClasses: [],
        signals: [],
        costUsd: 0,
        sessionIds: [],
        failureTally: new Map(),
        signalTally: new Map(),
        sessionSet: new Set(),
      };
      groups.set(key, group);
    }
    // 成本先记：不进分母的轮也真花了钱，账上不能抹。
    group.costUsd += row.cost_usd;
    if (!scorable) continue;
    scorableTurns += 1;
    if (row.judge_model === JUDGE_MODEL_UNAVAILABLE) judgeUnavailableTurns += 1;
    // rows 固定两行：[0] 信号轮、[1] 抽样轮（建组时就是这个顺序）。
    accumulate(group.rows[row.sampled_by === 'signal' ? 0 : 1], row);
    group.sessionSet.add(row.session_id);
    if (row.failure_class) {
      group.failureTally.set(row.failure_class, (group.failureTally.get(row.failure_class) ?? 0) + 1);
    }
    for (const signal of parseSignals(row.signals)) {
      group.signalTally.set(signal, (group.signalTally.get(signal) ?? 0) + 1);
    }
  }

  const reportGroups: PostLaunchReportGroup[] = [...groups.values()]
    .map((group) => ({
      weekStart: group.weekStart,
      appVersion: group.appVersion,
      promptVersion: group.promptVersion,
      rows: group.rows,
      failureClasses: [...group.failureTally.entries()]
        .map(([code, count]) => ({ code, count }))
        .sort((left, right) => right.count - left.count),
      signals: [...group.signalTally.entries()]
        .map(([kind, count]) => ({ kind, count }))
        .sort((left, right) => right.count - left.count),
      costUsd: group.costUsd,
      sessionIds: [...group.sessionSet],
    }))
    .sort((left, right) => right.weekStart.localeCompare(left.weekStart));

  return {
    generatedAt: now,
    days,
    judgeVersion,
    rubricVersion: POST_LAUNCH_RUBRIC_VERSION,
    scoredTurns: scorableTurns,
    groups: reportGroups,
    judgeUnavailableTurns,
    calibration: options.calibration ?? { state: 'insufficient', reason: 'no_record' },
    budget: getBudgetState(db, localDay(now), {
      limitUsd: options.dailyBudgetUsd ?? POST_LAUNCH_DEFAULTS.dailyBudgetUsd,
      sampleLimit: options.dailySampleLimit ?? POST_LAUNCH_DEFAULTS.dailySampleLimit,
    }),
  };
}
