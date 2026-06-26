// ============================================================================
// Telemetry Storage - SQLite 持久化层
// ============================================================================

import { randomUUID } from 'crypto';
import { getDatabase } from '../services/core/databaseService';
import { createLogger } from '../services/infra/logger';
import type { TelemetrySession, TelemetryTurn, TelemetryModelCall, TelemetryToolCall, TelemetryTimelineEvent, TelemetrySessionListItem, TelemetryToolStat, TelemetryIntentStat, ComputerSurfaceReliabilitySummary, TelemetrySessionListOptions, TelemetryCostBucket, TelemetryCostByPeriodOptions, TelemetryFeedback, TelemetryFeedbackSubmitRequest, TelemetryRendererBundleAttempt, TelemetryDiagnosticBundleRecord } from '../../shared/contract/telemetry';
import { TELEMETRY_TRUNCATION, TELEMETRY_RAW } from '../../shared/constants';
import type Database from 'better-sqlite3';
import type { RendererBundleStatus } from '../../shared/contract/update';
import {
  parseTelemetryJson,
  parseTelemetryTimestamp,
  guardTelemetryText,
  prepareRawPayload,
  guardTelemetryJsonText,
  stringifyGuardedTelemetry,
  rowToSession,
  rowToTurn,
  rowToModelCall,
  rowToToolCall,
  rowToFeedback,
  rowToRendererBundleAttempt,
  rowToEvent,
} from './telemetryStorageParsers';
// prepareRawPayload 历史上是 telemetryStorage 的公开导出，保持向后兼容。
export { prepareRawPayload } from './telemetryStorageParsers';
import { computeComputerSurfaceReliabilitySummary } from './telemetryReliability';

const logger = createLogger('TelemetryStorage');
export class TelemetryStorage {
  private static instance: TelemetryStorage | null = null;
  private stmtCache = new Map<string, Database.Statement>();
  private dbUnavailable = false; // 标记 DB 不可用，避免重复报错

  static getInstance(): TelemetryStorage {
    if (!this.instance) {
      this.instance = new TelemetryStorage();
    }
    return this.instance;
  }

  private getDb(): Database.Database {
    const db = getDatabase().getDb();
    if (!db) throw new Error('Database not initialized');
    return db;
  }

  private getStmt(key: string, sql: string): Database.Statement {
    let stmt = this.stmtCache.get(key);
    if (!stmt) {
      stmt = this.getDb().prepare(sql);
      this.stmtCache.set(key, stmt);
    }
    return stmt;
  }

  /** CLI 模式下 DB 可能不可用，静默跳过存储 */
  private isDbAvailable(): boolean {
    if (this.dbUnavailable) return false;
    try {
      const dbService = getDatabase();
      if (!dbService.isReady) {
        // 不设 dbUnavailable，DB 可能正在初始化中，下次再试
        return false;
      }
      const db = dbService.getDb();
      if (!db) {
        this.dbUnavailable = true;
        logger.debug('TelemetryStorage: DB not available, telemetry will be in-memory only');
        return false;
      }
      return true;
    } catch {
      this.dbUnavailable = true;
      logger.debug('TelemetryStorage: DB not available, telemetry will be in-memory only');
      return false;
    }
  }

  // --------------------------------------------------------------------------
  // Session CRUD
  // --------------------------------------------------------------------------

  insertSession(session: TelemetrySession): void {
    if (!this.isDbAvailable()) return;
    try {
      const stmt = this.getStmt(
        'insert_session',
        `
          INSERT OR REPLACE INTO telemetry_sessions (
            id, user_id, title, model_provider, model_name,
            working_directory, start_time, end_time, duration_ms,
            turn_count, total_input_tokens, total_output_tokens, total_tokens,
            estimated_cost, total_tool_calls, tool_success_rate,
            total_errors, session_type, status,
            agent_version, prompt_version, tool_schema_version
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `
      );
      stmt.run(session.id, session.userId ?? null, guardTelemetryText(session.title, 2_000), session.modelProvider, session.modelName, guardTelemetryText(session.workingDirectory, 4_000), session.startTime, session.endTime ?? null, session.durationMs ?? null, session.turnCount, session.totalInputTokens, session.totalOutputTokens, session.totalTokens, session.estimatedCost, session.totalToolCalls, session.toolSuccessRate, session.totalErrors, session.sessionType ?? null, session.status, session.agentVersion ?? null, session.promptVersion ?? null, session.toolSchemaVersion ?? null);
    } catch (error) {
      logger.error('Failed to insert telemetry session:', error);
    }
  }

  updateSession(sessionId: string, updates: Partial<TelemetrySession>): void {
    if (!this.isDbAvailable()) return;
    try {
      const fields: string[] = [];
      const values: unknown[] = [];

      const fieldMap: Record<string, string> = {
        title: 'title',
        endTime: 'end_time',
        durationMs: 'duration_ms',
        userId: 'user_id',
        turnCount: 'turn_count',
        totalInputTokens: 'total_input_tokens',
        totalOutputTokens: 'total_output_tokens',
        totalTokens: 'total_tokens',
        estimatedCost: 'estimated_cost',
        totalToolCalls: 'total_tool_calls',
        toolSuccessRate: 'tool_success_rate',
        totalErrors: 'total_errors',
        sessionType: 'session_type',
        status: 'status',
        agentVersion: 'agent_version',
        promptVersion: 'prompt_version',
        toolSchemaVersion: 'tool_schema_version'
      };

      for (const [key, col] of Object.entries(fieldMap)) {
        if (key in updates) {
          fields.push(`${col} = ?`);
          const value = (updates as Record<string, unknown>)[key];
          values.push(key === 'title' && typeof value === 'string' ? guardTelemetryText(value, 2_000) : value);
        }
      }

      if (fields.length === 0) return;
      values.push(sessionId);

      const sql = `UPDATE telemetry_sessions SET ${fields.join(', ')} WHERE id = ?`;
      this.getDb()
        .prepare(sql)
        .run(...values);
    } catch (error) {
      logger.error('Failed to update telemetry session:', error);
    }
  }

