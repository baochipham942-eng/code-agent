// ============================================================================
// Telemetry — computer-surface 可靠性聚合（从 telemetryStorage.ts 拆出，零行为改动）
// 传入语句缓存依赖以保留 prepared-statement 复用行为。
// ============================================================================

import { createLogger } from '../services/infra/logger';
import type Database from 'better-sqlite3';
import type { ComputerSurfaceReliabilitySummary } from '../../shared/contract/telemetry';
import { emptyComputerSurfaceReliabilitySummary } from './telemetryStorageParsers';

const logger = createLogger('TelemetryReliability');

export interface ReliabilityQueryDeps {
  isDbAvailable: () => boolean;
  getStmt: (key: string, sql: string) => Database.Statement;
}

export function computeComputerSurfaceReliabilitySummary(deps: ReliabilityQueryDeps, sessionId: string): ComputerSurfaceReliabilitySummary {
  const emptySummary = emptyComputerSurfaceReliabilitySummary(sessionId);
  if (!deps.isDbAvailable()) return emptySummary;

  try {
    const totals = deps.getStmt(
      'computer_surface_reliability_totals',
      `
      SELECT
        COUNT(*) AS total_actions,
        SUM(CASE WHEN success = 1 THEN 1 ELSE 0 END) AS successful_actions,
        SUM(CASE WHEN success = 0 THEN 1 ELSE 0 END) AS failed_actions,
        SUM(CASE WHEN computer_surface_mode = 'foreground_fallback' THEN 1 ELSE 0 END) AS foreground_fallback_actions,
        SUM(CASE WHEN computer_surface_mode = 'background_ax' THEN 1 ELSE 0 END) AS background_ax_actions,
        SUM(CASE WHEN computer_surface_mode IN ('background_cgevent', 'background_cg_event') THEN 1 ELSE 0 END) AS background_cg_event_actions
      FROM telemetry_tool_calls
      WHERE session_id = ? AND name = 'computer_use'
    `
    ).get(sessionId) as Record<string, unknown> | undefined;

    const byFailureKindRows = deps.getStmt(
      'computer_surface_reliability_failure_kinds',
      `
      SELECT computer_surface_failure_kind AS failure_kind, COUNT(*) AS count
      FROM telemetry_tool_calls
      WHERE session_id = ?
        AND name = 'computer_use'
        AND success = 0
        AND computer_surface_failure_kind IS NOT NULL
        AND computer_surface_failure_kind != ''
      GROUP BY computer_surface_failure_kind
      ORDER BY count DESC, failure_kind ASC
    `
    ).all(sessionId) as Record<string, unknown>[];

    const byModeRows = deps.getStmt(
      'computer_surface_reliability_modes',
      `
      SELECT
        computer_surface_mode AS mode,
        COUNT(*) AS count,
        SUM(CASE WHEN success = 0 THEN 1 ELSE 0 END) AS failed
      FROM telemetry_tool_calls
      WHERE session_id = ?
        AND name = 'computer_use'
        AND computer_surface_mode IS NOT NULL
        AND computer_surface_mode != ''
      GROUP BY computer_surface_mode
      ORDER BY count DESC, mode ASC
    `
    ).all(sessionId) as Record<string, unknown>[];

    const recentFailureRows = deps.getStmt(
      'computer_surface_reliability_recent_failures',
      `
      SELECT
        tool_call_id,
        timestamp,
        name,
        computer_surface_failure_kind,
        computer_surface_mode,
        computer_surface_target_app,
        computer_surface_action,
        error
      FROM telemetry_tool_calls
      WHERE session_id = ? AND name = 'computer_use' AND success = 0
      ORDER BY timestamp DESC, idx DESC
      LIMIT 10
    `
    ).all(sessionId) as Record<string, unknown>[];

    return {
      sessionId,
      totalActions: Number(totals?.total_actions ?? 0),
      successfulActions: Number(totals?.successful_actions ?? 0),
      failedActions: Number(totals?.failed_actions ?? 0),
      foregroundFallbackActions: Number(totals?.foreground_fallback_actions ?? 0),
      backgroundAxActions: Number(totals?.background_ax_actions ?? 0),
      backgroundCgEventActions: Number(totals?.background_cg_event_actions ?? 0),
      byFailureKind: byFailureKindRows.map((row) => ({
        failureKind: row.failure_kind as string,
        count: Number(row.count ?? 0)
      })),
      byMode: byModeRows.map((row) => ({
        mode: row.mode as string,
        count: Number(row.count ?? 0),
        failed: Number(row.failed ?? 0)
      })),
      recentFailures: recentFailureRows.map((row) => ({
        toolCallId: row.tool_call_id as string,
        timestamp: Number(row.timestamp ?? 0),
        name: row.name as string,
        failureKind: (row.computer_surface_failure_kind as string | null) ?? null,
        mode: (row.computer_surface_mode as string | null) ?? null,
        targetApp: (row.computer_surface_target_app as string | null) ?? null,
        action: (row.computer_surface_action as string | null) ?? null,
        error: (row.error as string | null) ?? null
      }))
    };
  } catch (error) {
    logger.error('Failed to get computer surface reliability summary:', error);
    return emptySummary;
  }
}
