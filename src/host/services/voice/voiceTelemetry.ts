// ============================================================================
// 语音派活/播报的遥测（R5）
//
// #903 只把 workItemId 三元组落进了日志——日志能查单次事故，答不了「进度闸到底吞掉了
// 多少条、吞在哪一格」。这层把同一个三元组接进仓内既有的 telemetry span 基建
// （学 generativeUITelemetry 的接法，不另起子系统）。
//
// 隐私边界与 generativeUI 那层同款，且**更严**：这条链上流动的是用户的活儿名、
// 通话原文和结论摘要，一个字都不许进遥测。所以属性类型只收：
//   - workItemId：`voice-work-<ts>-<rand>` 合成 id，不含任何用户内容；
//   - status / reason / phase：受控词表（union），不是自由文本——遥测那边要按它们分组，
//     一旦允许拼字符串，维度就废了，还会变成内容泄漏的口子。
// title / summary / prompt / 路径一律不在这个类型里，想传也传不进来。
// ============================================================================

import type { VoiceProviderId, VoiceToolCallOrigin, VoiceWorkNarration } from '../../../shared/contract/voice';
import { getTelemetryService } from '../../telemetry/telemetryService';
import { createLogger } from '../infra/logger';

const logger = createLogger('VoiceTelemetry');

/** 一条播报没播出去的原因。受控词表：加一档就在这里加，不许在调用处拼串。 */
export type VoiceNarrationDropReason =
  /** 每件活的进度条数上限 */
  | 'per_work_item_cap'
  /** 首条进度延迟窗内 */
  | 'first_delay_window'
  /** 距上一条进度不足最小间隔 */
  | 'min_interval'
  /** 用户开口，排队的进度当场丢 */
  | 'user_speaking'
  /** 连着两个用户轮都没轮到它 */
  | 'suppressed_two_turns'
  /** 排队超过保质期，播出去说的是过去的事 */
  | 'stale'
  /** 上游拒绝注入，进度不重试 */
  | 'injection_rejected'
  /** 上游拒绝注入且重试次数已用尽 */
  | 'injection_retry_exhausted'
  /** 该形态的 transport 没有注入通道（WebRTC 直连形态尚未实现） */
  | 'no_inject_channel';

/**
 * 看屏采集的三态（Appshots Phase 3）。与 VoiceScreenCaptureFailure 同词表 + 一个成功档。
 * 同样是受控词表，不许在调用处拼串。
 */
export type VoiceScreenCaptureOutcome =
  | 'captured'
  | 'no_permission'
  | 'unsupported_platform'
  | 'capture_failed';

type VoiceWorkEvent =
  /** 一件活派出去了 */
  | { phase: 'dispatch'; workItemId: string }
  /**
   * 通话里采了一次屏幕上下文。**没有 workItemId**——采集发生在派活之前，此刻还没有活；
   * 维度换成 voiceSessionId（`voice-<ts>-<seq>` 合成串，同样不含用户内容）。
   */
  | { phase: 'screen_capture'; voiceSessionId: string; outcome: VoiceScreenCaptureOutcome }
  /** 一条播报真的塞进通话了 */
  | { phase: 'narration_spoken'; workItemId: string; status: VoiceWorkNarration['status']; worthHearing: boolean }
  /** 一条播报被丢了 */
  | {
      phase: 'narration_dropped';
      workItemId: string;
      status: VoiceWorkNarration['status'];
      worthHearing: boolean;
      reason: VoiceNarrationDropReason;
    };

export type VoiceToolCallOutcome = 'accepted' | 'rejected' | 'duplicate';

/** 记一次 response.created 后的轮次悬空接管；字段全是受控标识或数值，不含对话内容。 */
export function recordVoiceWatchdogTakeover(input: {
  provider: VoiceProviderId;
  turn: number;
  responseId: string;
  silenceMs: number;
  thresholdMs: number;
  thresholdSource: 'absolute_floor' | 'rolling_estimate';
  takeoverCount: number;
}): void {
  try {
    const telemetry = getTelemetryService();
    const span = telemetry.startSpan('watchdog_takeover', 'internal', {
      'voice_watchdog.provider': input.provider,
      'voice_watchdog.turn': input.turn,
      'voice_watchdog.response_id': input.responseId,
      'voice_watchdog.silence_ms': input.silenceMs,
      'voice_watchdog.threshold_ms': input.thresholdMs,
      'voice_watchdog.threshold_source': input.thresholdSource,
      'voice_watchdog.takeover_count': input.takeoverCount,
    });
    telemetry.endSpan(span.spanId, 'error');
  } catch (err) {
    logger.warn('voice watchdog telemetry unavailable', { message: err instanceof Error ? err.message : 'unknown' });
  }
}

/**
 * 记录 Realtime 工具通道命中。provider + origin 可直接聚合 fallback 率；
 * toolName 只允许注册工具名，调用方不得传参数或用户文本。
 */
export function recordVoiceToolCall(input: {
  provider: VoiceProviderId;
  origin: VoiceToolCallOrigin;
  toolName: string;
  outcome: VoiceToolCallOutcome;
}): void {
  try {
    const telemetry = getTelemetryService();
    const span = telemetry.startSpan('voice_tool_call', 'internal', {
      'voice_tool.provider': input.provider,
      'voice_tool.origin': input.origin,
      'voice_tool.name': input.toolName,
      'voice_tool.outcome': input.outcome,
    });
    telemetry.endSpan(span.spanId, input.outcome === 'rejected' ? 'error' : 'ok');
  } catch (err) {
    logger.warn('voice tool telemetry unavailable', { message: err instanceof Error ? err.message : 'unknown' });
  }
}

/**
 * 记一次语音工作事件。
 *
 * 整个函数吞异常：遥测是旁路，实时语音是主路。观测坏了该失去的是观测，
 * 不是那句该说给用户听的话——本仓在 milestone 旁路上已经立过同一条规矩。
 */
export function recordVoiceWorkEvent(event: VoiceWorkEvent): void {
  try {
    const telemetry = getTelemetryService();
    const span = telemetry.startSpan('voice_work', 'internal', {
      'voice_work.phase': event.phase,
      ...(event.phase === 'screen_capture'
        ? {
            'voice_work.voice_session_id': event.voiceSessionId,
            'voice_work.capture_outcome': event.outcome,
          }
        : { 'voice_work.work_item_id': event.workItemId }),
      ...(event.phase === 'narration_spoken' || event.phase === 'narration_dropped' ? {
        'voice_work.narration_status': event.status,
        'voice_work.worth_hearing': event.worthHearing,
      } : {}),
      ...(event.phase === 'narration_dropped' ? { 'voice_work.drop_reason': event.reason } : {}),
    });
    telemetry.endSpan(span.spanId, 'ok');
  } catch (err) {
    logger.warn('voice telemetry unavailable', { message: err instanceof Error ? err.message : 'unknown' });
  }
}