  getSession(sessionId: string): TelemetrySession | null {
    if (!this.isDbAvailable()) return null;
    try {
      const row = this.getStmt(
        'get_session',
        `
          SELECT telemetry_sessions.*,
                 COALESCE(telemetry_sessions.user_id, sessions.user_id) AS user_id
          FROM telemetry_sessions
          LEFT JOIN sessions ON sessions.id = telemetry_sessions.id
          WHERE telemetry_sessions.id = ?
        `
      ).get(sessionId) as Record<string, unknown> | undefined;

      if (!row) return null;
      return rowToSession(row);
    } catch (error) {
      logger.error('Failed to get telemetry session:', error);
      return null;
    }
  }

  // --------------------------------------------------------------------------
  // Fleet 回传支持（云端上报）
  // --------------------------------------------------------------------------

  /**
   * 取尚未回传（synced_at IS NULL）、已结束（completed/error）、且有 userId 的会话。
   * recording 中的不传；无 userId（未登录采集）的不传——上传一律 auth-gated。
   */
  getUnsyncedSessions(limit = 50): TelemetrySession[] {
    if (!this.isDbAvailable()) return [];
    try {
      const rows = this.getStmt(
        'get_unsynced_sessions',
        `
          SELECT telemetry_sessions.*,
                 COALESCE(telemetry_sessions.user_id, sessions.user_id) AS user_id
          FROM telemetry_sessions
          LEFT JOIN sessions ON sessions.id = telemetry_sessions.id
          WHERE telemetry_sessions.synced_at IS NULL
            AND telemetry_sessions.status IN ('completed', 'error')
            AND COALESCE(telemetry_sessions.user_id, sessions.user_id) IS NOT NULL
          ORDER BY telemetry_sessions.start_time ASC
          LIMIT ?
        `
      ).all(limit) as Record<string, unknown>[];
      return rows.map((row) => rowToSession(row));
    } catch (error) {
      logger.error('Failed to get unsynced telemetry sessions:', error);
      return [];
    }
  }

  /** 标记一批会话为已回传。syncedAt 可选，未传时 fallback 当前时间。 */
  markSessionsSynced(sessionIds: string[], syncedAt: number = Date.now()): void {
    if (!this.isDbAvailable() || sessionIds.length === 0) return;
    try {
      const placeholders = sessionIds.map(() => '?').join(', ');
      this.getDb()
        .prepare(`UPDATE telemetry_sessions SET synced_at = ? WHERE id IN (${placeholders})`)
        .run(syncedAt, ...sessionIds);
    } catch (error) {
      logger.error('Failed to mark telemetry sessions synced:', error);
    }
  }

  recordFeedback(input: TelemetryFeedbackSubmitRequest): TelemetryFeedback | null {
    if (!this.isDbAvailable()) return null;
    if (input.rating !== 1 && input.rating !== -1) return null;
    const sessionId = input.sessionId?.trim();
    if (!sessionId) return null;

    try {
      const db = this.getDb();
      const messageId = input.messageId?.trim() || null;
      const turnId = input.turnId?.trim() || null;
      const existing = messageId
        ? db.prepare('SELECT id FROM telemetry_feedback WHERE session_id = ? AND message_id = ?').get(sessionId, messageId) as { id?: string } | undefined
        : undefined;
      const id = existing?.id ?? randomUUID();
      const createdAt = Date.now();
      const fullContent = input.rating === -1 && input.fullContent !== undefined
        ? stringifyGuardedTelemetry(input.fullContent)
        : null;

      db.prepare(
        `
          INSERT INTO telemetry_feedback (
            id, session_id, turn_id, message_id, rating, comment, full_content, created_at, synced_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL)
          ON CONFLICT(id) DO UPDATE SET
            turn_id = excluded.turn_id,
            message_id = excluded.message_id,
            rating = excluded.rating,
            comment = excluded.comment,
            full_content = excluded.full_content,
            created_at = excluded.created_at,
            synced_at = NULL
        `,
      ).run(
        id,
        sessionId,
        turnId,
        messageId,
        input.rating,
        guardTelemetryText(input.comment, TELEMETRY_TRUNCATION.EVENT_SUMMARY),
        fullContent,
        createdAt,
      );

      return {
        id,
        sessionId,
        turnId,
        messageId,
        rating: input.rating,
        comment: input.comment ?? null,
        fullContent: fullContent ? parseTelemetryJson(fullContent) : undefined,
        createdAt,
        syncedAt: null,
      };
    } catch (error) {
      logger.error('Failed to record telemetry feedback:', error);
      return null;
    }
  }

  getUnsyncedFeedback(limit = 50, userId?: string): TelemetryFeedback[] {
    if (!this.isDbAvailable()) return [];
    try {
      const ownerFilter = userId ? 'AND COALESCE(telemetry_sessions.user_id, sessions.user_id) = ?' : '';
      const rows = this.getStmt(
        userId ? 'get_unsynced_feedback_for_user' : 'get_unsynced_feedback',
        `
          SELECT telemetry_feedback.*
          FROM telemetry_feedback
          LEFT JOIN telemetry_sessions ON telemetry_sessions.id = telemetry_feedback.session_id
          LEFT JOIN sessions ON sessions.id = telemetry_feedback.session_id
          WHERE telemetry_feedback.synced_at IS NULL
            AND telemetry_sessions.status IN ('completed', 'error')
            AND COALESCE(telemetry_sessions.user_id, sessions.user_id) IS NOT NULL
            ${ownerFilter}
          ORDER BY telemetry_feedback.created_at ASC
          LIMIT ?
        `,
      ).all(...(userId ? [userId] : []), limit) as Record<string, unknown>[];
      return rows.map((row) => rowToFeedback(row));
    } catch (error) {
      logger.error('Failed to get unsynced telemetry feedback:', error);
      return [];
    }
  }

  markFeedbackSynced(feedbackIds: string[], syncedAt: number = Date.now()): void {
    if (!this.isDbAvailable() || feedbackIds.length === 0) return;
    try {
      const placeholders = feedbackIds.map(() => '?').join(', ');
      this.getDb()
        .prepare(`UPDATE telemetry_feedback SET synced_at = ? WHERE id IN (${placeholders})`)
        .run(syncedAt, ...feedbackIds);
    } catch (error) {
      logger.error('Failed to mark telemetry feedback synced:', error);
    }
  }

