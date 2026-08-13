// ============================================================================
// 通用 Realtime transport（OpenAI Realtime 协议族，Host WebSocket relay）
//
// Host 持 API key 建 WS，音频帧只在内存中转，不落盘、不进日志。
// Provider 差异集中在 profile；DashScope 保留旧协议形状，OpenAI 使用当前嵌套 audio schema。
// ============================================================================

import WebSocket from 'ws';
import {
  VOICE_INJECTION_ACK_WINDOW_MS,
  VOICE_UPSTREAM_CONNECT_TIMEOUT_MS,
  VOICE_UPSTREAM_HEARTBEAT_INTERVAL_MS,
  VOICE_UPSTREAM_RESPONSE_SILENCE_DEGRADED_FACTOR,
  VOICE_UPSTREAM_RESPONSE_SILENCE_MIN_TIMEOUT_MS,
  VOICE_UPSTREAM_RESPONSE_SILENCE_MULTIPLIER,
  VOICE_UPSTREAM_RESPONSE_SILENCE_SAMPLE_WINDOW,
  VOICE_UPSTREAM_RESPONSE_TIMEOUT_MS,
  VOICE_UPSTREAM_SILENCE_TIMEOUT_MS,
} from '../../../shared/constants/voice';
import type { RealtimeVoiceProviderProfile } from '../../../shared/constants/realtimeVoiceProviders';
import type {
  VoiceToolCallOrigin,
  VoiceTokenUsage,
  VoiceTransport,
  VoiceTransportHandle,
  VoiceTurnDetectionConfig,
} from '../../../shared/contract/voice';
import { parseResponseUsage } from './realtimeUsage';
import {
  parseEvent,
  resolveUpstreamUrlOverride,
  responseIdOf,
  upstreamAcceptedTools,
  type UpstreamEvent,
} from './realtimeUpstream';
import {
  buildSessionUpdate,
  resolveTurnDetectionConfig,
  toUpstreamTurnDetection,
} from './realtimeSessionConfig';
import { createLogger } from '../infra/logger';
import { getHttpsAgent } from '../../model/providers/providerHttp';
import { recordVoiceToolCall, recordVoiceWatchdogTakeover } from './voiceTelemetry';
import {
  mayBeVoiceXmlFallback,
  parseVoiceXmlToolFallback,
  validateVoiceToolArguments,
} from './voiceXmlToolFallback';

const logger = createLogger('RealtimeVoice');
const RESPONSE_IDLE_TIMEOUT_CODE = 'response_idle_timeout';
// Realtime 协议族的 provider 不保证必发 session.updated；超时降级是预期路径，不是建连失败。
const INITIAL_SESSION_HANDSHAKE_TIMEOUT_MS = 8_000;



function resolveProxyAgent(profile: RealtimeVoiceProviderProfile, url: string) {
  if (!profile.needsProxy) return undefined;
  // Built-in providers retain their provider-level direct/proxy override.
  // Custom realtime IDs are not part of the model-provider registry, so passing
  // their ID would classify them as direct. Let the target URL and global proxy
  // settings decide instead.
  return profile.id === 'openai-realtime'
    ? getHttpsAgent(url, profile.keyProvider)
    : getHttpsAgent(url);
}

/** Renderer/原生采集链固定给 16k PCM16；OpenAI 当前 Realtime WS 要求 24k。 */
export function resamplePcm16Mono(frame: Buffer, fromRate: number, toRate: number): Buffer {
  if (fromRate === toRate || frame.byteLength < 4) return frame;
  const input = new Int16Array(frame.buffer, frame.byteOffset, Math.floor(frame.byteLength / 2));
  const outputLength = Math.max(1, Math.round(input.length * toRate / fromRate));
  const output = Buffer.allocUnsafe(outputLength * 2);
  for (let index = 0; index < outputLength; index += 1) {
    const source = index * fromRate / toRate;
    const leftIndex = Math.min(input.length - 1, Math.floor(source));
    const rightIndex = Math.min(input.length - 1, leftIndex + 1);
    const weight = source - leftIndex;
    const sample = Math.round(input[leftIndex] * (1 - weight) + input[rightIndex] * weight);
    output.writeInt16LE(Math.max(-32768, Math.min(32767, sample)), index * 2);
  }
  return output;
}

