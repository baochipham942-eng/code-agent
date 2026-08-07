// ============================================================================
// Telemetry Uploader - 把本地会话遥测回传到开发者中央台（Supabase）
// ============================================================================
//
// 设计见 内部文档。
// 复用 syncService 模式：客户端以登录用户身份直连 supabase-js 写自己的行，RLS 管控
// （用户只能写自己、只有 admin 能读）。上传 auth-gated：未登录不传。
//
// 隐私红线：默认只传 metadata（模型/延迟/token/报错码/工具名）。
//   - turn 的 payload 不含 prompt/completion/工具入参或返回内容；报错串经 scrubString 脱敏。
//   - 完整 prompt/completion 仅在用户 👎/报障时随 feedback 上传（P1d，另行实现）。
//
// ============================================================================

import os from 'os';
import type { SupabaseClient } from '@supabase/supabase-js';
import { getSupabase, isSupabaseInitialized } from '../services/infra';
import { getAuthService } from '../services/auth';
import { getSecureStorage } from '../services/core';
import { createLogger } from '../services/infra/logger';
import { Disposable, getServiceRegistry } from '../services/serviceRegistry';
import { app } from '../platform';
import { getTelemetryStorage } from './telemetryStorage';
import { scrubString } from '../../shared/observability/scrubEvent';
import { TELEMETRY_UPLOAD_RESILIENCE } from '../../shared/constants';
import type { TelemetryDiagnosticBundleRecord, TelemetryFeedback, TelemetryRendererBundleAttempt, TelemetrySession, TelemetryTurn } from '../../shared/contract/telemetry';

const logger = createLogger('TelemetryUploader');

const BATCH_SIZE = 200;
const MAX_UPLOAD_ERROR_LENGTH = 500;

/**
 * Postgres/PostgREST 错误码中「重试到天荒地老也不会自愈」的一类：策略/权限类拒绝。
 * 42501 = insufficient_privilege（含 RLS WITH CHECK 拒绝）——需要服务端策略/schema 修好，
 * 不是客户端换个时机重试就能过。命中后立即熔断（阈值降到 1），不必等 N 次积累。
 */
const NON_RETRYABLE_POSTGREST_CODES = new Set(['42501']);

function getPostgrestErrorCode(error: unknown): string | null {
  if (error && typeof error === 'object' && 'code' in error) {
    const code = (error as { code?: unknown }).code;
    return typeof code === 'string' ? code : null;
  }
  return null;
}

export interface TelemetryUploadHealth {
  lastUploadAt: number | null;
  lastUploadError: string | null;
  lastUploadErrorAt: number | null;
  uploadFailureCount: number;
}

function summarizeUploadError(scope: string, error: unknown): string {
  let detail: string;
  if (error instanceof Error) {
    detail = error.message;
  } else if (typeof error === 'string') {
    detail = error;
  } else {
    try {
      detail = JSON.stringify(error);
    } catch {
      detail = String(error);
    }
  }
  return `${scope}: ${scrubString(detail || 'unknown upload error', { homeDir: os.homedir() })}`
    .slice(0, MAX_UPLOAD_ERROR_LENGTH);
}

function getAppVersion(): string | null {
  try {
    const fn = (app as { getVersion?: () => string }).getVersion;
    return typeof fn === 'function' ? fn.call(app) : null;
  } catch {
    return null;
  }
}

export class TelemetryUploaderService implements Disposable {
  private deviceId: string;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private uploadEpoch = 0; // startAutoUpload() 每次递增，防止 stop 后又 start 时旧调度链复活
  private uploading = false;
  private enabled = true; // 运行时开关（telemetry.cloudUpload.enabled）
  private authSkipLogged = false; // 2a(ADR-030): auth-gated skip 只记一次，避免每 5min 刷日志
  private uploadHealth: TelemetryUploadHealth = {
    lastUploadAt: null,
    lastUploadError: null,
    lastUploadErrorAt: null,
    uploadFailureCount: 0,
  };

  // T5(2026-08-07) 指数退避 + 熔断状态：见 TELEMETRY_UPLOAD_RESILIENCE 注释
  private currentIntervalMs: number = TELEMETRY_UPLOAD_RESILIENCE.BASE_INTERVAL_MS;
  private lastFailureSignature: string | null = null;
  private consecutiveSameFailureCount = 0;
  private circuitBreakerTrippedSignature: string | null = null;
  // 当前这轮 upload() 是否失败过、失败签名是什么——upload() 开头重置，finally 里结算
  private roundFailureSignature: string | null = null;
  private roundFailureIsNonRetryable = false;

