// ============================================================================
// SwarmReconcileService（ADR-022 §四第四期 · 一致性兜底「后台对账扫描」）
//
// 把 3b 的单 run 影子对账（reconcileRun）升级为「批量扫描」：遍历一批 run，
// 逐个比对「从 ledger 重建的 rollup」vs「现存 rollup 缓存」，聚合成一份对账报告。
//
// 设计纪律：
//   - 纯只读：本模块零写入（偏差自愈/缓存重建是另一个默认 OFF 的写闸门，见步骤 4）。
//   - 注入式 reader：不直依赖 databaseService，便于单测与解耦。
//   - 单 run 错误隔离：某 run 读/算抛错只计入 errors，不中断整次扫描。
//   - 不静默截断：coverageNote 如实写明扫描范围与 limit。
//   - 正在运行的 run（半套账本、无 run_closed）跳过——对账只对已收尾的 run 有意义
//     （呼应 getSwarmRunDetailPreferLedger 的 HIGH-1 不变量：半套账本不当真理源）。
// ============================================================================

import { rebuildRunDetail } from './swarmRollupProjection';
import { reconcileRun, type ReconcileResult } from './swarmReconcile';
import type { SwarmLedgerEvent } from '../../../shared/contract/swarmLedger';
import type { SwarmRunDetail } from '../../../shared/contract/swarmTrace';

/** 默认扫描窗口上限（沿用 databaseService.listSwarmLedgerRunIds 的 200 惯例）。 */
const DEFAULT_SCAN_LIMIT = 200;

/** 注入式只读数据源（生产由 databaseService 适配；测试用 fake）。 */
export interface ReconcileScanReader {
  /** 有账记录的 run id 列表（可带窗口上限）。 */
  listRunIds(limit?: number): string[];
  /** 某 run 的 ledger 事件（按 seq 升序）。 */
  getLedgerByRun(runId: string): SwarmLedgerEvent[];
  /** 某 run 的现存 rollup 详情（无则 null）。 */
  getStoredRunDetail(runId: string): SwarmRunDetail | null;
}

export interface ReconcileScanOptions {
  /** 注入时间戳（禁裸 Date.now()）。 */
  now: number;
  /** 扫描窗口上限。 */
  limit?: number;
  /**
   * 偏差自愈写闸门（ADR-024）：**默认关**。开启后，对 drift 且已闭合（含 run_closed）的 run，
   * 用 ledger 确定性重建值覆盖 rollup 缓存。正在运行的半套账本永不重建（已被 in-progress 跳过）。
   */
  rebuildOnDrift?: boolean;
  /** 注入式重建写口（仅 rebuildOnDrift 开时调用；生产用 createDatabaseRebuildWriter）。 */
  rebuildWriter?: (runId: string, rebuilt: SwarmRunDetail) => void;
}

export interface ReconcileScanReport {
  generatedAt: number;
  scannedCount: number;
  matched: number;
  /** 已收尾且对不上的 run（真 drift）。 */
  drifted: ReconcileResult[];
  /** 跳过的 run + 原因（ledger-missing 老 run / in-progress 运行中 / rollup-missing 等）。 */
  skipped: { runId: string; note: string }[];
  /** 单 run 读/算异常（隔离，不中断扫描）。 */
  errors: { runId: string; error: string }[];
  /** 被重建缓存的 run id（仅写闸门开时非空）。 */
  rebuilt: string[];
  coverageNote: string;
}

/**
 * 批量对账扫描。纯只读、fail-safe、单 run 错误隔离。
 */
