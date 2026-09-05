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
  DRY_RUN_JUDGE_VERSION,
  POST_LAUNCH_RUBRIC_VERSION,
  JUDGE_MODEL_UNAVAILABLE,
  isPostLaunchScorableSession,
  type PostLaunchBudgetState,
  type PostLaunchDimension,
  type PostLaunchDimRate,
  type PostLaunchReport,
  type PostLaunchReportGroup,
  type PostLaunchReportSession,
  type PostLaunchScopeRow,
  type PostLaunchSignalKind,
  type PostLaunchTurnScore,
} from '../../../shared/contract/postLaunchScore';
import type { TelemetryTurnScoreRecord } from '../../../shared/contract/telemetry';
import { guardTelemetryText } from '../../telemetry/telemetryStorageParsers';
import { guardSensitiveText } from '../../security/sensitiveDataGuard';

/**
 * 一行理由过脱敏闸：命中即置空并标 redacted（ADR-063 §1）。
 * 不做「脱敏后照发」——理由是给人看的一句话，掩码后的残句既没信息又让人以为看到了全部。
 *
 * 打分器写库前调一次，上传器把这一行发出机器前**再调一次**（K3 双保险）。
 * 两处必须是同一个函数：一旦脱敏口径分叉，本机看着干净、云端存的却是另一套判断的结果。
 */
export function redactPostLaunchReason(reason: string): { text: string; redacted: boolean } {
  const trimmed = reason.trim().slice(0, POST_LAUNCH_DEFAULTS.reasonMaxChars);
  if (!trimmed) return { text: '', redacted: false };
  const guarded = guardSensitiveText(trimmed, {
    surface: 'export',
    mode: 'share',
    maxLength: trimmed.length + 1,
  });
  return guarded === trimmed ? { text: trimmed, redacted: false } : { text: '', redacted: true };
}

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

/**
 * 取尚未回传云端的分数行（ADR-063 §6.3）。查询留在本模块——telemetry_turn_scores 的
 * 每一条 SQL 都在这里，上传器不自己拼；telemetryStorage.ts 已经顶到 god-file 上限（999/1000
 * 有效行），往那儿加等于逼下一个人去拆它。
 *
 * 四道门，缺一条就会拖挂整批：
 *   - `userId` 归属：一台机器换过账号时，A 留下的待传行会跟 B 的行同批 upsert，
 *     云端 `owns_telemetry_session` 直接拒整条语句，B 自己的合法行跟着挂，而且下轮
 *     重试恒命中同一批——归属判据抄 `getUnsyncedFeedback` 那条（会话表为准，回落 sessions 表），
 *     且必须在 LIMIT **之前**过滤，否则一批全被别人的行占满。
 *   - `s.synced_at IS NOT NULL`：会话没上过云，分数行上去必挂外键，白 burn 一次重试。
 *   - `session_type <> 'eval'`：eval 会话在上传器里是**本地标记已同步但从不上传**的
 *     （upload() 的 excludedEvalSessions），synced_at 也非空，光看它会被骗。
 *   - `judge_version <> 'dry-run'`：CLI --dry-run 的演练行没真叫过打分模型，
 *     本机正式报告按 judge 版本筛掉它，云端不该收。
 *
 * SELECT 列表就是允许出机器的那一份（TelemetryTurnScoreRecord）：本机去重键 prompt_hash
 * 与本地预算账 budget_cost_usd 压根不读出来，上传器也就无从传起。
 */
export function getUnsyncedTurnScores(
  db: BetterSqlite3.Database,
  userId: string,
  limit = 200,
): TelemetryTurnScoreRecord[] {
  const rows = db
    .prepare(`
      SELECT sc.turn_id, sc.session_id, sc.scored_at, sc.scored_day, sc.turn_started_at,
             sc.app_version, sc.prompt_version, sc.judge_version, sc.rubric_version, sc.judge_model,
             sc.dim_goal, sc.dim_orchestration, sc.dim_tools,
             sc.dim_permission, sc.dim_safety, sc.dim_artifact,
             sc.failure_class, sc.reason_redacted, sc.redacted, sc.signals,
             sc.cost_usd, sc.sampled_by
      FROM telemetry_turn_scores AS sc
      JOIN telemetry_sessions AS s ON s.id = sc.session_id
      LEFT JOIN sessions AS chat ON chat.id = sc.session_id
      WHERE sc.synced_at IS NULL
        AND sc.judge_version <> ?
        AND s.synced_at IS NOT NULL
        AND (s.session_type IS NULL OR s.session_type <> 'eval')
        AND COALESCE(s.user_id, chat.user_id) = ?
      ORDER BY sc.scored_at ASC
      LIMIT ?
    `)
    .all(DRY_RUN_JUDGE_VERSION, userId, limit) as Array<Record<string, unknown>>;
  return rows.map((r) => ({
    turnId: r.turn_id as string,
    sessionId: r.session_id as string,
    scoredAt: r.scored_at as number,
    scoredDay: r.scored_day as string,
    turnStartedAt: r.turn_started_at as number,
    appVersion: (r.app_version as string | null) ?? null,
    promptVersion: (r.prompt_version as string | null) ?? null,
    judgeVersion: r.judge_version as string,
    rubricVersion: r.rubric_version as string,
    judgeModel: (r.judge_model as string | null) ?? null,
    dimGoal: (r.dim_goal as number | null) ?? null,
    dimOrchestration: (r.dim_orchestration as number | null) ?? null,
    dimTools: (r.dim_tools as number | null) ?? null,
    dimPermission: (r.dim_permission as number | null) ?? null,
    dimSafety: (r.dim_safety as number | null) ?? null,
    dimArtifact: (r.dim_artifact as number | null) ?? null,
    failureClass: (r.failure_class as string | null) ?? null,
    reasonRedacted: (r.reason_redacted as string | null) ?? '',
    redacted: r.redacted === 1,
    signals: (r.signals as string | null) ?? '[]',
    costUsd: (r.cost_usd as number | null) ?? 0,
    sampledBy: r.sampled_by as 'signal' | 'sample',
  }));
}