  recordRendererBundleAttempt(status: RendererBundleStatus): TelemetryRendererBundleAttempt | null {
    if (!this.isDbAvailable() || !status.lastAttempt) return null;
    const attempt = status.lastAttempt;
    const manifest = attempt.manifest;
    const source = status.source;
    const active = status.activeBundle;
    const record: TelemetryRendererBundleAttempt = {
      id: randomUUID(),
      checkedAt: parseTelemetryTimestamp(attempt.checkedAt),
      manifestUrl: attempt.manifestUrl,
      sourceChannel: source?.channel ?? null,
      sourceManifestUrlOverride: source?.manifestUrlOverride === true,
      sourceErrorReason: source?.errorReason ?? null,
      sourceErrorMessage: source?.errorMessage ?? null,
      sourceErrorTarget: source?.errorTarget ?? null,
      currentShellVersion: attempt.currentShellVersion,
      activeVersion: active?.version ?? null,
      activeContentHash: active?.contentHash ?? null,
      outcome: attempt.outcome,
      reason: attempt.reason ?? null,
      manifestVersion: manifest?.version ?? null,
      manifestContentHash: manifest?.contentHash ?? null,
      manifestMinShellVersion: manifest?.minShellVersion ?? null,
      manifestBundleUrl: manifest?.bundleUrl ?? null,
      requiredShellCapabilitiesCount: manifest?.requiredShellCapabilitiesCount ?? 0,
      rollbackToBuiltin: manifest?.rollbackToBuiltin === true,
      rollbackReason: manifest?.rollbackReason ?? null,
      missingShellCapabilities: attempt.missingShellCapabilities ?? [],
      missingRuntimeAssets: attempt.missingRuntimeAssets ?? [],
      missingResources: attempt.missingResources ?? [],
      diagnostics: attempt.diagnostics ?? [],
      errorMessage: attempt.errorMessage ?? null,
      syncedAt: null,
    };

    try {
      this.getStmt(
        'insert_renderer_bundle_attempt',
        `
          INSERT INTO telemetry_renderer_bundle_attempts (
            id, checked_at, manifest_url, source_channel, source_manifest_url_override,
            source_error_reason, source_error_message, source_error_target,
            current_shell_version, active_version, active_content_hash,
            outcome, reason, manifest_version, manifest_content_hash,
            manifest_min_shell_version, manifest_bundle_url,
            required_shell_capabilities_count, rollback_to_builtin, rollback_reason,
            missing_shell_capabilities, missing_runtime_assets, missing_resources,
            diagnostics, error_message, synced_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)
        `,
      ).run(
        record.id,
        record.checkedAt,
        guardTelemetryText(record.manifestUrl, 4_000),
        guardTelemetryText(record.sourceChannel, 200),
        record.sourceManifestUrlOverride ? 1 : 0,
        guardTelemetryText(record.sourceErrorReason, TELEMETRY_TRUNCATION.EVENT_SUMMARY),
        guardTelemetryText(record.sourceErrorMessage, TELEMETRY_TRUNCATION.EVENT_SUMMARY),
        guardTelemetryText(record.sourceErrorTarget, 4_000),
        guardTelemetryText(record.currentShellVersion, 200),
        guardTelemetryText(record.activeVersion, 200),
        guardTelemetryText(record.activeContentHash, 200),
        record.outcome,
        guardTelemetryText(record.reason, TELEMETRY_TRUNCATION.EVENT_SUMMARY),
        guardTelemetryText(record.manifestVersion, 200),
        guardTelemetryText(record.manifestContentHash, 200),
        guardTelemetryText(record.manifestMinShellVersion, 200),
        guardTelemetryText(record.manifestBundleUrl, 4_000),
        record.requiredShellCapabilitiesCount,
        record.rollbackToBuiltin ? 1 : 0,
        guardTelemetryText(record.rollbackReason, TELEMETRY_TRUNCATION.EVENT_SUMMARY),
        stringifyGuardedTelemetry(record.missingShellCapabilities),
        stringifyGuardedTelemetry(record.missingRuntimeAssets),
        stringifyGuardedTelemetry(record.missingResources),
        stringifyGuardedTelemetry(record.diagnostics),
        guardTelemetryText(record.errorMessage, TELEMETRY_TRUNCATION.EVENT_SUMMARY),
      );
      return record;
    } catch (error) {
      logger.error('Failed to record renderer bundle telemetry attempt:', error);
      return null;
    }
  }

  getUnsyncedRendererBundleAttempts(limit = 50): TelemetryRendererBundleAttempt[] {
    if (!this.isDbAvailable()) return [];
    try {
      const rows = this.getStmt(
        'get_unsynced_renderer_bundle_attempts',
        `
          SELECT * FROM telemetry_renderer_bundle_attempts
          WHERE synced_at IS NULL
          ORDER BY checked_at ASC
          LIMIT ?
        `,
      ).all(limit) as Record<string, unknown>[];
      return rows.map((row) => rowToRendererBundleAttempt(row));
    } catch (error) {
      logger.error('Failed to get unsynced renderer bundle telemetry attempts:', error);
      return [];
    }
  }

  markRendererBundleAttemptsSynced(attemptIds: string[], syncedAt: number = Date.now()): void {
    if (!this.isDbAvailable() || attemptIds.length === 0) return;
    try {
      const placeholders = attemptIds.map(() => '?').join(', ');
      this.getDb()
        .prepare(`UPDATE telemetry_renderer_bundle_attempts SET synced_at = ? WHERE id IN (${placeholders})`)
        .run(syncedAt, ...attemptIds);
    } catch (error) {
      logger.error('Failed to mark renderer bundle telemetry attempts synced:', error);
    }
  }