export function runReconcileScan(
  reader: ReconcileScanReader,
  options: ReconcileScanOptions,
): ReconcileScanReport {
  const limit = options.limit ?? DEFAULT_SCAN_LIMIT;
  const drifted: ReconcileResult[] = [];
  const skipped: { runId: string; note: string }[] = [];
  const errors: { runId: string; error: string }[] = [];
  const rebuiltIds: string[] = [];
  let matched = 0;

  let runIds: string[];
  try {
    runIds = reader.listRunIds(limit);
  } catch (e) {
    return {
      generatedAt: options.now,
      scannedCount: 0,
      matched: 0,
      drifted,
      skipped,
      errors: [{ runId: '*', error: String(e) }],
      rebuilt: rebuiltIds,
      coverageNote: 'listRunIds 失败，未扫描任何 run',
    };
  }

  for (const runId of runIds) {
    try {
      const ledger = reader.getLedgerByRun(runId);
      const rebuilt = rebuildRunDetail(ledger);
      // 半套账本（有 run_started、无 run_closed → status='running'）= 运行中，跳过。
      if (rebuilt?.run.status === 'running') {
        skipped.push({ runId, note: 'in-progress' });
        continue;
      }
      const stored = reader.getStoredRunDetail(runId);
      const result = reconcileRun(rebuilt, stored, runId);
      if (result.note) {
        skipped.push({ runId, note: result.note });
      } else if (result.match) {
        matched += 1;
      } else {
        drifted.push(result);
        // 偏差自愈写闸门（默认关）：drift 分支的 rebuilt 必非 null 且已闭合（reconcileRun 无 note）。
        if (options.rebuildOnDrift && options.rebuildWriter && rebuilt) {
          try {
            options.rebuildWriter(runId, rebuilt);
            rebuiltIds.push(runId);
          } catch (e) {
            errors.push({ runId, error: String(e) });
          }
        }
      }
    } catch (e) {
      errors.push({ runId, error: String(e) });
    }
  }

  const coverageNote = `扫描 ${runIds.length} 个 run（limit=${limit}）：匹配 ${matched}、偏差 ${drifted.length}、跳过 ${skipped.length}、错误 ${errors.length}、重建 ${rebuiltIds.length}`;

  return {
    generatedAt: options.now,
    scannedCount: runIds.length,
    matched,
    drifted,
    skipped,
    errors,
    rebuilt: rebuiltIds,
    coverageNote,
  };
}

/** 把对账报告渲染成可读摘要（并入 Dream 报告 → 落 cron_executions 作运行证据）。 */
export function formatReconcileScanReport(report: ReconcileScanReport): string {
  const lines: string[] = [`[Swarm 对账@${report.generatedAt}] ${report.coverageNote}`];
  if (report.drifted.length > 0) {
    lines.push('偏差：');
    for (const r of report.drifted) {
      const fields = r.drift
        .filter((d) => !d.tolerated)
        .map((d) => `${d.scope}/${d.field}(ledger=${String(d.rebuilt)} rollup=${String(d.stored)})`)
        .join('; ');
      lines.push(`  - ${r.runId}: ${fields}`);
    }
  }
  if (report.errors.length > 0) {
    lines.push('错误：');
    for (const e of report.errors) lines.push(`  - ${e.runId}: ${e.error}`);
  }
  return lines.join('\n');
}

/** 对账 reader 所需的 db 只读口（DatabaseService 结构上满足）。 */
export interface ReconcileReaderDb {
  listSwarmLedgerRunIds(sessionId?: string, limit?: number): string[];
  getSwarmLedgerByRun(runId: string): SwarmLedgerEvent[];
  getSwarmTraceRepo(): { getRunDetail(runId: string): SwarmRunDetail | null };
}

/**
 * 生产 reader：stored 取 **raw rollup**（swarmTraceRepo.getRunDetail），
 * 不走 getSwarmRunDetailPreferLedger —— 否则 stored 也由 ledger 重建，变成循环自证。
 */
export function createDatabaseReconcileReader(db: ReconcileReaderDb): ReconcileScanReader {
  return {
    listRunIds: (limit) => db.listSwarmLedgerRunIds(undefined, limit),
    getLedgerByRun: (runId) => db.getSwarmLedgerByRun(runId),
    getStoredRunDetail: (runId) => db.getSwarmTraceRepo().getRunDetail(runId),
  };
}

/** 重建写目标（SwarmTraceRepository 结构上满足）。 */
export interface ReconcileRebuildTarget {
  replaceRunCache(detail: SwarmRunDetail): void;
}

/**
 * 生产重建 writer：用 ledger 确定性重建值覆盖 rollup 缓存（仅写闸门 rebuildOnDrift 开时被调用）。
 */
export function createDatabaseRebuildWriter(
  target: ReconcileRebuildTarget,
): (runId: string, rebuilt: SwarmRunDetail) => void {
  return (_runId, rebuilt) => target.replaceRunCache(rebuilt);
}
