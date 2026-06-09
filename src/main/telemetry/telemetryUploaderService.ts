// ============================================================================
// Telemetry Uploader - 把本地会话遥测回传到开发者中央台（Supabase）
// ============================================================================
//
// 设计见 docs/plans/2026-05-28-fleet-observability-plan.md。
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
import type { TelemetryDiagnosticBundleRecord, TelemetryFeedback, TelemetryRendererBundleAttempt, TelemetrySession, TelemetryTurn } from '../../shared/contract/telemetry';

const logger = createLogger('TelemetryUploader');

const DEFAULT_INTERVAL_MS = 5 * 60 * 1000; // 5min，对齐 syncService
const BATCH_SIZE = 200;

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
  private timer: ReturnType<typeof setInterval> | null = null;
  private uploading = false;
  private enabled = true; // 运行时开关（telemetry.cloudUpload.enabled）

  constructor() {
    this.deviceId = getSecureStorage().getDeviceId();
  }

  setEnabled(value: boolean): void {
    this.enabled = value;
  }

  startAutoUpload(intervalMs: number = DEFAULT_INTERVAL_MS): void {
    if (this.timer) return;
    // 立即跑一次（非阻塞），随后定时
    void this.upload().catch((err) => logger.error('Initial telemetry upload failed', err as Error));
    this.timer = setInterval(() => {
      void this.upload().catch((err) => logger.error('Telemetry upload failed', err as Error));
    }, intervalMs);
  }

  stopAutoUpload(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /** 上传一批未同步的已结束会话 + 其 turn（metadata-only）。返回上传的会话数。 */
  async upload(): Promise<number> {
    if (!this.enabled || !isSupabaseInitialized() || this.uploading) return 0;

    const user = getAuthService().getCurrentUser();
    if (!user) return 0; // auth-gated：未登录不传

    this.uploading = true;
    try {
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
          logger.error('Failed to push telemetry_sessions', { error: sessionError });
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
          logger.error('Failed to push telemetry_turns', { error: turnError });
          turnUploadFailed = true;
        }
      }
      if (turnUploadFailed) return 0;

      // 3) 用户显式反馈。它依赖云端已有 session/turn，因此放在 session/turn 后面。
      const feedback = storage.getUnsyncedFeedback(BATCH_SIZE, user.id);
      if (feedback.length > 0) {
        const { error: feedbackError } = await supabase
          .from('telemetry_feedback')
          .upsert(
            feedback.map((item) => this.toFeedbackRow(item, user.id)),
            { onConflict: 'id' },
          );
        if (feedbackError) {
          logger.error('Failed to push telemetry_feedback', { error: feedbackError });
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
          logger.error('Failed to push telemetry_renderer_bundle_attempts', { error: rendererBundleError });
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
          logger.error('Failed to push telemetry_diagnostic_bundles', { error: diagError });
        } else {
          storage.markDiagnosticBundlesSynced(diagBundles.map((b) => b.id), Date.now());
        }
      }

      // 6) 会话和 turn 都写成功后再标记已同步；否则下轮继续补传
      storage.markSessionsSynced(sessions.map((s) => s.id));
      logger.info('Telemetry uploaded', { sessions: sessions.length, turns: turnRows.length, feedback: feedback.length, rendererBundleAttempts: rendererBundleAttempts.length, diagnosticBundles: diagBundles.length });
      return sessions.length;
    } catch (err) {
      logger.error('Telemetry upload error', err as Error);
      return 0;
    } finally {
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

  private toFeedbackRow(f: TelemetryFeedback, userId: string) {
    return {
      id: f.id,
      session_id: f.sessionId,
      turn_id: f.turnId ?? null,
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