  listSessions(options: TelemetrySessionListOptions = {}): TelemetrySessionListItem[] {
    if (!this.isDbAvailable()) return [];
    try {
      const limit = options.limit ?? 50;
      const offset = options.offset ?? 0;
      const where: string[] = [];
      const params: unknown[] = [];
      const ownerExpr = 'COALESCE(telemetry_sessions.user_id, sessions.user_id)';

      if (options.unassignedOnly) {
        where.push(`${ownerExpr} IS NULL`);
      } else if (options.userId) {
        where.push(`${ownerExpr} = ?`);
        params.push(options.userId);
      }

      const rows = this.getDb()
        .prepare(
          `
          SELECT telemetry_sessions.id,
                 ${ownerExpr} AS user_id,
                 telemetry_sessions.title,
                 telemetry_sessions.model_provider,
                 telemetry_sessions.model_name,
                 telemetry_sessions.start_time,
                 telemetry_sessions.end_time,
                 telemetry_sessions.turn_count,
                 telemetry_sessions.total_tokens,
                 telemetry_sessions.estimated_cost,
                 telemetry_sessions.status
          FROM telemetry_sessions
          LEFT JOIN sessions ON sessions.id = telemetry_sessions.id
          ${where.length > 0 ? `WHERE ${where.join(' AND ')}` : ''}
          ORDER BY telemetry_sessions.start_time DESC
          LIMIT ? OFFSET ?
        `
        )
        .all(...params, limit, offset) as Record<string, unknown>[];

      return rows.map((row) => ({
        id: row.id as string,
        userId: row.user_id == null ? null : String(row.user_id),
        title: row.title as string,
        modelProvider: row.model_provider as string,
        modelName: row.model_name as string,
        startTime: row.start_time as number,
        endTime: row.end_time as number | undefined,
        turnCount: row.turn_count as number,
        totalTokens: row.total_tokens as number,
        estimatedCost: row.estimated_cost as number,
        status: row.status as string
      }));
    } catch (error) {
      logger.error('Failed to list telemetry sessions:', error);
      return [];
    }
  }

  deleteSession(sessionId: string): void {
    if (!this.isDbAvailable()) return;
    try {
      const db = this.getDb();
      db.transaction(() => {
        db.prepare('DELETE FROM telemetry_raw_payloads WHERE session_id = ?').run(sessionId);
        db.prepare('DELETE FROM telemetry_feedback WHERE session_id = ?').run(sessionId);
        db.prepare('DELETE FROM telemetry_events WHERE session_id = ?').run(sessionId);
        db.prepare('DELETE FROM telemetry_tool_calls WHERE session_id = ?').run(sessionId);
        db.prepare('DELETE FROM telemetry_model_calls WHERE session_id = ?').run(sessionId);
        db.prepare('DELETE FROM telemetry_turns WHERE session_id = ?').run(sessionId);
        db.prepare('DELETE FROM telemetry_sessions WHERE id = ?').run(sessionId);
      })();
    } catch (error) {
      logger.error('Failed to delete telemetry session:', error);
    }
  }

  // --------------------------------------------------------------------------
  // 诊断 raw payload 旁表:读取 + 滚动淘汰
  // --------------------------------------------------------------------------

  /** 取某会话的全部 raw payload(供诊断包打包用)。 */
  getRawPayloadsForSession(sessionId: string): Array<{ turnId: string | null; refKind: string; refId: string; field: string; content: string; byteLen: number; truncated: boolean; createdAt: number }> {
    if (!this.isDbAvailable()) return [];
    try {
      const rows = this.getDb()
        .prepare('SELECT turn_id, ref_kind, ref_id, field, content, byte_len, truncated, created_at FROM telemetry_raw_payloads WHERE session_id = ? ORDER BY created_at ASC')
        .all(sessionId) as Array<Record<string, unknown>>;
      return rows.map((r) => ({
        turnId: (r.turn_id as string | null) ?? null,
        refKind: r.ref_kind as string,
        refId: r.ref_id as string,
        field: r.field as string,
        content: (r.content as string | null) ?? '',
        byteLen: r.byte_len as number,
        truncated: r.truncated === 1,
        createdAt: r.created_at as number,
      }));
    } catch (error) {
      logger.error('Failed to read raw payloads:', error);
      return [];
    }
  }

  // --------------------------------------------------------------------------
  // 诊断包本地排队表:入队 + 取未上传 + 标记已上传
  // --------------------------------------------------------------------------

  /** 把一条脱敏诊断包写入本地排队表(待上传)。 */
  insertDiagnosticBundle(record: TelemetryDiagnosticBundleRecord): void {
    if (!this.isDbAvailable()) return;
    try {
      this.getStmt(
        'insert_diag_bundle',
        `
          INSERT OR REPLACE INTO telemetry_diagnostic_bundles (
            id, session_id, agent_version, prompt_version, tool_schema_version,
            trigger_reason, bundle_version, built_at, bundle, created_at, synced_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `,
      ).run(
        record.id, record.sessionId, record.agentVersion ?? null, record.promptVersion ?? null,
        record.toolSchemaVersion ?? null, record.triggerReason, record.bundleVersion, record.builtAt,
        record.bundle, record.createdAt, record.syncedAt ?? null,
      );
    } catch (error) {
      logger.error('Failed to insert diagnostic bundle:', error);
    }
  }

  /** 取尚未上传(synced_at IS NULL)的诊断包。 */
  getUnsyncedDiagnosticBundles(limit = 20): TelemetryDiagnosticBundleRecord[] {
    if (!this.isDbAvailable()) return [];
    try {
      const rows = this.getStmt(
        'get_unsynced_diag_bundles',
        'SELECT * FROM telemetry_diagnostic_bundles WHERE synced_at IS NULL ORDER BY created_at ASC LIMIT ?',
      ).all(limit) as Array<Record<string, unknown>>;
      return rows.map((r) => ({
        id: r.id as string,
        sessionId: r.session_id as string,
        agentVersion: (r.agent_version as string | null) ?? null,
        promptVersion: (r.prompt_version as string | null) ?? null,
        toolSchemaVersion: (r.tool_schema_version as string | null) ?? null,
        triggerReason: r.trigger_reason as TelemetryDiagnosticBundleRecord['triggerReason'],
        bundleVersion: r.bundle_version as number,
        builtAt: r.built_at as number,
        bundle: r.bundle as string,
        createdAt: r.created_at as number,
        syncedAt: (r.synced_at as number | null) ?? null,
      }));
    } catch (error) {
      logger.error('Failed to read unsynced diagnostic bundles:', error);
      return [];
    }
  }