  constructor() {
    this.deviceId = getSecureStorage().getDeviceId();
  }

  setEnabled(value: boolean): void {
    this.enabled = value;
  }

  getUploadHealth(): TelemetryUploadHealth {
    return { ...this.uploadHealth };
  }

  private recordUploadFailure(scope: string, error: unknown, options: { skipErrorLog?: boolean } = {}): void {
    const code = getPostgrestErrorCode(error);
    const signature = `${scope}:${code ?? 'unknown'}`;
    this.roundFailureSignature = signature;
    this.roundFailureIsNonRetryable = code !== null && NON_RETRYABLE_POSTGREST_CODES.has(code);

    this.uploadHealth.lastUploadError = summarizeUploadError(scope, error);
    this.uploadHealth.lastUploadErrorAt = Date.now();
    this.uploadHealth.uploadFailureCount += 1;

    if (options.skipErrorLog) return; // 调用方（如顶层 catch）已经自己打过日志

    // 熔断已对这个签名生效：不再逐条打 ERROR 刷屏，健康状态仍照常记录。
    if (this.circuitBreakerTrippedSignature === signature) {
      logger.debug(`Telemetry upload still failing (circuit breaker active): ${signature}`);
    } else {
      logger.error(`Failed to push ${scope}`, { error });
    }
  }

  /**
   * 每轮 upload() 收尾时结算退避/熔断状态：
   * - 本轮无失败 → 重置回基础间隔
   * - 本轮失败且与上轮同因 → 计数 +1，间隔按 BACKOFF_FACTOR 指数增长（封顶 MAX_INTERVAL_MS）
   * - 42501 这类不可重试错误一次就熔断（阈值 1），其余错误容忍 CIRCUIT_BREAKER_THRESHOLD 次抖动
   * 熔断只降频 + 降噪，不永久停用：服务端一旦修好，同进程会在下一次（更长的）间隔后自愈。
   */
  private updateResilienceState(): void {
    const { BASE_INTERVAL_MS, BACKOFF_FACTOR, MAX_INTERVAL_MS, CIRCUIT_BREAKER_THRESHOLD } = TELEMETRY_UPLOAD_RESILIENCE;

    if (!this.roundFailureSignature) {
      if (this.consecutiveSameFailureCount > 0) {
        logger.info('Telemetry upload recovered, backoff reset', {
          previousFailureCount: this.consecutiveSameFailureCount,
          previousSignature: this.lastFailureSignature,
        });
      }
      this.currentIntervalMs = BASE_INTERVAL_MS;
      this.consecutiveSameFailureCount = 0;
      this.lastFailureSignature = null;
      this.circuitBreakerTrippedSignature = null;
      return;
    }

    const signature = this.roundFailureSignature;
    if (signature === this.lastFailureSignature) {
      this.consecutiveSameFailureCount += 1;
    } else {
      this.lastFailureSignature = signature;
      this.consecutiveSameFailureCount = 1;
      this.circuitBreakerTrippedSignature = null;
    }

    this.currentIntervalMs = Math.min(
      MAX_INTERVAL_MS,
      BASE_INTERVAL_MS * BACKOFF_FACTOR ** Math.max(0, this.consecutiveSameFailureCount - 1),
    );

    const threshold = this.roundFailureIsNonRetryable ? 1 : CIRCUIT_BREAKER_THRESHOLD;
    if (this.consecutiveSameFailureCount >= threshold && this.circuitBreakerTrippedSignature !== signature) {
      this.circuitBreakerTrippedSignature = signature;
      logger.warn(
        `Telemetry upload circuit breaker tripped: ${this.consecutiveSameFailureCount} 次连续同因失败（${signature}），` +
        `已降频至每 ${Math.round(this.currentIntervalMs / 1000)}s 重试一次，同因失败不再逐条打印错误日志，直到恢复或换因。`,
      );
    }
  }

  startAutoUpload(intervalMs: number = TELEMETRY_UPLOAD_RESILIENCE.BASE_INTERVAL_MS): void {
    if (this.timer) return;
    this.currentIntervalMs = intervalMs;
    this.uploadEpoch += 1;
    this.scheduleNext(0, this.uploadEpoch);
  }

