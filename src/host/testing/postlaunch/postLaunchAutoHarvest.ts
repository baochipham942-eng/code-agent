// ============================================================================
// 低分自动入候选（N-EVAL-FAILURE-AUTOHARVEST · 交付①）
// ----------------------------------------------------------------------------
// 边界（ADR-063 四道闸 + REFLOW 拍板口径）：本模块只动「候选入池上游」——按日扫
// 近 N 天会话，只跑确定性信号（computeTurnSignals，永不调 judge，零成本零正文外发），
// 信号命中 ⇒ 对应维判 0 的低分行落 telemetry_turn_scores，候选视图 listReflowCandidates
// 零改动自动带出。**不**自动建草稿：同意档 / 敏感闸 / HARDENGATE 一字不动，
// 草稿仍要人在 HARVEST 模态点选并逐条硬化。
//
// 全部外部依赖走 deps 注入（db / 开关 / 扫描执行 / 时钟），单测不碰真机。
// 真机接线与调度器在 postLaunchAutoHarvestRuntime.ts。
// ============================================================================
import type BetterSqlite3 from 'better-sqlite3';
import type { PostLaunchScoringResult } from '../../../shared/contract/postLaunchScore';
import { localDay } from './postLaunchScoreStore';

export interface PostLaunchAutoHarvestDeps {
  db: BetterSqlite3.Database;
  /** 开关门（privacy.postLaunchAutoHarvest，缺省关）。 */
  isEnabled: () => boolean;
  /** 执行一次 signalOnly 扫描（生产 = runPostLaunchScoring + { signalOnly: true }）。 */
  runScan: () => Promise<PostLaunchScoringResult>;
  now: () => number;
  onWarn?: (message: string, error?: unknown) => void;
}

export type PostLaunchAutoHarvestOutcome =
  | 'disabled'          // 开关关着（缺省即关）
  | 'already-scanned'   // 本日已扫过（节流）
  | 'locked'            // 与手评/另一次扫描撞锁，让给先手
  | 'scanned'
  | 'failed';

function ensureAutoHarvestTable(db: BetterSqlite3.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS postlaunch_autoharvest_state (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      last_scan_day TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    )
  `);
}

/** 本日是否已扫过（按本地日节流：启动检查 + 24h 滚动都可能同日重复触发）。模块内私有——外部只看 maybeRun 的 outcome。 */
function getLastAutoHarvestScanDay(db: BetterSqlite3.Database): string | null {
  ensureAutoHarvestTable(db);
  const row = db.prepare(`SELECT last_scan_day FROM postlaunch_autoharvest_state WHERE id = 1`).get() as
    | { last_scan_day: string }
    | undefined;
  return row?.last_scan_day ?? null;
}

/** 落本次扫描的本地日；updated_at 支持可选时间戳（云端同步口径，缺省才 Date.now()）。 */
function markAutoHarvestScanned(db: BetterSqlite3.Database, day: string, scannedAt?: number): void {
  ensureAutoHarvestTable(db);
  db.prepare(
    `INSERT INTO postlaunch_autoharvest_state (id, last_scan_day, updated_at) VALUES (1, ?, ?)
     ON CONFLICT(id) DO UPDATE SET last_scan_day = excluded.last_scan_day, updated_at = excluded.updated_at`,
  ).run(day, scannedAt ?? Date.now());
}

/**
 * 到点就扫一次。每个跳过分支都给可区分的原因（错题本 2026-08-14：降级不许静默）；
 * 扫描自身抛错不扩散成宿主启动/定时器故障——记 failed 并 warn。
 */
export async function maybeRunPostLaunchAutoHarvest(
  deps: PostLaunchAutoHarvestDeps,
): Promise<PostLaunchAutoHarvestOutcome> {
  if (!deps.isEnabled()) {
    deps.onWarn?.('低分自动入候选没开（privacy.postLaunchAutoHarvest 缺省关），跳过本次扫描');
    return 'disabled';
  }
  const day = localDay(deps.now());
  if (getLastAutoHarvestScanDay(deps.db) === day) {
    return 'already-scanned';
  }
  try {
    const result = await deps.runScan();
    if (result.locked) {
      deps.onWarn?.('低分自动入候选扫描与另一次评分撞锁，本次让给先手');
      return 'locked';
    }
    markAutoHarvestScanned(deps.db, day, deps.now());
    return 'scanned';
  } catch (error) {
    deps.onWarn?.('低分自动入候选扫描失败', error);
    return 'failed';
  }
}