  /** 标记一批诊断包已上传。 */
  markDiagnosticBundlesSynced(ids: string[], syncedAt: number): void {
    if (!this.isDbAvailable() || ids.length === 0) return;
    try {
      const db = this.getDb();
      const stmt = db.prepare('UPDATE telemetry_diagnostic_bundles SET synced_at = ? WHERE id = ?');
      db.transaction(() => {
        for (const id of ids) stmt.run(syncedAt, id);
      })();
    } catch (error) {
      logger.error('Failed to mark diagnostic bundles synced:', error);
    }
  }

  /** raw 旁表当前总字节(dbstat 优先,降级 SUM(LENGTH))。 */
  getRawPayloadsBytes(): number {
    if (!this.isDbAvailable()) return 0;
    const db = this.getDb();
    try {
      const row = db.prepare("SELECT COALESCE(SUM(pgsize), 0) AS bytes FROM dbstat WHERE name = 'telemetry_raw_payloads'").get() as { bytes?: number } | undefined;
      if (typeof row?.bytes === 'number' && row.bytes > 0) return row.bytes;
    } catch {
      // dbstat 未启用,降级
    }
    try {
      const row = db.prepare('SELECT COALESCE(SUM(LENGTH(content)), 0) AS bytes FROM telemetry_raw_payloads').get() as { bytes?: number } | undefined;
      return row?.bytes ?? 0;
    } catch {
      return 0;
    }
  }

  /**
   * raw 旁表滚动淘汰:三重封顶,谁先到谁先淘汰。
   * 1) 超 RETENTION_MAX_AGE_MS 的直接删
   * 2) 只保留最近 RETENTION_MAX_TURNS 个 turn
   * 3) 仍超 RETENTION_MAX_BYTES 则从最旧 turn 开始整 turn 删,直到达标
   * now 可注入(测试用),默认 Date.now()。
   */
  pruneRawPayloads(now: number = Date.now()): void {
    if (!this.isDbAvailable()) return;
    try {
      const db = this.getDb();
      db.transaction(() => {
        // 1) 按年龄
        db.prepare('DELETE FROM telemetry_raw_payloads WHERE created_at < ?').run(now - TELEMETRY_RAW.RETENTION_MAX_AGE_MS);

        // 2) 按 turn 数:保留最近 N 个 turn(以 turn 的最新 created_at 排序)
        db.prepare(
          `
          DELETE FROM telemetry_raw_payloads
          WHERE COALESCE(turn_id, id) NOT IN (
            SELECT t FROM (
              SELECT COALESCE(turn_id, id) AS t, MAX(created_at) AS mc
              FROM telemetry_raw_payloads
              GROUP BY COALESCE(turn_id, id)
              ORDER BY mc DESC
              LIMIT ?
            )
          )
          `,
        ).run(TELEMETRY_RAW.RETENTION_MAX_TURNS);
      })();

      // 3) 按体积:从最旧 turn 整组删,直到达标(每轮删一个 turn 组)
      let guard = 0;
      while (this.getRawPayloadsBytes() > TELEMETRY_RAW.RETENTION_MAX_BYTES && guard < 10000) {
        guard += 1;
        const oldest = db
          .prepare('SELECT COALESCE(turn_id, id) AS t FROM telemetry_raw_payloads GROUP BY COALESCE(turn_id, id) ORDER BY MIN(created_at) ASC LIMIT 1')
          .get() as { t?: string } | undefined;
        if (!oldest?.t) break;
        db.prepare('DELETE FROM telemetry_raw_payloads WHERE COALESCE(turn_id, id) = ?').run(oldest.t);
      }
    } catch (error) {
      logger.error('Failed to prune raw payloads:', error);
    }
  }

  /**
   * DB 是否可用（外部观测，不会触发额外探测）。CLI / DB 不可用环境下为 false。
   */
  get dbAvailable(): boolean {
    return this.isDbAvailable();
  }