  /** 自调度链：每轮跑完根据退避状态决定下一次延迟，而非固定 setInterval。 */
  private scheduleNext(delayMs: number, epoch: number): void {
    this.timer = setTimeout(() => {
      void this.upload()
        .catch((err) => logger.error('Telemetry upload failed', err as Error))
        .finally(() => {
          // stopAutoUpload() 期间（this.timer === null）或期间又被重新 start（epoch 变了）都不再续期，
          // 防止旧调度链和新调度链并存导致上传频率翻倍。
          if (this.timer === null || epoch !== this.uploadEpoch) return;
          this.scheduleNext(this.currentIntervalMs, epoch);
        });
    }, delayMs);
  }

  stopAutoUpload(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  /** 上传一批未同步的已结束会话 + 其 turn（metadata-only）。返回上传的会话数。 */
  async upload(): Promise<number> {
    if (!this.enabled || !isSupabaseInitialized() || this.uploading) return 0;

    const user = getAuthService().getCurrentUser();
    if (!user) {
      // auth-gated：未登录不传。落一条可观测日志（缺口2/ADR-030）：让"为什么没上传"可见，
      // 不再靠人肉 SQL 反推。只在状态翻转时记一次，避免 5min 周期刷屏。
      if (!this.authSkipLogged) {
        logger.warn('Telemetry upload skipped: 无活跃登录会话（auth-gated）。本地遥测将积压，登录后自动补传。');
        this.authSkipLogged = true;
      }
      return 0;
    }
    this.authSkipLogged = false;

    this.uploading = true;
    this.roundFailureSignature = null;
    this.roundFailureIsNonRetryable = false;
    try {
      let uploadFailed = false;
      const storage = getTelemetryStorage();
      const sessions = storage
        .getUnsyncedSessions(BATCH_SIZE)
        .filter((s) => !s.userId || s.userId === user.id);

      // 新表不在生成的 Database 类型里，用未类型化 client 写入
      const supabase = getSupabase() as unknown as SupabaseClient;
      const homeDir = os.homedir();
      const appVersion = getAppVersion();

      // 1) 会话级
      if (sessions.length > 0) {
        const { error: sessionError } = await supabase
          .from('telemetry_sessions')
          .upsert(
            sessions.map((s) => this.toSessionRow(s, user.id, appVersion)),
            { onConflict: 'id' },
          );
        if (sessionError) {
          this.recordUploadFailure('telemetry_sessions', sessionError);
          return 0; // 会话没写成功就不标记已同步，下轮重试
        }
      }

      // 2) Turn 级（metadata-only），分批
      // getTurnsBySession 出来的 turn 不带 modelCalls/toolCalls（明细在独立表里，rowToTurn 恒为空数组），
      // 上传前必须用 getTurnCalls 补齐，否则云端 payload 全空，admin 无法下钻报错根因。
      const turnRows = sessions.flatMap((s) =>
        storage.getTurnsBySession(s.id).map((t) => {
          const { modelCalls, toolCalls } = storage.getTurnCalls(t.id);
          return this.toTurnRow({ ...t, modelCalls, toolCalls }, s.id, user.id, homeDir);
        }),
      );
      let turnUploadFailed = false;
      for (let i = 0; i < turnRows.length; i += BATCH_SIZE) {
        const { error: turnError } = await supabase
          .from('telemetry_turns')
          .upsert(turnRows.slice(i, i + BATCH_SIZE), { onConflict: 'id' });
        if (turnError) {
          this.recordUploadFailure('telemetry_turns', turnError);
          turnUploadFailed = true;
          uploadFailed = true;
        }
      }
      if (turnUploadFailed) return 0;

      // 3) 用户显式反馈。它依赖云端已有 session/turn，因此放在 session/turn 后面。
      const feedback = storage.getUnsyncedFeedback(BATCH_SIZE, user.id);
      if (feedback.length > 0) {
        // UI 的 messageId 只负责本地定位，不保证等于 telemetry_turns.id。
        // 不存在的 turn_id 会被 owns_telemetry_turn RLS 正确拒绝（42501），
        // 因此只有本地账本能证明存在时才上传 turn 外键。
        const { error: feedbackError } = await supabase
          .from('telemetry_feedback')
          .upsert(
            feedback.map((item) => {
              const turnDetail = item.turnId ? storage.getTurnDetail(item.turnId) : null;
              const turnId = turnDetail?.turn.sessionId === item.sessionId ? item.turnId ?? null : null;
              return this.toFeedbackRow(item, user.id, turnId);
            }),
            { onConflict: 'id' },
          );
        if (feedbackError) {
          this.recordUploadFailure('telemetry_feedback', feedbackError);
          uploadFailed = true;
        } else {
          storage.markFeedbackSynced(feedback.map((item) => item.id));
        }
      }

      // 4) 系统级 renderer hot-update attempt。它不依赖 session/turn，表缺失或写失败
      // 只影响这批事件的 retry，不反向阻塞 chat telemetry。
      const rendererBundleAttempts = storage.getUnsyncedRendererBundleAttempts(BATCH_SIZE);
      if (rendererBundleAttempts.length > 0) {
        const { error: rendererBundleError } = await supabase
          .from('telemetry_renderer_bundle_attempts')
          .upsert(
            rendererBundleAttempts.map((item) => this.toRendererBundleAttemptRow(item, user.id, appVersion)),
            { onConflict: 'id' },
          );
        if (rendererBundleError) {
          this.recordUploadFailure('telemetry_renderer_bundle_attempts', rendererBundleError);
          uploadFailed = true;
        } else {
          storage.markRendererBundleAttemptsSynced(rendererBundleAttempts.map((item) => item.id));
        }
      }

      // 5) 诊断包(脱敏全量,失败 session 触发)。已在入队时脱敏,不依赖云端 session/turn 行,独立 retry。
      const diagBundles = storage.getUnsyncedDiagnosticBundles(BATCH_SIZE);
      if (diagBundles.length > 0) {
        const { error: diagError } = await supabase
          .from('telemetry_diagnostic_bundles')
          .upsert(
            diagBundles.map((b) => this.toDiagnosticBundleRow(b, user.id, appVersion)),
            { onConflict: 'id' },
          );
        if (diagError) {
          this.recordUploadFailure('telemetry_diagnostic_bundles', diagError);
          uploadFailed = true;
        } else {
          storage.markDiagnosticBundlesSynced(diagBundles.map((b) => b.id), Date.now());
        }
      }

      // 6) 会话和 turn 都写成功后再标记已同步；否则下轮继续补传
      storage.markSessionsSynced(sessions.map((s) => s.id));
      if (!uploadFailed) {
        this.uploadHealth.lastUploadAt = Date.now();
      }
      logger.info('Telemetry uploaded', { sessions: sessions.length, turns: turnRows.length, feedback: feedback.length, rendererBundleAttempts: rendererBundleAttempts.length, diagnosticBundles: diagBundles.length });
      return sessions.length;
    } catch (err) {
      logger.error('Telemetry upload error', err as Error);
      this.recordUploadFailure('telemetry_upload', err, { skipErrorLog: true });
      return 0;
    } finally {
      this.updateResilienceState();
      this.uploading = false;
    }
  }

  private toSessionRow(s: TelemetrySession, userId: string, appVersion: string | null) {
    return {
      id: s.id,
      user_id: userId,
      device_id: this.deviceId,
      app_version: appVersion,
      model_provider: s.modelProvider,
      model_name: s.modelName,
      session_type: s.sessionType ?? null,
      status: s.status,
      start_time: s.startTime,
      end_time: s.endTime ?? null,
      duration_ms: s.durationMs ?? null,
      turn_count: s.turnCount,
      total_input_tokens: s.totalInputTokens,
      total_output_tokens: s.totalOutputTokens,
      total_tokens: s.totalTokens,
      estimated_cost: s.estimatedCost,
      total_tool_calls: s.totalToolCalls,
      tool_success_rate: s.toolSuccessRate,
      total_errors: s.totalErrors,
    };
  }

  private toDiagnosticBundleRow(b: TelemetryDiagnosticBundleRecord, userId: string, appVersion: string | null) {
    // bundle 入队时已脱敏;JSON.parse 还原成对象写入 JSONB 列(而非引号串)
    const bundle: unknown = ((): unknown => {
      try {
        return JSON.parse(b.bundle);
      } catch {
        return { _parseError: true, raw: b.bundle.slice(0, 2000) };
      }
    })();
    return {
      id: b.id,
      user_id: userId,
      device_id: this.deviceId,
      app_version: appVersion,
      session_id: b.sessionId,
      agent_version: b.agentVersion ?? null,
      prompt_version: b.promptVersion ?? null,
      tool_schema_version: b.toolSchemaVersion ?? null,
      trigger_reason: b.triggerReason,
      bundle_version: b.bundleVersion,
      built_at: b.builtAt,
      bundle,
    };
  }

  private toTurnRow(t: TelemetryTurn, sessionId: string, userId: string, homeDir: string) {
    // metadata-only：不含 prompt/completion/userPrompt/assistantResponse/工具入参或返回内容
    const payload = {
      modelCalls: t.modelCalls.map((m) => ({
        provider: m.provider,
        model: m.model,
        latencyMs: m.latencyMs,
        inputTokens: m.inputTokens,
        outputTokens: m.outputTokens,
        responseType: m.responseType,
        fallbackUsed: m.fallbackUsed,
        error: m.error ? scrubString(m.error, { homeDir }) : undefined,
      })),
      toolCalls: t.toolCalls.map((c) => ({
        name: c.name,
        success: c.success,
        errorCategory: c.errorCategory,
        durationMs: c.durationMs,
        error: c.error ? scrubString(c.error, { homeDir }) : undefined,
      })),
    };
    return {
      id: t.id,
      session_id: sessionId,
      user_id: userId,
      turn_number: t.turnNumber,
      turn_type: t.turnType,
      agent_id: t.agentId ?? null,
      intent: t.intent?.primary ?? null,
      outcome_status: t.outcome?.status ?? null,
      duration_ms: t.durationMs,
      total_input_tokens: t.totalInputTokens,
      total_output_tokens: t.totalOutputTokens,
      tool_call_count: t.toolCalls.length,
      error_count: t.outcome?.signals?.errorCount ?? 0,
      payload,
    };
  }

  private toFeedbackRow(f: TelemetryFeedback, userId: string, turnId: string | null) {
    return {
      id: f.id,
      session_id: f.sessionId,
      turn_id: turnId,
      user_id: userId,
      rating: f.rating,
      comment: f.comment ?? null,
      full_content: f.rating === -1 ? (f.fullContent ?? null) : null,
      created_at: f.createdAt,
    };
  }

  private toRendererBundleAttemptRow(a: TelemetryRendererBundleAttempt, userId: string, appVersion: string | null) {
    return {
      id: a.id,
      user_id: userId,
      device_id: this.deviceId,
      app_version: appVersion,
      checked_at: a.checkedAt,
      manifest_url: a.manifestUrl,
      source_channel: a.sourceChannel ?? null,
      source_manifest_url_override: a.sourceManifestUrlOverride,
      source_error_reason: a.sourceErrorReason ?? null,
      source_error_message: a.sourceErrorMessage ? scrubString(a.sourceErrorMessage, { homeDir: os.homedir() }) : null,
      source_error_target: a.sourceErrorTarget ?? null,
      current_shell_version: a.currentShellVersion,
      active_version: a.activeVersion ?? null,
      active_content_hash: a.activeContentHash ?? null,
      outcome: a.outcome,
      reason: a.reason ?? null,
      manifest_version: a.manifestVersion ?? null,
      manifest_content_hash: a.manifestContentHash ?? null,
      manifest_min_shell_version: a.manifestMinShellVersion ?? null,
      manifest_bundle_url: a.manifestBundleUrl ?? null,
      required_shell_capabilities_count: a.requiredShellCapabilitiesCount,
      rollback_to_builtin: a.rollbackToBuiltin,
      rollback_reason: a.rollbackReason ?? null,
      missing_shell_capabilities: a.missingShellCapabilities,
      missing_runtime_assets: a.missingRuntimeAssets,
      missing_resources: a.missingResources,
      diagnostics: a.diagnostics,
      error_message: a.errorMessage ? scrubString(a.errorMessage, { homeDir: os.homedir() }) : null,
    };
  }

  async dispose(): Promise<void> {
    this.stopAutoUpload();
  }
}

let instance: TelemetryUploaderService | null = null;

export function getTelemetryUploaderService(): TelemetryUploaderService {
  if (!instance) {
    instance = new TelemetryUploaderService();
    getServiceRegistry().register('TelemetryUploaderService', instance);
  }
  return instance;
}