/**
 * 标记一批分数行已回传。
 *
 * 匹配 turn_id **加 scored_at**，不是只认 turn_id：上传在飞的时候这一轮可能被重新评分
 * （insertTurnScore 走 INSERT OR REPLACE，整行换掉、scored_at 变新、synced_at 归 NULL）。
 * 只按 turn_id 回标，会把这条**还没上传过的新行**标成已同步，云端从此永远停在旧判决上。
 * 带上快照里的 scored_at，被替换掉的那一行就匹配不上，老老实实留在待传队列里。
 */
export function markTurnScoresSynced(
  db: BetterSqlite3.Database,
  uploaded: ReadonlyArray<{ turnId: string; scoredAt: number }>,
  syncedAt: number = Date.now(),
): void {
  if (uploaded.length === 0) return;
  const stmt = db.prepare('UPDATE telemetry_turn_scores SET synced_at = ? WHERE turn_id = ? AND scored_at = ?');
  db.transaction(() => {
    for (const row of uploaded) stmt.run(syncedAt, row.turnId, row.scoredAt);
  })();
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

/**
 * 日预算看的是 budget_cost_usd（含未知价的保守估算），不是展示用的刊例 cost_usd。
 * `reserveUsd` = 下一次 judge 调用的最低估算：停评判据与打分器一致，是
 * 「已花 + 下一次要花的 ≥ 上限」而不是「已花 ≥ 上限」，否则预留导致的停评
 * 卡片上根本显示不出来（ai-review PR #1650 第 3 轮 Nit②）。
 */
export function getBudgetState(
  db: BetterSqlite3.Database,
  day: string,
  limits: { limitUsd: number; sampleLimit: number; reserveUsd?: number },
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
    stopped: row.spent + (limits.reserveUsd ?? 0) >= limits.limitUsd,
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
  /** 芯片上给人看的名字与时间；同样是 LEFT JOIN，会话被删了就是 null。 */
  session_title: string | null;
  session_start_time: number | null;
  /** sessions.title——模型自动起的真标题。遥测那份是开会话那刻的占位快照，之后不回写。 */
  chat_title: string | null;
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
  /** 下一次 judge 调用的最低估算，用来算「预留不足已停评」。 */
  reserveUsd?: number;
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
/**
 * 芯片标题：优先 sessions.title（模型自动起的真标题），回落 telemetry_sessions.title
 * （开会话那一刻的占位快照 "CLI Session" / "New Session"——之后模型改标题只写 sessions，
 * 遥测表不回写，副本 846 条里 567 条两表不一致）。都空则给空串，展示侧回落 id 前 8 位。
 *
 * sessions.title 是**裸存**的（SessionRepository.createSession 直接 stmt.run(session.title)，
 * updateSession 也是 COALESCE(?, title)，两条路径都不脱敏），而 telemetry_sessions.title
 * 写入时过了 guardTelemetryText。所以这里对 sessions.title 补同一道 guard，
 * 让两个来源在同一条口径上出报告。
 *
 * ponytail: 用 guard 的输出而不是「命中就丢弃」——掩码后的串本来就是可展示的
 * （遥测那列存的就是掩码结果），而丢弃会让「标题里带了个路径」的会话退回 "CLI Session"，
 * 正好是本刀要修的病。要改成命中即丢，改这一个函数即可。
 */
function sessionTitle(row: Pick<ScoreRow, 'session_title' | 'chat_title'>): string {
  const live = guardTelemetryText(row.chat_title, 2_000)?.trim();
  return live || row.session_title?.trim() || '';
}

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
             sessions.session_type, sessions.origin_kind,
             sessions.title AS session_title, sessions.start_time AS session_start_time,
             chat.title AS chat_title
      FROM telemetry_turn_scores AS s
      LEFT JOIN telemetry_sessions AS sessions ON sessions.id = s.session_id
      LEFT JOIN sessions AS chat ON chat.id = s.session_id
      WHERE s.judge_version = ? AND s.turn_started_at >= ?
      ORDER BY s.turn_started_at DESC
    `)
    .all(judgeVersion, since) as ScoreRow[];

  const groups = new Map<string, PostLaunchReportGroup & {
    failureTally: Map<string, number>;
    signalTally: Map<PostLaunchSignalKind, number>;
    sessionMap: Map<string, PostLaunchReportSession>;
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
        sessions: [],
        failureTally: new Map(),
        signalTally: new Map(),
        sessionMap: new Map(),
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
    if (!group.sessionMap.has(row.session_id)) {
      group.sessionMap.set(row.session_id, {
        id: row.session_id,
        title: sessionTitle(row),
        startedAt: row.session_start_time ?? 0,
      });
    }
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
      sessions: [...group.sessionMap.values()],
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
      reserveUsd: options.reserveUsd,
    }),
  };
}