  /**
   * 返回所有 telemetry 表的总占用（字节）。利用 SQLite 的
   * dbstat 虚表实际统计 page 占用，不可用时降级为 SUM(LENGTH(...))
   * 估算每张表所有列的串行化长度。
   */
  getStorageBytes(): number {
    if (!this.isDbAvailable()) return 0;
    const db = this.getDb();
    const tables = ['telemetry_sessions', 'telemetry_turns', 'telemetry_model_calls', 'telemetry_tool_calls', 'telemetry_events', 'telemetry_feedback', 'telemetry_renderer_bundle_attempts'];

    // dbstat 是 SQLite 编译选项，better-sqlite3 默认未开启；先尝试
    try {
      const placeholders = tables.map(() => '?').join(',');
      const row = db.prepare(`SELECT COALESCE(SUM(pgsize), 0) AS bytes FROM dbstat WHERE name IN (${placeholders})`).get(...tables) as { bytes?: number } | undefined;
      const bytes = row?.bytes;
      if (typeof bytes === 'number' && bytes > 0) {
        return bytes;
      }
    } catch {
      // dbstat 未启用，落到降级估算
    }

    let total = 0;
    for (const table of tables) {
      try {
        // 每张表：用 COUNT(*) × 抽样 100 行的平均 JSON 字节估算总占用。
        // 没有 dbstat 时也能给出"几 MB"量级的真实读数，不是猜的。
        const countRow = db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n?: number } | undefined;
        const n = countRow?.n ?? 0;
        if (n === 0) continue;
        const sample = db.prepare(`SELECT * FROM ${table} LIMIT 100`).all() as unknown[];
        if (sample.length === 0) continue;
        const sampleBytes = sample.reduce((sum: number, item) => sum + JSON.stringify(item).length, 0);
        const avg = sampleBytes / sample.length;
        total += Math.round(avg * n);
      } catch {
        // 表不存在或查询失败：忽略
      }
    }
    return total;
  }

  /**
   * 全表 session 数量（不分页）。
   */
  getSessionCount(): number {
    if (!this.isDbAvailable()) return 0;
    try {
      const row = this.getDb().prepare('SELECT COUNT(*) AS n FROM telemetry_sessions').get() as { n?: number } | undefined;
      return row?.n ?? 0;
    } catch {
      return 0;
    }
  }

  /**
   * 最近一次 telemetry 事件的时间戳（毫秒），无数据返回 null。
   * 综合 events / turns / sessions 三张表的最大时间。
   */
  getLastEventAt(): number | null {
    if (!this.isDbAvailable()) return null;
    try {
      const row = this.getDb()
        .prepare(
          `
        SELECT MAX(ts) AS last_at FROM (
          SELECT MAX(timestamp) AS ts FROM telemetry_events
          UNION ALL
          SELECT MAX(end_time) AS ts FROM telemetry_turns
          UNION ALL
          SELECT MAX(start_time) AS ts FROM telemetry_sessions
          UNION ALL
          SELECT MAX(checked_at) AS ts FROM telemetry_renderer_bundle_attempts
        )
      `
        )
        .get() as { last_at?: number | null } | undefined;
      const lastAt = row?.last_at;
      return typeof lastAt === 'number' && lastAt > 0 ? lastAt : null;
    } catch {
      return null;
    }
  }

  // --------------------------------------------------------------------------
  // Turn CRUD
  // --------------------------------------------------------------------------

  insertTurn(turn: TelemetryTurn): void {
    if (!this.isDbAvailable()) return;
    try {
      const stmt = this.getStmt(
        'insert_turn',
        `
        INSERT OR REPLACE INTO telemetry_turns (
          id, session_id, turn_number, start_time, end_time, duration_ms,
          user_prompt, user_prompt_tokens, has_attachments, attachment_count,
          system_prompt_hash, agent_mode, active_skills, active_mcp_servers, effort_level,
          assistant_response, assistant_response_tokens, thinking_content,
          total_input_tokens, total_output_tokens,
          intent_primary, intent_secondary, intent_confidence, intent_method, intent_keywords,
          outcome_status, outcome_confidence, outcome_method, quality_signals,
          compaction_occurred, compaction_saved_tokens, iteration_count, agent_id,
          turn_type, parent_turn_id
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `
      );
      stmt.run(
        turn.id,
        turn.sessionId,
        turn.turnNumber,
        turn.startTime,
        turn.endTime,
        turn.durationMs,
        guardTelemetryText(turn.userPrompt, TELEMETRY_TRUNCATION.USER_PROMPT),
        turn.userPromptTokens,
        turn.hasAttachments ? 1 : 0,
        turn.attachmentCount,
        turn.systemPromptHash ?? null,
        turn.agentMode,
        stringifyGuardedTelemetry(turn.activeSkills ?? []),
        stringifyGuardedTelemetry(turn.activeMcpServers ?? []),
        turn.effortLevel,
        guardTelemetryText(turn.assistantResponse, TELEMETRY_TRUNCATION.ASSISTANT_RESPONSE),
        turn.assistantResponseTokens,
        guardTelemetryText(turn.thinkingContent, TELEMETRY_TRUNCATION.THINKING_CONTENT),
        turn.totalInputTokens,
        turn.totalOutputTokens,
        turn.intent.primary,
        turn.intent.secondary ?? null,
        turn.intent.confidence,
        turn.intent.method,
        stringifyGuardedTelemetry(turn.intent.keywords),
        turn.outcome.status,
        turn.outcome.confidence,
        turn.outcome.method,
        stringifyGuardedTelemetry(turn.outcome.signals),
        turn.compactionOccurred ? 1 : 0,
        turn.compactionSavedTokens ?? null,
        turn.iterationCount,
        turn.agentId || 'main',
        turn.turnType || 'user',
        turn.parentTurnId ?? null
      );
    } catch (error) {
      logger.error('Failed to insert telemetry turn:', error);
    }
  }

  getTurnsBySession(sessionId: string, agentId?: string): TelemetryTurn[] {
    if (!this.isDbAvailable()) return [];
    try {
      if (agentId) {
        const rows = this.getDb().prepare('SELECT * FROM telemetry_turns WHERE session_id = ? AND agent_id = ? ORDER BY start_time ASC').all(sessionId, agentId) as Record<string, unknown>[];
        return rows.map((row) => rowToTurn(row));
      }
      const rows = this.getStmt(
        'get_turns',
        `
        SELECT * FROM telemetry_turns WHERE session_id = ? ORDER BY start_time ASC
      `
      ).all(sessionId) as Record<string, unknown>[];

      return rows.map((row) => rowToTurn(row));
    } catch (error) {
      logger.error('Failed to get telemetry turns:', error);
      return [];
    }
  }

  /**
   * 只取 turn 的模型/工具调用明细，不连带 events（每 turn 约 90 条，云端上传用不上）。
   * rowToTurn 出来的 turn 这两个数组恒为空（明细在独立表里），上传器必须用这个补齐。
   */
  getTurnCalls(turnId: string): { modelCalls: TelemetryModelCall[]; toolCalls: TelemetryToolCall[] } {
    if (!this.isDbAvailable()) return { modelCalls: [], toolCalls: [] };
    try {
      const modelCalls = (
        this.getStmt(
          'get_model_calls',
          `
        SELECT * FROM telemetry_model_calls WHERE turn_id = ? ORDER BY timestamp ASC
      `
        ).all(turnId) as Record<string, unknown>[]
      ).map((r) => rowToModelCall(r));

      const toolCalls = (
        this.getStmt(
          'get_tool_calls',
          `
        SELECT * FROM telemetry_tool_calls WHERE turn_id = ? ORDER BY idx ASC
      `
        ).all(turnId) as Record<string, unknown>[]
      ).map((r) => rowToToolCall(r));

      return { modelCalls, toolCalls };
    } catch (error) {
      logger.error('Failed to get telemetry turn calls:', error);
      return { modelCalls: [], toolCalls: [] };
    }
  }

  getTurnDetail(turnId: string): {
    turn: TelemetryTurn;
    modelCalls: TelemetryModelCall[];
    toolCalls: TelemetryToolCall[];
    events: TelemetryTimelineEvent[];
  } | null {
    if (!this.isDbAvailable()) return null;
    try {
      const turnRow = this.getStmt(
        'get_turn',
        `
        SELECT * FROM telemetry_turns WHERE id = ?
      `
      ).get(turnId) as Record<string, unknown> | undefined;

      if (!turnRow) return null;

      const { modelCalls, toolCalls } = this.getTurnCalls(turnId);

      const events = (
        this.getStmt(
          'get_events',
          `
        SELECT * FROM telemetry_events WHERE turn_id = ? ORDER BY timestamp ASC
      `
        ).all(turnId) as Record<string, unknown>[]
      ).map((r) => rowToEvent(r));

      const turn = rowToTurn(turnRow);
      turn.modelCalls = modelCalls;
      turn.toolCalls = toolCalls;
      turn.events = events;

      return { turn, modelCalls, toolCalls, events };
    } catch (error) {
      logger.error('Failed to get turn detail:', error);
      return null;
    }
  }

  // --------------------------------------------------------------------------
  // Batch Insert (for collector flush)
  // --------------------------------------------------------------------------

  batchInsert(data: { modelCalls?: Array<TelemetryModelCall & { turnId: string; sessionId: string }>; toolCalls?: Array<TelemetryToolCall & { turnId: string; sessionId: string }>; events?: Array<TelemetryTimelineEvent & { turnId: string; sessionId: string }> }): void {
    if (!this.isDbAvailable()) return;
    try {
      const db = this.getDb();
      db.transaction(() => {
        if (data.modelCalls?.length) {
          const stmt = db.prepare(`
            INSERT OR IGNORE INTO telemetry_model_calls (
              id, turn_id, session_id, timestamp, provider, model,
              temperature, max_tokens, input_tokens, output_tokens,
              latency_ms, response_type, tool_call_count, truncated,
              error, fallback_info, prompt, completion
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          `);
          for (const mc of data.modelCalls) {
            stmt.run(mc.id, mc.turnId, mc.sessionId, mc.timestamp, mc.provider, mc.model, mc.temperature ?? null, mc.maxTokens ?? null, mc.inputTokens, mc.outputTokens, mc.latencyMs, mc.responseType, mc.toolCallCount, mc.truncated ? 1 : 0, guardTelemetryText(mc.error, TELEMETRY_TRUNCATION.EVENT_SUMMARY), mc.fallbackUsed ? stringifyGuardedTelemetry(mc.fallbackUsed) : null, guardTelemetryText(mc.prompt, TELEMETRY_TRUNCATION.USER_PROMPT), guardTelemetryText(mc.completion, TELEMETRY_TRUNCATION.ASSISTANT_RESPONSE));
          }
        }

        if (data.toolCalls?.length) {
          const stmt = db.prepare(`
            INSERT OR IGNORE INTO telemetry_tool_calls (
              id, turn_id, session_id, tool_call_id, name, arguments, actual_arguments,
              result_summary, success, error, error_category,
              computer_surface_failure_kind, computer_surface_mode,
              computer_surface_target_app, computer_surface_action,
              computer_surface_ax_quality_score, computer_surface_ax_quality_grade,
              duration_ms, timestamp, idx, parallel
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          `);
          for (const tc of data.toolCalls) {
            stmt.run(tc.id, tc.turnId, tc.sessionId, tc.toolCallId, tc.name, guardTelemetryJsonText(tc.arguments, TELEMETRY_TRUNCATION.TOOL_ARGUMENTS), guardTelemetryJsonText(tc.actualArguments, TELEMETRY_TRUNCATION.TOOL_ARGUMENTS), guardTelemetryText(tc.resultSummary, TELEMETRY_TRUNCATION.TOOL_RESULT_SUMMARY), tc.success ? 1 : 0, guardTelemetryText(tc.error, TELEMETRY_TRUNCATION.EVENT_SUMMARY), tc.errorCategory ?? null, tc.computerSurfaceFailureKind ?? null, tc.computerSurfaceMode ?? null, tc.computerSurfaceTargetApp ?? null, tc.computerSurfaceAction ?? null, tc.computerSurfaceAxQualityScore ?? null, tc.computerSurfaceAxQualityGrade ?? null, tc.durationMs, tc.timestamp, tc.index, tc.parallel ? 1 : 0);
          }
        }

        if (data.events?.length) {
          const stmt = db.prepare(`
            INSERT OR IGNORE INTO telemetry_events (
              id, turn_id, session_id, timestamp, event_type,
              summary, data, duration_ms
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
          `);
          for (const ev of data.events) {
            stmt.run(ev.id, ev.turnId, ev.sessionId, ev.timestamp, ev.eventType, guardTelemetryText(ev.summary, TELEMETRY_TRUNCATION.EVENT_SUMMARY), guardTelemetryJsonText(ev.data, TELEMETRY_TRUNCATION.TOOL_ARGUMENTS), ev.durationMs ?? null);
          }
        }

        // 诊断 raw 旁表:在聚合截断之前,把原始全量内容(仅密钥掩码)另存一份
        const rawStmt = db.prepare(`
          INSERT OR IGNORE INTO telemetry_raw_payloads (
            id, session_id, turn_id, ref_kind, ref_id, field, content, byte_len, truncated, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `);
        const writeRaw = (
          sessionId: string,
          turnId: string,
          refKind: 'model_call' | 'tool_call',
          refId: string,
          field: string,
          value: string | undefined | null,
          createdAt: number,
        ): void => {
          const prepared = prepareRawPayload(value);
          if (!prepared) return;
          rawStmt.run(randomUUID(), sessionId, turnId, refKind, refId, field, prepared.content, prepared.byteLen, prepared.truncated ? 1 : 0, createdAt);
        };
        for (const mc of data.modelCalls ?? []) {
          writeRaw(mc.sessionId, mc.turnId, 'model_call', mc.id, 'prompt', mc.prompt, mc.timestamp);
          writeRaw(mc.sessionId, mc.turnId, 'model_call', mc.id, 'completion', mc.completion, mc.timestamp);
        }
        for (const tc of data.toolCalls ?? []) {
          writeRaw(tc.sessionId, tc.turnId, 'tool_call', tc.id, 'arguments', tc.arguments, tc.timestamp);
          writeRaw(tc.sessionId, tc.turnId, 'tool_call', tc.id, 'actual_arguments', tc.actualArguments, tc.timestamp);
          writeRaw(tc.sessionId, tc.turnId, 'tool_call', tc.id, 'result', tc.resultSummary, tc.timestamp);
        }
      })();
    } catch (error) {
      logger.error('Failed to batch insert telemetry data:', error);
    }
  }

  // --------------------------------------------------------------------------
  // Query Methods
  // --------------------------------------------------------------------------

  getToolUsageStats(sessionId: string): TelemetryToolStat[] {
    if (!this.isDbAvailable()) return [];
    try {
      const rows = this.getStmt(
        'tool_stats',
        `
        SELECT
          name,
          COUNT(*) as call_count,
          SUM(CASE WHEN success = 1 THEN 1 ELSE 0 END) as success_count,
          SUM(CASE WHEN success = 0 THEN 1 ELSE 0 END) as fail_count,
          AVG(duration_ms) as avg_duration_ms,
          SUM(duration_ms) as total_duration_ms
        FROM telemetry_tool_calls
        WHERE session_id = ?
        GROUP BY name
        ORDER BY call_count DESC
      `
      ).all(sessionId) as Record<string, unknown>[];

      return rows.map((row) => ({
        name: row.name as string,
        callCount: row.call_count as number,
        successCount: row.success_count as number,
        failCount: row.fail_count as number,
        successRate: (row.call_count as number) > 0 ? (row.success_count as number) / (row.call_count as number) : 0,
        avgDurationMs: Math.round(row.avg_duration_ms as number),
        totalDurationMs: row.total_duration_ms as number
      }));
    } catch (error) {
      logger.error('Failed to get tool usage stats:', error);
      return [];
    }
  }

  /**
   * 获取会话的所有工具调用（用于错误模式分析）
   */
  getToolCallsBySession(sessionId: string): TelemetryToolCall[] {
    if (!this.isDbAvailable()) return [];
    try {
      const rows = this.getStmt(
        'get_tool_calls_by_session',
        `
        SELECT * FROM telemetry_tool_calls
        WHERE session_id = ?
        ORDER BY timestamp ASC
      `
      ).all(sessionId) as Record<string, unknown>[];

      return rows.map((row) => rowToToolCall(row));
    } catch (error) {
      logger.error('Failed to get tool calls by session:', error);
      return [];
    }
  }

  getComputerSurfaceReliabilitySummary(sessionId: string): ComputerSurfaceReliabilitySummary {
    return computeComputerSurfaceReliabilitySummary(
      { isDbAvailable: () => this.isDbAvailable(), getStmt: (key, sql) => this.getStmt(key, sql) },
      sessionId,
    );
  }

  getIntentDistribution(sessionId: string): TelemetryIntentStat[] {
    if (!this.isDbAvailable()) return [];
    try {
      const rows = this.getStmt(
        'intent_dist',
        `
        SELECT intent_primary, COUNT(*) as count
        FROM telemetry_turns
        WHERE session_id = ?
        GROUP BY intent_primary
        ORDER BY count DESC
      `
      ).all(sessionId) as Record<string, unknown>[];

      const total = rows.reduce((sum, r) => sum + (r.count as number), 0);

      return rows.map((row) => ({
        intent: row.intent_primary as TelemetryIntentStat['intent'],
        count: row.count as number,
        percentage: total > 0 ? (row.count as number) / total : 0
      }));
    } catch (error) {
      logger.error('Failed to get intent distribution:', error);
      return [];
    }
  }

  /**
   * 成本日历聚合：按日/周/月对 telemetry_sessions.estimated_cost 做 GROUP BY date 聚合。
   * 读侧逻辑聚合，不建物理大表（对齐 ADR-023 P2）；周期键用本地时区，
   * 返回按周期正序（旧→新）排列，供前端趋势图直接渲染。
   */
  getCostByPeriod(options: TelemetryCostByPeriodOptions): TelemetryCostBucket[] {
    if (!this.isDbAvailable()) return [];
    try {
      const limit = options.limit ?? 30;
      // 周期键的 strftime 格式：本地时区，start_time 为毫秒需转秒
      const periodFormat =
        options.granularity === 'month'
          ? '%Y-%m'
          : options.granularity === 'week'
            ? '%Y-W%W'
            : '%Y-%m-%d';
      const periodExpr = `strftime('${periodFormat}', telemetry_sessions.start_time / 1000, 'unixepoch', 'localtime')`;

      const where: string[] = [];
      const params: unknown[] = [];
      const ownerExpr = 'COALESCE(telemetry_sessions.user_id, sessions.user_id)';
      if (options.unassignedOnly) {
        where.push(`${ownerExpr} IS NULL`);
      } else if (options.userId) {
        where.push(`${ownerExpr} = ?`);
        params.push(options.userId);
      }

      const rows = this.getDb()
        .prepare(
          `
          SELECT ${periodExpr} AS period,
                 COALESCE(SUM(telemetry_sessions.estimated_cost), 0) AS cost,
                 COALESCE(SUM(telemetry_sessions.total_tokens), 0) AS tokens,
                 COUNT(*) AS sessions
          FROM telemetry_sessions
          LEFT JOIN sessions ON sessions.id = telemetry_sessions.id
          ${where.length > 0 ? `WHERE ${where.join(' AND ')}` : ''}
          GROUP BY period
          ORDER BY period DESC
          LIMIT ?
        `
        )
        .all(...params, limit) as Record<string, unknown>[];

      // 倒序取最近 N 个 → 反转为正序（旧→新）供图表 X 轴渲染
      return rows
        .map((row) => ({
          period: String(row.period),
          cost: Number(row.cost) || 0,
          tokens: Number(row.tokens) || 0,
          sessions: Number(row.sessions) || 0,
        }))
        .reverse();
    } catch (error) {
      logger.error('Failed to aggregate telemetry cost by period:', error);
      return [];
    }
  }

  /**
   * 获取会话的所有事件（用于时间线视图）
   */
  getEventsBySession(sessionId: string): TelemetryTimelineEvent[] {
    if (!this.isDbAvailable()) return [];
    try {
      const rows = this.getStmt(
        'get_events_by_session',
        `
        SELECT * FROM telemetry_events
        WHERE session_id = ?
        ORDER BY timestamp ASC
      `
      ).all(sessionId) as Record<string, unknown>[];

      return rows.map((row) => rowToEvent(row));
    } catch (error) {
      logger.error('Failed to get events by session:', error);
      return [];
    }
  }
}

// Singleton accessor
export function getTelemetryStorage(): TelemetryStorage {
  return TelemetryStorage.getInstance();
}
