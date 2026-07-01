import type Database from 'better-sqlite3';
import { TELEMETRY_RETENTION } from '../../shared/constants';

/**
 * 删除超过 TELEMETRY_RETENTION.MAX_AGE_MS 的 granular 明细行:
 * events/model_calls/tool_calls 按 timestamp,diagnostic_bundles/prompt_cache 按 created_at。
 * 刻意不动 telemetry_sessions/telemetry_turns(每会话/每轮一行的轻量分析主干,存预聚合
 * token/cost,删了会破坏历史用量分析)。raw_payloads 由 pruneRawPayloads 单独管。
 * 单一事务,幂等。
 */
export function deleteAgedTelemetryRows(db: Database.Database, now: number): void {
  const cutoff = now - TELEMETRY_RETENTION.MAX_AGE_MS;
  db.transaction(() => {
    db.prepare('DELETE FROM telemetry_events WHERE timestamp < ?').run(cutoff);
    db.prepare('DELETE FROM telemetry_model_calls WHERE timestamp < ?').run(cutoff);
    db.prepare('DELETE FROM telemetry_tool_calls WHERE timestamp < ?').run(cutoff);
    db.prepare('DELETE FROM telemetry_diagnostic_bundles WHERE created_at < ?').run(cutoff);
    db.prepare('DELETE FROM system_prompt_cache WHERE created_at < ?').run(cutoff);
  })();
}