export function createRealtimeTransport(profile: RealtimeVoiceProviderProfile): VoiceTransport {
  return {
  id: profile.id,

  async connect({ apiKey, config, onEvent, onAudio, onToolCall }): Promise<VoiceTransportHandle> {
    const model = config.model ?? profile.defaultModel;
    const turnDetectionConfig = resolveTurnDetectionConfig();
    const upstreamTurnDetection = toUpstreamTurnDetection(turnDetectionConfig);
    const vadSilenceWindowMs = turnDetectionConfig?.type === 'server_vad'
      ? turnDetectionConfig.silenceDurationMs
      : undefined;
    const registeredTools = onToolCall ? config.tools ?? [] : [];
    const url = resolveUpstreamUrlOverride(profile.wsUrl(model));
    logger.info('connecting upstream', {
      provider: profile.id,
      model,
      toolCount: registeredTools.length,
      // 「说了没反应」的头号嫌疑就是这个值（null = 手动档，上游等 commit 才回话）。
      // 此前它完全不可见，真机只能靠猜——2026-07-27 真机踩到。
      turnDetection: upstreamTurnDetection === null ? 'null(manual)' : upstreamTurnDetection.type,
      turnDetectionRaw: JSON.stringify(upstreamTurnDetection),
    });

    const ws = new WebSocket(url, {
      headers: { Authorization: `Bearer ${apiKey}` },
      ...(profile.needsProxy ? { agent: resolveProxyAgent(profile, url) } : {}),
    });

    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        ws.terminate();
        reject(new Error('VOICE_UPSTREAM_CONNECT_TIMEOUT'));
      }, VOICE_UPSTREAM_CONNECT_TIMEOUT_MS);
      ws.once('open', () => {
        clearTimeout(timer);
        resolve();
      });
      ws.once('error', (err: Error) => {
        clearTimeout(timer);
        reject(err);
      });
    });

    let lastUpstreamSignalAt = Date.now();
    let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
    const clearHeartbeat = () => {
      if (!heartbeatTimer) return;
      clearInterval(heartbeatTimer);
      heartbeatTimer = null;
    };
    const markUpstreamSignal = () => {
      lastUpstreamSignalAt = Date.now();
    };

    ws.on('pong', markUpstreamSignal);
    heartbeatTimer = setInterval(() => {
      if (ws.readyState !== WebSocket.OPEN) {
        clearHeartbeat();
        return;
      }
      const silenceMs = Date.now() - lastUpstreamSignalAt;
      if (silenceMs >= VOICE_UPSTREAM_SILENCE_TIMEOUT_MS) {
        clearHeartbeat();
        // missedBeats 是判因用的：1 拍 = 丢包/迟到，连丢三拍才是这条链真死了。
        logger.warn('upstream heartbeat timed out', {
          silenceMs,
          missedBeats: Math.floor(silenceMs / VOICE_UPSTREAM_HEARTBEAT_INTERVAL_MS),
        });
        onEvent({
          type: 'error',
          code: 'UPSTREAM_ERROR',
          message: '上游连接已断开（长时间无响应）',
        });
        ws.terminate();
        return;
      }
      ws.ping();
    }, VOICE_UPSTREAM_HEARTBEAT_INTERVAL_MS);

    const initialSessionUpdate = buildSessionUpdate(profile, {
      model,
      voice: config.voice ?? profile.defaultVoice,
      instructions: config.instructions,
      // 没接执行出口就不注册工具：告诉模型有工具却没人执行，比不给工具更糟。
      tools: registeredTools,
      turnDetection: upstreamTurnDetection,
    });

    // TTFA 模型口径从上游 speech_stopped 开始；体感口径不是实测值，
    // 是按 server_vad 先等待 silence_duration_ms 才发 speech_stopped 这一机制推算。
    /** item_id → 该轮到目前为止的用户字幕（delta 的 stash 是累计值）。completed 到货即清。 */
    const userTranscriptStash = new Map<string, string>();
    let speechStoppedAt = 0;
    let ttfaModelMs: number | undefined;
    let ttfaPerceivedMs: number | undefined;
    let activeResponseId = '';
    const responseItemIds = new Map<string, string>();
    const cancellingResponseIds = new Set<string>();
    const watchdogCancelledResponseIds = new Set<string>();
    // 每发一次看门狗 cancel，允许吞一次上游的「none active response」良性回声；
    // 与上面集合分开——那个还要给 stale done 隔离用，不能被吞错消费掉。
    let watchdogCancelBenignErrorBudget = 0;
    const cancellingResponseItemIds = new Map<string, string>();
    let responseCreateQueued = false;
    let responseCreateInFlight = false;
    let queuedResponseInstructions = '';
    let sentResponseInstructions = '';
    let queuedResponseToolChoice: 'auto' | 'required' = 'auto';
    let sentResponseToolChoice: 'auto' | 'required' = 'auto';
    let sessionToolChoice: 'auto' | 'required' = 'auto';
    let pendingInjectionAt: number | null = null;
    let pendingInjectionNarrationId: string | undefined;
    let pendingInjectionToken = 0;
    let injectionSequence = 0;
    let pendingInjectionAck: {
      resolve: () => void;
      reject: (error: Error) => void;
      timer: ReturnType<typeof setTimeout>;
    } | null = null;
    let responseWatchdogTimer: ReturnType<typeof setTimeout> | null = null;
    let responseWatchdogNudged = false;
    let responseProgressWatchdogTimer: ReturnType<typeof setTimeout> | null = null;
    let responseProgressResponseId = '';
    let responseProgressCreatedAt = 0;
    let responseProgressLastSignalAt = 0;
    let responseTakeoverUsed = false;
    let responseTakeoverPending = false;
    let responseWatchdogTakeoverCount = 0;
    let responseWatchdogHealthScore = 0;
    let serviceUnstableNotified = false;
    const responseProgressSamplesMs: number[] = [];
    let modelUnresponsiveNotified = false;
    let speechStartedAt = 0;
    let currentCandidateId = '';
    const heldXmlResponses = new Map<string, { audio: Buffer[]; transcript: string; itemId?: string }>();
    const unclassifiedAudioByResponse = new Map<string, Buffer[]>();
    const pendingXmlCalls = new Map<string, { name: string; arguments: string }>();
    const toolOriginByResponse = new Map<string, VoiceToolCallOrigin>();
    let xmlFallbackSequence = 0;

    const updateSessionToolChoice = (toolChoice: 'auto' | 'required') => {
      if (ws.readyState !== WebSocket.OPEN || sessionToolChoice === toolChoice) return;
      sessionToolChoice = toolChoice;
      ws.send(JSON.stringify({
        type: 'session.update',
        session: { tool_choice: toolChoice },
      }));
    };

    const clearResponseWatchdog = () => {
      if (responseWatchdogTimer) clearTimeout(responseWatchdogTimer);
      responseWatchdogTimer = null;
      responseWatchdogNudged = false;
    };
    const clearResponseProgressWatchdog = (resetTakeover = true) => {
      if (responseProgressWatchdogTimer) clearTimeout(responseProgressWatchdogTimer);
      responseProgressWatchdogTimer = null;
      responseProgressResponseId = '';
      responseProgressCreatedAt = 0;
      responseProgressLastSignalAt = 0;
      if (resetTakeover) {
        responseTakeoverUsed = false;
        responseTakeoverPending = false;
      }
    };
    const clearAllResponseWatchdogs = () => {
      clearResponseWatchdog();
      clearResponseProgressWatchdog();
    };
    const responseSilenceThreshold = (): {
      timeoutMs: number;
      source: 'absolute_floor' | 'rolling_estimate';
      degraded: boolean;
    } => {
      const rollingTimeoutMs = responseProgressSamplesMs.length
        ? Math.max(...responseProgressSamplesMs) * VOICE_UPSTREAM_RESPONSE_SILENCE_MULTIPLIER
        : 0;
      const source = rollingTimeoutMs > VOICE_UPSTREAM_RESPONSE_SILENCE_MIN_TIMEOUT_MS
        ? 'rolling_estimate' as const
        : 'absolute_floor' as const;
      const baselineMs = Math.max(VOICE_UPSTREAM_RESPONSE_SILENCE_MIN_TIMEOUT_MS, rollingTimeoutMs);
      const degraded = responseWatchdogTakeoverCount >= 2;
      return {
        timeoutMs: degraded
          ? Math.max(
              VOICE_UPSTREAM_RESPONSE_SILENCE_MIN_TIMEOUT_MS,
              Math.round(baselineMs * VOICE_UPSTREAM_RESPONSE_SILENCE_DEGRADED_FACTOR),
            )
          : baselineMs,
        source,
        degraded,
      };
    };
    const notifyModelUnresponsive = (detail: Record<string, unknown>) => {
      if (modelUnresponsiveNotified) return;
      modelUnresponsiveNotified = true;
      onEvent({
        type: 'notice',
        code: 'VOICE_MODEL_UNRESPONSIVE',
        message: '模型没有回应，可以再说一遍，或挂断重拨',
        detail: JSON.stringify(detail),
      });
    };
    const notifyServiceUnstable = (detail: Record<string, unknown>) => {
      if (serviceUnstableNotified) return;
      serviceUnstableNotified = true;
      onEvent({
        type: 'notice',
        code: 'VOICE_SERVICE_UNSTABLE',
        message: '当前语音服务不稳定，我会继续尝试恢复',
        detail: JSON.stringify(detail),
      });
    };
    const scheduleResponseProgressWatchdog = () => {
      if (responseProgressWatchdogTimer) clearTimeout(responseProgressWatchdogTimer);
      const threshold = responseSilenceThreshold();
      responseProgressWatchdogTimer = setTimeout(() => {
        responseProgressWatchdogTimer = null;
        if (ws.readyState !== WebSocket.OPEN || !responseProgressLastSignalAt) return;
        const silenceMs = Date.now() - responseProgressLastSignalAt;
        const detail = {
          turn,
          responseId: responseProgressResponseId || 'pending-rebuild',
          silenceMs,
          thresholdMs: threshold.timeoutMs,
          thresholdSource: threshold.source,
          degraded: threshold.degraded,
        };
        if (!responseTakeoverUsed) {
          responseTakeoverUsed = true;
          responseTakeoverPending = true;
          responseWatchdogTakeoverCount += 1;
          logger.warn('upstream response watchdog taking over stalled turn', {
            ...detail,
            takeoverCount: responseWatchdogTakeoverCount,
          });
          recordVoiceWatchdogTakeover({
            provider: profile.id,
            turn,
            responseId: detail.responseId,
            silenceMs,
            thresholdMs: threshold.timeoutMs,
            thresholdSource: threshold.source,
            takeoverCount: responseWatchdogTakeoverCount,
          });
          if (responseWatchdogTakeoverCount >= 2) {
            notifyServiceUnstable({ ...detail, takeoverCount: responseWatchdogTakeoverCount });
          }
          if (responseProgressResponseId) watchdogCancelledResponseIds.add(responseProgressResponseId);
          watchdogCancelBenignErrorBudget += 1;
          ws.send(JSON.stringify({ type: 'response.cancel' }));
          ws.send(JSON.stringify({
            type: 'response.create',
            ...(sentResponseInstructions
              ? { response: { instructions: sentResponseInstructions } }
              : {}),
          }));
          activeResponseId = '';
          responseCreateInFlight = true;
          responseProgressLastSignalAt = Date.now();
          scheduleResponseProgressWatchdog();
          return;
        }
        responseWatchdogHealthScore -= 1;
        responseCreateInFlight = false;
        activeResponseId = '';
        responseTakeoverPending = false;
        logger.warn('upstream response watchdog rebuild still silent', {
          ...detail,
          healthScore: responseWatchdogHealthScore,
          takeoverCount: responseWatchdogTakeoverCount,
        });
        notifyModelUnresponsive({
          ...detail,
          healthScore: responseWatchdogHealthScore,
          takeoverCount: responseWatchdogTakeoverCount,
        });
      }, threshold.timeoutMs);
    };
    const armResponseProgressWatchdog = (responseId: string) => {
      responseProgressResponseId = responseId;
      responseProgressCreatedAt = Date.now();
      responseProgressLastSignalAt = responseProgressCreatedAt;
      scheduleResponseProgressWatchdog();
    };
    const feedResponseProgressWatchdog = (responseId: string) => {
      if (!responseProgressWatchdogTimer || !responseId || responseId !== responseProgressResponseId) return;
      const now = Date.now();
      const previousAt = responseProgressLastSignalAt || responseProgressCreatedAt;
      const intervalMs = previousAt ? now - previousAt : 0;
      if (intervalMs > 0) {
        responseProgressSamplesMs.push(intervalMs);
        if (responseProgressSamplesMs.length > VOICE_UPSTREAM_RESPONSE_SILENCE_SAMPLE_WINDOW) {
          responseProgressSamplesMs.shift();
        }
      }
      responseProgressLastSignalAt = now;
      if (responseTakeoverPending) {
        responseTakeoverPending = false;
        const threshold = responseSilenceThreshold();
        logger.info('upstream response watchdog rebuild recovered', {
          turn,
          responseId,
          silenceMs: intervalMs,
          thresholdMs: threshold.timeoutMs,
          thresholdSource: threshold.source,
        });
      }
      scheduleResponseProgressWatchdog();
    };
    const scheduleResponseWatchdog = () => {
      if (responseWatchdogTimer) clearTimeout(responseWatchdogTimer);
      responseWatchdogTimer = setTimeout(() => {
        responseWatchdogTimer = null;
        if (ws.readyState !== WebSocket.OPEN) {
          responseWatchdogNudged = false;
          return;
        }
        if (!responseWatchdogNudged) {
          responseWatchdogNudged = true;
          logger.warn('upstream response watchdog nudging silent turn', {
            turn,
            timeoutMs: VOICE_UPSTREAM_RESPONSE_TIMEOUT_MS,
          });
          // 只推动已提交轮次，不创建 conversation item，也不打开 injection 确认窗。
          ws.send(JSON.stringify({
            type: 'response.create',
            ...(sentResponseInstructions
              ? { response: { instructions: sentResponseInstructions } }
              : {}),
          }));
          responseCreateInFlight = true;
          scheduleResponseWatchdog();
          return;
        }
        responseWatchdogNudged = false;
        logger.warn('upstream response watchdog still silent after nudge', {
          turn,
          timeoutMs: VOICE_UPSTREAM_RESPONSE_TIMEOUT_MS,
        });
        notifyModelUnresponsive({
          turn,
          responseId: 'pending-create',
          silenceMs: VOICE_UPSTREAM_RESPONSE_TIMEOUT_MS * 2,
          thresholdMs: VOICE_UPSTREAM_RESPONSE_TIMEOUT_MS,
          thresholdSource: 'await_created',
        });
      }, VOICE_UPSTREAM_RESPONSE_TIMEOUT_MS);
    };
    const armResponseWatchdog = () => {
      clearAllResponseWatchdogs();
      scheduleResponseWatchdog();
    };
    const settlePendingInjection = (error?: Error): void => {
      const pending = pendingInjectionAck;
      pendingInjectionAck = null;
      pendingInjectionAt = null;
      pendingInjectionNarrationId = undefined;
      pendingInjectionToken = 0;
      if (!pending) return;
      clearTimeout(pending.timer);
      if (error) pending.reject(error);
      else pending.resolve();
    };
    const rejectPendingInjection = (message: string): void => {
      settlePendingInjection(new Error(message));
    };
    const sendInjectedItem = (
      text: string,
      waitForAck: boolean,
      narrationId?: string,
    ): Promise<void> | undefined => {
      if (ws.readyState !== WebSocket.OPEN) {
        if (waitForAck) return Promise.reject(new Error('voice upstream is not open'));
        return undefined;
      }
      // The upstream exposes only one injection rejection window. Serialise all
      // injections at this transport boundary so a typed user message cannot be
      // mistaken for a narration rejection (or vice versa).
      if (pendingInjectionAt !== null) {
        if (waitForAck) return Promise.reject(new Error('voice injection already in flight'));
        queueMicrotask(() => onEvent({
          type: 'injection.rejected',
          message: 'voice injection already in flight',
        }));
        return undefined;
      }

      pendingInjectionAt = Date.now();
      pendingInjectionNarrationId = narrationId;
      const injectionToken = pendingInjectionToken = ++injectionSequence;
      let ack: Promise<void> | undefined;
      if (waitForAck) {
        ack = new Promise<void>((resolve, reject) => {
          const timer = setTimeout(() => {
            if (!pendingInjectionAck || pendingInjectionToken !== injectionToken) return;
            rejectPendingInjection('voice injection acknowledgement timed out');
          }, VOICE_INJECTION_ACK_WINDOW_MS);
          pendingInjectionAck = { resolve, reject, timer };
        });
      } else {
        setTimeout(() => {
          if (pendingInjectionToken !== injectionToken) return;
          const message = 'voice injection acknowledgement timed out';
          rejectPendingInjection(message);
          onEvent({ type: 'injection.rejected', message });
        }, VOICE_INJECTION_ACK_WINDOW_MS);
      }

      try {
        ws.send(JSON.stringify({
          type: 'conversation.item.create',
          item: { type: 'message', role: 'user', content: [{ type: 'input_text', text }] },
        }));
        sentResponseInstructions = '';
        armResponseWatchdog();
        ws.send(JSON.stringify({ type: 'response.create' }));
        responseCreateInFlight = true;
      } catch (error) {
        rejectPendingInjection(error instanceof Error ? error.message : 'voice injection failed');
      }
      return ack;
    };
    const sendResponseCreate = () => {
      if (ws.readyState !== WebSocket.OPEN || activeResponseId || cancellingResponseIds.size > 0) return false;
      responseCreateQueued = false;
      sentResponseInstructions = queuedResponseInstructions;
      queuedResponseInstructions = '';
      sentResponseToolChoice = queuedResponseToolChoice;
      queuedResponseToolChoice = 'auto';
      updateSessionToolChoice(sentResponseToolChoice);
      armResponseWatchdog();
      // 旧 assistant item 只能在当前用户 ASR final 已到、Host 明确请求新回复后删除。
      // 若在旧 response.done 当刻删，可能连正在提交的 input transcription 一起截断。
      for (const itemId of cancellingResponseItemIds.values()) {
        ws.send(JSON.stringify({ type: 'conversation.item.delete', item_id: itemId }));
      }
      cancellingResponseItemIds.clear();
      ws.send(JSON.stringify({
        type: 'response.create',
        ...(sentResponseInstructions
          ? { response: { instructions: sentResponseInstructions } }
          : {}),
      }));
      responseCreateInFlight = true;
      return true;
    };

    /**
     * 工具结果回灌：写进对话项后必须再发一次 response.create，否则模型拿到结果也不开口。
     * 执行失败不抛回上游——把失败文案当结果说出去，比通话卡死好。
     */
    async function handleToolCall(
      callId: string,
      name: string,
      args: string,
      origin: VoiceToolCallOrigin,
      responseId: string,
    ): Promise<void> {
      if (!onToolCall) return;
      const priorOrigin = toolOriginByResponse.get(responseId);
      if (priorOrigin) {
        logger.warn('duplicate realtime voice tool call ignored', {
          provider: profile.id,
          responseId,
          origin,
          priorOrigin,
        });
        recordVoiceToolCall({ provider: profile.id, origin, toolName: name, outcome: 'duplicate' });
        return;
      }
      const validation = validateVoiceToolArguments(name, args, registeredTools);
      if (!validation.ok) {
        logger.warn('realtime voice tool call rejected', {
          provider: profile.id,
          responseId,
          origin,
          toolName: name,
          reason: validation.reason,
        });
        recordVoiceToolCall({ provider: profile.id, origin, toolName: name, outcome: 'rejected' });
        return;
      }
      toolOriginByResponse.set(responseId, origin);
      logger.info('realtime voice tool call accepted', {
        provider: profile.id,
        responseId,
        callId,
        origin,
        toolName: name,
      });
      recordVoiceToolCall({ provider: profile.id, origin, toolName: name, outcome: 'accepted' });
      // required 只约束用户这一轮。工具结果后的二轮回复必须先恢复 auto，
      // 否则模型会被迫再调一次工具，形成调用环。
      updateSessionToolChoice('auto');
      const output = await onToolCall({ callId, name, arguments: validation.arguments, origin })
        .catch((err: unknown) => `工具执行失败：${err instanceof Error ? err.message : 'unknown'}`);
      if (ws.readyState !== WebSocket.OPEN) return;
      ws.send(JSON.stringify({
        type: 'conversation.item.create',
        item: { type: 'function_call_output', call_id: callId, output },
      }));
      sentResponseInstructions = '';
      armResponseWatchdog();
      ws.send(JSON.stringify({ type: 'response.create' }));
      responseCreateInFlight = true;
    }

    // 上游到底回了什么，此前只有被 switch 命中的那几类才留痕；真机出现
    // 「转写有了但模型不开口」时，日志里一片空白，无法判因。现在按用户发言
    // 轮次为每种事件类型留一条，既能还原每轮是否齐全，也避免 delta 刷屏。
    // 绝不记 delta / audio / transcript 内容（音频不落日志是硬纪律）。
    const eventTypeSeen = new Map<string, number>();
    let turn = 0;
    // tools 被上游静默丢弃的用户可见提示：一通电话只报一次，别每条 session.updated 刷。
    let toolsDroppedNotified = false;
    const notifyToolsDropped = () => {
      if (!registeredTools.length || toolsDroppedNotified) return;
      toolsDroppedNotified = true;
      onEvent({
        type: 'notice',
        code: 'VOICE_TOOLS_DROPPED',
        message: `当前通话模型（${model}）不支持在通话中派活，这通电话只能聊天`,
      });
    };
    let confirmInitialSessionHandshake: (() => void) | null = null;
    ws.on('message', (raw) => {
      // 合法事件、未知事件和偶发非 JSON 帧都证明链路仍有下行信号。
      markUpstreamSignal();
      const event = parseEvent(raw);
      if (!event) return;
      if (event.type === 'input_audio_buffer.speech_started') {
        turn += 1;
        eventTypeSeen.clear();
      }
      const seen = (eventTypeSeen.get(event.type) ?? 0) + 1;
      eventTypeSeen.set(event.type, seen);
      // 每轮每种类型只记首次，避免 delta 刷屏
      if (seen === 1) logger.info('upstream event', { turn, type: event.type });

      switch (event.type) {
        case 'input_audio_buffer.committed':
          // VAD 只提交转写，是否创建回复由 Host 的语义闸在 final 后决定。
          break;
        case 'response.created': {
          clearResponseWatchdog();
          responseCreateInFlight = false;
          const responseId = responseIdOf(event, 'legacy-response');
          const narrationId = pendingInjectionNarrationId;
          activeResponseId = responseId;
          armResponseProgressWatchdog(responseId);
          if (responseId) unclassifiedAudioByResponse.set(responseId, []);
          responseCreateQueued = false;
          settlePendingInjection();
          if (responseId) onEvent({
            type: 'response.created',
            responseId,
            ...(narrationId ? { narrationId } : {}),
          });
          break;
        }
        case 'response.output_item.added': {
          const responseId = responseIdOf(event, activeResponseId);
          const itemId = typeof event.item?.id === 'string' ? event.item.id : '';
          if (responseId && itemId) responseItemIds.set(responseId, itemId);
          break;
        }
        case 'response.audio.delta':
        case 'response.output_audio.delta':
          if (typeof event.delta === 'string') {
            if (speechStoppedAt && ttfaModelMs === undefined) {
              ttfaModelMs = Date.now() - speechStoppedAt;
              ttfaPerceivedMs = vadSilenceWindowMs !== undefined ? ttfaModelMs + vadSilenceWindowMs : undefined;
              logger.info('ttfa', { ttfaModelMs, ttfaPerceivedMs });
            }
            const audio = Buffer.from(event.delta, 'base64');
            const responseId = responseIdOf(event, activeResponseId);
            feedResponseProgressWatchdog(responseId);
            const held = heldXmlResponses.get(responseId);
            if (held) held.audio.push(audio);
            else if (unclassifiedAudioByResponse.has(responseId)) {
              unclassifiedAudioByResponse.get(responseId)?.push(audio);
            }
            else onAudio(audio);
          }
          break;
        case 'response.audio_transcript.delta':
        case 'response.output_audio_transcript.delta': {
          if (typeof event.delta === 'string') {
            const responseId = responseIdOf(event, activeResponseId);
            feedResponseProgressWatchdog(responseId);
            if (responseId) {
              const itemId = responseItemIds.get(responseId) ?? event.item_id;
              if (itemId && !responseItemIds.has(responseId)) responseItemIds.set(responseId, itemId);
              const existing = heldXmlResponses.get(responseId);
              const combined = `${existing?.transcript ?? ''}${event.delta}`;
              if (existing || mayBeVoiceXmlFallback(combined)) {
                const unclassifiedAudio = unclassifiedAudioByResponse.get(responseId) ?? [];
                unclassifiedAudioByResponse.delete(responseId);
                heldXmlResponses.set(responseId, {
                  audio: existing?.audio ?? unclassifiedAudio,
                  transcript: combined,
                  ...(itemId ? { itemId } : {}),
                });
              } else {
                for (const frame of unclassifiedAudioByResponse.get(responseId) ?? []) onAudio(frame);
                unclassifiedAudioByResponse.delete(responseId);
                onEvent({
                  type: 'assistant.transcript',
                  text: event.delta,
                  done: false,
                  responseId,
                  ...(itemId ? { itemId } : {}),
                });
              }
            }
          }
          break;
        }
        case 'response.text.delta':
        case 'response.output_text.delta': {
          if (typeof event.delta === 'string') {
            const responseId = responseIdOf(event, activeResponseId);
            feedResponseProgressWatchdog(responseId);
          }
          break;
        }
        case 'response.audio_transcript.done':
        case 'response.output_audio_transcript.done': {
          const responseId = responseIdOf(event, activeResponseId || 'legacy-response');
          if (responseId) {
            const itemId = responseItemIds.get(responseId) ?? event.item_id;
            if (itemId && !responseItemIds.has(responseId)) responseItemIds.set(responseId, itemId);
            const transcript = typeof event.transcript === 'string' ? event.transcript : '';
            const held = heldXmlResponses.get(responseId);
            if (held || mayBeVoiceXmlFallback(transcript)) {
              unclassifiedAudioByResponse.delete(responseId);
              const parsed = parseVoiceXmlToolFallback(transcript || held?.transcript || '', registeredTools);
              heldXmlResponses.delete(responseId);
              if (parsed.kind === 'accepted') {
                pendingXmlCalls.set(responseId, { name: parsed.name, arguments: parsed.arguments });
              } else if (parsed.kind === 'rejected') {
                logger.warn('realtime voice XML fallback rejected', {
                  provider: profile.id,
                  responseId,
                  reason: parsed.reason,
                  ...(parsed.toolName ? { toolName: parsed.toolName } : {}),
                });
                recordVoiceToolCall({
                  provider: profile.id,
                  origin: 'xml_fallback',
                  toolName: parsed.toolName ?? 'unknown',
                  outcome: 'rejected',
                });
              } else {
                for (const frame of held?.audio ?? []) onAudio(frame);
                onEvent({
                  type: 'assistant.transcript',
                  text: transcript,
                  done: true,
                  responseId,
                  ...(itemId ? { itemId } : {}),
                });
              }
            } else {
              for (const frame of unclassifiedAudioByResponse.get(responseId) ?? []) onAudio(frame);
              unclassifiedAudioByResponse.delete(responseId);
              onEvent({
                type: 'assistant.transcript',
                text: transcript,
                done: true,
                responseId,
                ...(itemId ? { itemId } : {}),
              });
            }
          }
          break;
        }
        // 用户侧流式字幕（E3）。**文本在 `stash` 里，`text` 字段恒空**——2026-07-30
        // 真上游探针实测（26 个 delta，text 全是 len=0，stash 单调增长 2→21）。
        // stash 是**累计值**不是增量，所以直接当整句下发，renderer 的 partialUser 是替换语义。
        case 'conversation.item.input_audio_transcription.delta': {
          const itemId = typeof event.item_id === 'string' ? event.item_id : '';
          const stash = profile.sessionShape === 'openai-realtime'
            ? `${itemId ? userTranscriptStash.get(itemId) ?? '' : ''}${typeof event.delta === 'string' ? event.delta : ''}`
            : typeof event.stash === 'string' ? event.stash : '';
          if (!stash) break;
          if (itemId) userTranscriptStash.set(itemId, stash);
          onEvent({
            type: 'user.transcript',
            text: stash,
            done: false,
            ...(itemId ? { itemId } : {}),
            ...(currentCandidateId ? { candidateId: currentCandidateId } : {}),
          });
          break;
        }
        case 'conversation.item.input_audio_transcription.completed': {
          const itemId = typeof event.item_id === 'string' ? event.item_id : '';
          const final = typeof event.transcript === 'string' ? event.transcript : '';
          // E1（P0，2026-07-30 真机：25 秒通话两轮转写全丢，DB 里一条 user 都没有）：
          // completed 的 transcript 会**间歇性为空**。此前空文本一路静默走到落库前被丢弃，
          // 用户说的话就此蒸发。delta 攒下的 stash 是同一句话，拿它兜底。
          const stashed = itemId ? userTranscriptStash.get(itemId) ?? '' : '';
          const text = final.trim() ? final : stashed;
          if (!final.trim()) {
            logger.warn('user transcript empty on completed, falling back to delta stash', {
              hasStash: !!stashed,
              stashLength: stashed.length,
              recovered: !!text,
            });
          }
          if (itemId) userTranscriptStash.delete(itemId);
          onEvent({
            type: 'user.transcript',
            text,
            done: true,
            ...(itemId ? { itemId } : {}),
            ...(currentCandidateId ? { candidateId: currentCandidateId } : {}),
          });
          break;
        }
        case 'input_audio_buffer.speech_started':
          clearAllResponseWatchdogs();
          speechStoppedAt = 0;
          ttfaModelMs = undefined;
          ttfaPerceivedMs = undefined;
          speechStartedAt = Date.now();
          currentCandidateId = `turn-${turn}`;
          onEvent({ type: 'speech.started', candidateId: currentCandidateId });
          break;
        case 'input_audio_buffer.speech_stopped':
          speechStoppedAt = Date.now();
          onEvent({
            type: 'speech.stopped',
            candidateId: currentCandidateId,
            durationMs: speechStartedAt ? Math.max(0, speechStoppedAt - speechStartedAt) : 0,
          });
          break;
        case 'session.updated': {
          confirmInitialSessionHandshake?.();
          // 上游到底收下了什么档：我们发 server_vad、它回 null，就是「说了没反应」
          // 的直接证据（发出去 ≠ 被采纳）。
          const session = event.session as {
            tools?: unknown;
            turn_detection?: unknown;
            audio?: { input?: { turn_detection?: unknown } };
          } | undefined;
          const echoed = profile.sessionShape === 'openai-realtime'
            ? session?.audio?.input?.turn_detection
            : session?.turn_detection;
          logger.info('session.updated echo', {
            turnDetection: echoed === null ? 'null(manual)' : JSON.stringify(echoed),
            toolsLength: Array.isArray(session?.tools) ? session.tools.length : null,
          });
          // 静默降级留痕：上一代模型对 tools 是「收下不报错、回显 null」，
          // 不告警的话现场只能看到「模型死活不肯派活」，查不到根因。
          if (registeredTools.length && !upstreamAcceptedTools(event)) {
            logger.warn('upstream dropped registered tools (model likely lacks function calling)', {
              model,
              sent: registeredTools.length,
            });
            // fail-loud 兜底：判据打在「上游真的回了什么」上，不打在白名单表里写了什么——
            // 表可能过期，上游行为可能变。只进日志用户看不见，必须让通话里的人当场知道
            // 「这通电话派不了活」，否则他只会觉得这玩意儿今天不肯干活。
            notifyToolsDropped();
          }
          break;
        }
        case 'response.function_call_arguments.done':
          if (onToolCall && typeof event.call_id === 'string' && typeof event.name === 'string') {
            const responseId = responseIdOf(event, activeResponseId || 'legacy-response');
            void handleToolCall(
              event.call_id,
              event.name,
              typeof event.arguments === 'string' ? event.arguments : '{}',
              'function_call',
              responseId,
            );
          }
          break;
        case 'response.done': {
          const responseId = responseIdOf(event, activeResponseId || 'legacy-response');
          const staleWatchdogCancellation = watchdogCancelledResponseIds.delete(responseId)
            && responseId !== activeResponseId;
          if (!staleWatchdogCancellation) clearAllResponseWatchdogs();
          const usage = parseResponseUsage(profile, event.response?.usage);
          if (!usage) {
            logger.warn('response.done usage missing or unrecognized', {
              provider: profile.id,
              sessionShape: profile.sessionShape,
              hasUsage: event.response?.usage !== undefined,
              // usage 只是计数字段，不含用户内容；不打原始形状这条 warn 无法定位（08-06 C3 拖了一周的教训）
              rawUsage: event.response?.usage,
            });
          }
          if (responseId === activeResponseId) activeResponseId = '';
          for (const frame of unclassifiedAudioByResponse.get(responseId) ?? []) onAudio(frame);
          unclassifiedAudioByResponse.delete(responseId);
          heldXmlResponses.delete(responseId);
          if (responseId) cancellingResponseIds.delete(responseId);
          if (responseId) responseItemIds.delete(responseId);
          pendingInjectionAt = null;
          updateSessionToolChoice('auto');
          if (responseId) {
            onEvent({
              type: 'response.done',
              responseId,
              ...(ttfaModelMs !== undefined ? { ttfaModelMs } : {}),
              ...(ttfaPerceivedMs !== undefined ? { ttfaPerceivedMs } : {}),
              ...(usage ? { usage } : {}),
            });
          }
          const xmlCall = pendingXmlCalls.get(responseId);
          if (xmlCall) {
            pendingXmlCalls.delete(responseId);
            void handleToolCall(
              `xml-fallback-${responseId}-${++xmlFallbackSequence}`,
              xmlCall.name,
              xmlCall.arguments,
              'xml_fallback',
              responseId,
            );
          }
          if (responseCreateQueued) sendResponseCreate();
          break;
        }
        case 'error':
          if (event.error?.code === RESPONSE_IDLE_TIMEOUT_CODE) {
            clearAllResponseWatchdogs();
            activeResponseId = '';
            cancellingResponseIds.clear();
            watchdogCancelledResponseIds.clear();
            cancellingResponseItemIds.clear();
            responseItemIds.clear();
            responseCreateQueued = false;
            responseCreateInFlight = false;
            queuedResponseInstructions = '';
            sentResponseInstructions = '';
            queuedResponseToolChoice = 'auto';
            sentResponseToolChoice = 'auto';
            sessionToolChoice = 'auto';
            settlePendingInjection(new Error('voice session ended after idle timeout'));
            logger.info('upstream session ended after idle timeout', {
              code: event.error.code,
              message: event.error.message,
            });
            onEvent({ type: 'session.ended', reason: 'idle-timeout' });
            break;
          }
          // 看门狗接管在飞时，cancel 一个上游已完结的 response 会得到「none active response」
          // 族回执（P3 真机 2026-08-13：DashScope 回 COMMON_ERROR/Conversation has none active
          // response，被当致命错误整通挂断）。这是我方 cancel 的良性回声，吞掉继续等重建。
          if (
            watchdogCancelBenignErrorBudget > 0
            && /no(?:ne)?\s+active\s+response/i.test(event.error?.message ?? '')
          ) {
            watchdogCancelBenignErrorBudget -= 1;
            logger.info('watchdog cancel acked by benign upstream error', {
              code: event.error?.code,
              message: event.error?.message,
            });
            break;
          }
          // message 必须一起记：上游的 code 常常是 COMMON_ERROR 这种无信息量的占位，
          // 真正说明原因的只有 message。2026-07-26 真机踩到——现场只剩一个 COMMON_ERROR，
          // 解释在哪查不到（那句话当时只发给了渲染侧）。
          logger.warn('upstream error', { code: event.error?.code, message: event.error?.message });
          if (pendingInjectionAt !== null && Date.now() - pendingInjectionAt <= VOICE_INJECTION_ACK_WINDOW_MS) {
            const message = event.error?.message ?? 'injection rejected';
            rejectPendingInjection(message);
            onEvent({ type: 'injection.rejected', message });
          } else {
            settlePendingInjection(new Error(event.error?.message ?? 'upstream error'));
            onEvent({
              type: 'error',
              // 上游自己的错误码不往外透传：它无法枚举，进不了 i18n 表，
              // 传出去只会让渲染端拿到一个查不到文案的串。它已经在上一行进日志了。
              code: 'UPSTREAM_ERROR',
              message: 'upstream error',
              ...(event.error?.message ? { detail: event.error.message } : {}),
            });
          }
          break;
        default:
          break;
      }
    });

    ws.on('close', () => {
      clearHeartbeat();
      clearAllResponseWatchdogs();
      watchdogCancelledResponseIds.clear();
      rejectPendingInjection('voice upstream closed during injection');
      onEvent({ type: 'state', state: 'closed' });
    });
    ws.on('error', (err: Error) => {
      rejectPendingInjection(err.message);
      onEvent({
        type: 'error',
        code: 'UPSTREAM_SOCKET',
        message: 'upstream socket error',
        detail: err.message,
      });
    });

    // 只守首次 connect 的唯一 live 出口。断线重连由 voiceSessionService 的 15s 宽限窗接管，
    // 不会重复走这道 8s 闸。session.created 只证明 socket 会话存在，不能证明上面的
    // session.update 已生效；仓内 provider 连接测试同样以 session.updated 回显作为确认。
    const handshakeStartedAt = Date.now();
    const initialSessionHandshake = new Promise<boolean>((resolve) => {
      let settled = false;
      const finish = (confirmed: boolean) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        confirmInitialSessionHandshake = null;
        resolve(confirmed);
      };
      const timer = setTimeout(() => finish(false), INITIAL_SESSION_HANDSHAKE_TIMEOUT_MS);
      confirmInitialSessionHandshake = () => finish(true);
    });
    ws.send(JSON.stringify(initialSessionUpdate));

    const handshakeConfirmed = await initialSessionHandshake;
    const handshakeWaitMs = Date.now() - handshakeStartedAt;
    if (handshakeConfirmed) {
      logger.info('initial session handshake confirmed', {
        voiceSessionId: config.neoSessionId,
        waitMs: handshakeWaitMs,
      });
    } else {
      logger.info('initial session handshake timed out; continuing without tools', {
        voiceSessionId: config.neoSessionId,
        waitMs: handshakeWaitMs,
      });
      notifyToolsDropped();
    }
    onEvent({ type: 'state', state: 'live' });

    return {
      kind: 'relay',
      // 历史摘要与投影仍认 qwen-omni；配置侧使用新的 profile id。
      provider: profile.id === 'dashscope-qwen-omni' ? 'qwen-omni' : profile.id,
      sendAudio(frame: Buffer) {
        if (ws.readyState !== WebSocket.OPEN) return;
        const upstreamFrame = resamplePcm16Mono(frame, 16_000, profile.inputSampleRate);
        ws.send(JSON.stringify({ type: 'input_audio_buffer.append', audio: upstreamFrame.toString('base64') }));
      },
      updateInstructions(instructions: string) {
        if (ws.readyState !== WebSocket.OPEN) return;
        // 只发 instructions 这一个字段：整份 session 重发会把 turn_detection / tools
        // 一起重置，上游对「重发 tools」的行为按模型分化过一次（见 voiceTools 顶注），不赌。
        ws.send(JSON.stringify({ type: 'session.update', session: { instructions } }));
      },
      commit() {
        if (ws.readyState !== WebSocket.OPEN) return;
        // turn_detection = null 的手动模式：commit 把缓冲切成一轮，response.create 让模型开口。
        ws.send(JSON.stringify({ type: 'input_audio_buffer.commit' }));
        responseCreateQueued = true;
        sendResponseCreate();
      },
      respond(instructions?: string, toolChoice: 'auto' | 'required' = 'auto') {
        responseCreateQueued = true;
        queuedResponseInstructions = instructions?.trim() ?? '';
        queuedResponseToolChoice = toolChoice;
        sendResponseCreate();
      },
      injectItem(text: string, narrationId?: string) {
        // 与工具结果回灌同一套路：写进对话项后必须再发一次 response.create，
        // 否则模型收下了也不开口（handleToolCall 顶注是同一条踩坑）。
        // narration 继续使用这个 fire-and-forget 入口；用户文字走下面的 ack 入口，
        // 被拒时才能可靠回到 durable queue。
        sendInjectedItem(text, false, narrationId);
      },
      injectItemWithAck(text: string) {
        const ack = sendInjectedItem(text, true);
        return ack ?? Promise.reject(new Error('voice injection was not sent'));
      },
      isResponding() {
        return Boolean(activeResponseId || responseCreateInFlight);
      },
      interrupt() {
        if (ws.readyState !== WebSocket.OPEN || !activeResponseId) return null;
        const responseId = activeResponseId;
        cancellingResponseIds.add(responseId);
        const itemId = responseItemIds.get(responseId);
        if (itemId) {
          cancellingResponseItemIds.set(responseId, itemId);
          while (cancellingResponseItemIds.size > 32) {
            const oldest = cancellingResponseItemIds.keys().next().value as string | undefined;
            if (!oldest) break;
            cancellingResponseItemIds.delete(oldest);
          }
        }
        activeResponseId = '';
        ws.send(JSON.stringify({ type: 'response.cancel' }));
        return responseId;
      },
      async close() {
        clearHeartbeat();
        clearAllResponseWatchdogs();
        if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) ws.close();
      },
    };
  },
};
}
