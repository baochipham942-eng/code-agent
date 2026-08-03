// ============================================================================
// 通用 Realtime transport（OpenAI Realtime 协议族，Host WebSocket relay）
//
// Host 持 API key 建 WS，音频帧只在内存中转，不落盘、不进日志。
// Provider 差异集中在 profile；DashScope 保留旧协议形状，OpenAI 使用当前嵌套 audio schema。
// ============================================================================

import WebSocket from 'ws';
import {
  VOICE_STALE_PREFIX_DEFAULTS_MS,
  VOICE_STALE_SILENCE_DEFAULTS_MS,
  VOICE_TURN_DETECTION_DEFAULT,
  VOICE_UPSTREAM_CONNECT_TIMEOUT_MS,
  VOICE_UPSTREAM_HEARTBEAT_INTERVAL_MS,
  VOICE_UPSTREAM_RESPONSE_TIMEOUT_MS,
  VOICE_UPSTREAM_SILENCE_TIMEOUT_MS,
} from '../../../shared/constants/voice';
import type { RealtimeVoiceProviderProfile } from '../../../shared/constants/realtimeVoiceProviders';
import type {
  VoiceTokenUsage,
  VoiceTransport,
  VoiceTransportHandle,
  VoiceTurnDetectionConfig,
} from '../../../shared/contract/voice';
import { getConfigService } from '../core/configService';
import { createLogger } from '../infra/logger';
import { getHttpsAgent } from '../../model/providers/providerHttp';

const logger = createLogger('RealtimeVoice');
const INJECTION_ACK_WINDOW_MS = 5_000;
const RESPONSE_IDLE_TIMEOUT_CODE = 'response_idle_timeout';
// Realtime 协议族的 provider 不保证必发 session.updated；超时降级是预期路径，不是建连失败。
const INITIAL_SESSION_HANDSHAKE_TIMEOUT_MS = 8_000;

interface UpstreamEvent {
  type: string;
  response_id?: string;
  item_id?: string;
  response?: { id?: string; usage?: unknown };
  item?: { id?: string };
  delta?: string;
  transcript?: string;
  audio?: string;
  error?: { code?: string; message?: string };
  [key: string]: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function tokenCount(record: Record<string, unknown>, key: string): number | undefined {
  const value = record[key];
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function parseDashscopeUsage(raw: unknown): VoiceTokenUsage | undefined {
  if (!isRecord(raw) || !isRecord(raw.input_tokens_details) || !isRecord(raw.output_tokens_details)) return undefined;
  const totalTokens = tokenCount(raw, 'total_tokens');
  const inputTokens = tokenCount(raw, 'input_tokens');
  const outputTokens = tokenCount(raw, 'output_tokens');
  const inputAudioTokens = tokenCount(raw.input_tokens_details, 'audio_tokens');
  const inputTextTokens = tokenCount(raw.input_tokens_details, 'text_tokens');
  const outputAudioTokens = tokenCount(raw.output_tokens_details, 'audio_tokens');
  const outputTextTokens = tokenCount(raw.output_tokens_details, 'text_tokens');
  if (
    totalTokens === undefined
    || inputTokens === undefined
    || outputTokens === undefined
    || inputAudioTokens === undefined
    || inputTextTokens === undefined
    || outputAudioTokens === undefined
    || outputTextTokens === undefined
  ) return undefined;
  return {
    totalTokens,
    inputTokens,
    outputTokens,
    inputAudioTokens,
    inputTextTokens,
    outputAudioTokens,
    outputTextTokens,
  };
}

function parseOpenAIUsage(raw: unknown): VoiceTokenUsage | undefined {
  if (!isRecord(raw) || !isRecord(raw.input_token_details) || !isRecord(raw.output_token_details)) return undefined;
  const totalTokens = tokenCount(raw, 'total_tokens');
  const inputTokens = tokenCount(raw, 'input_tokens');
  const outputTokens = tokenCount(raw, 'output_tokens');
  const inputAudioTokens = tokenCount(raw.input_token_details, 'audio_tokens');
  const inputTextTokens = tokenCount(raw.input_token_details, 'text_tokens');
  const outputAudioTokens = tokenCount(raw.output_token_details, 'audio_tokens');
  const outputTextTokens = tokenCount(raw.output_token_details, 'text_tokens');
  if (
    totalTokens === undefined
    || inputTokens === undefined
    || outputTokens === undefined
    || inputAudioTokens === undefined
    || inputTextTokens === undefined
    || outputAudioTokens === undefined
    || outputTextTokens === undefined
  ) return undefined;
  return {
    totalTokens,
    inputTokens,
    outputTokens,
    inputAudioTokens,
    inputTextTokens,
    outputAudioTokens,
    outputTextTokens,
  };
}

function parseResponseUsage(profile: RealtimeVoiceProviderProfile, raw: unknown): VoiceTokenUsage | undefined {
  return profile.sessionShape === 'dashscope-compatible'
    ? parseDashscopeUsage(raw)
    : parseOpenAIUsage(raw);
}

function responseIdOf(event: UpstreamEvent, fallback = ''): string {
  if (typeof event.response_id === 'string' && event.response_id) return event.response_id;
  if (typeof event.response?.id === 'string' && event.response.id) return event.response.id;
  return fallback;
}

function parseEvent(raw: unknown): UpstreamEvent | null {
  try {
    const parsed: unknown = JSON.parse(String(raw));
    if (parsed && typeof parsed === 'object' && typeof (parsed as UpstreamEvent).type === 'string') {
      return parsed as UpstreamEvent;
    }
  } catch {
    // 上游偶发非 JSON 帧，忽略即可；不要打印内容（可能含音频 base64）。
  }
  return null;
}

type UpstreamTurnDetection =
  | {
      type: 'server_vad';
      threshold?: number;
      prefix_padding_ms?: number;
      silence_duration_ms?: number;
      create_response: false;
      interrupt_response: false;
    }
  | {
      type: 'semantic_vad';
      eagerness?: 'low' | 'medium' | 'high' | 'auto';
      create_response: false;
      interrupt_response: false;
    }
  | null;

function resolveTurnDetectionConfig(): VoiceTurnDetectionConfig {
  try {
    const voice = getConfigService().getSettings().voice;
    const configured = voice?.turnDetection;
    // `turnDetection: null` = 手动 commit 档。但删掉「按住说话」之后，老配置里会出现
    // `turnDetection: null` + `live.interrupt: 'push_to_talk'` 的组合——UI 侧把它归一到
    // 全双工了，运行时若还按 null 走，就是「UI 说全双工、上游永远等不到 commit」的
    // 分叉：用户说了没反应，连补救的点按按钮都不显示（2026-07-27 真机差点踩到）。
    // 只有**显式**留在点按档时才认这个 null。
    if (configured === null && voice?.live?.interrupt !== 'manual') return VOICE_TURN_DETECTION_DEFAULT;
    if (configured === undefined) return VOICE_TURN_DETECTION_DEFAULT;
    return upgradeStaleVadDefaults(configured);
  } catch {
    return VOICE_TURN_DETECTION_DEFAULT;
  }
}

/**
 * 存量配置里的旧默认值升级（批 X2，批 X5 补上 800）。prefix/silence 从来不是 UI 可设项
 * ——落盘里等于历代默认值之一，就只可能是「当年默认值随保存写死的拷贝」，不是用户选择。
 * 改默认值对存量零生效是踩过的坑（echoCancellation 先例），所以在读取口把旧默认识别为
 * 过期：逐字段命中历代默认表 → 升到新默认；手改过的其他值（含 threshold）原样保留。
 *
 * 历代默认表放常量文件而不是写在这里：改默认值的人改的是那个文件，旧值必须在他眼前。
 */
function upgradeStaleVadDefaults(configured: VoiceTurnDetectionConfig): VoiceTurnDetectionConfig {
  if (configured?.type !== 'server_vad') return configured;
  const defaults = VOICE_TURN_DETECTION_DEFAULT;
  if (defaults?.type !== 'server_vad') return configured;
  const isStale = (value: number | undefined, stale: readonly number[]): boolean =>
    value !== undefined && stale.includes(value);
  return {
    ...configured,
    ...(isStale(configured.prefixPaddingMs, VOICE_STALE_PREFIX_DEFAULTS_MS)
      ? { prefixPaddingMs: defaults.prefixPaddingMs }
      : {}),
    ...(isStale(configured.silenceDurationMs, VOICE_STALE_SILENCE_DEFAULTS_MS)
      ? { silenceDurationMs: defaults.silenceDurationMs }
      : {}),
  };
}

/** session.updated 回显里是否真收下了工具。回显不带 tools 字段一律按「没收下」算。 */
function upstreamAcceptedTools(event: UpstreamEvent): boolean {
  const session = event.session as { tools?: unknown } | undefined;
  return Array.isArray(session?.tools) && session.tools.length > 0;
}

function toUpstreamTurnDetection(config: VoiceTurnDetectionConfig): UpstreamTurnDetection {
  if (config === null) return null;
  if (config.type === 'semantic_vad') {
    return {
      type: 'semantic_vad',
      create_response: false,
      interrupt_response: false,
      ...(config.eagerness ? { eagerness: config.eagerness } : {}),
    };
  }
  return {
    type: 'server_vad',
    create_response: false,
    interrupt_response: false,
    ...(config.threshold !== undefined ? { threshold: config.threshold } : {}),
    ...(config.prefixPaddingMs !== undefined ? { prefix_padding_ms: config.prefixPaddingMs } : {}),
    ...(config.silenceDurationMs !== undefined ? { silence_duration_ms: config.silenceDurationMs } : {}),
  };
}

function buildSessionUpdate(
  profile: RealtimeVoiceProviderProfile,
  input: {
    model: string;
    voice: string;
    instructions?: string;
    tools: readonly unknown[];
    turnDetection: UpstreamTurnDetection;
  },
): Record<string, unknown> {
  if (profile.sessionShape === 'openai-realtime') {
    return {
      type: 'session.update',
      session: {
        type: 'realtime',
        model: input.model,
        output_modalities: ['audio'],
        audio: {
          input: {
            format: { type: 'audio/pcm', rate: profile.inputSampleRate },
            transcription: profile.transcriptionModel ? { model: profile.transcriptionModel } : undefined,
            turn_detection: input.turnDetection,
          },
          output: {
            format: { type: 'audio/pcm' },
            voice: input.voice,
          },
        },
        ...(input.instructions ? { instructions: input.instructions } : {}),
        ...(input.tools.length ? { tools: input.tools, tool_choice: 'auto' } : {}),
      },
    };
  }
  return {
    type: 'session.update',
    session: {
      modalities: ['text', 'audio'],
      voice: input.voice,
      input_audio_format: 'pcm16',
      output_audio_format: 'pcm16',
      ...(profile.transcriptionModel
        ? { input_audio_transcription: { model: profile.transcriptionModel } }
        : {}),
      turn_detection: input.turnDetection,
      ...(input.instructions ? { instructions: input.instructions } : {}),
      ...(input.tools.length ? { tools: input.tools, tool_choice: 'auto' } : {}),
    },
  };
}

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
    const url = profile.wsUrl(model);
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
    const cancellingResponseItemIds = new Map<string, string>();
    let responseCreateQueued = false;
    let queuedResponseInstructions = '';
    let sentResponseInstructions = '';
    let pendingInjectionAt: number | null = null;
    let pendingInjectionAck: {
      resolve: () => void;
      reject: (error: Error) => void;
      timer: ReturnType<typeof setTimeout>;
    } | null = null;
    let responseWatchdogTimer: ReturnType<typeof setTimeout> | null = null;
    let responseWatchdogNudged = false;
    let modelUnresponsiveNotified = false;
    let speechStartedAt = 0;
    let currentCandidateId = '';

    const clearResponseWatchdog = () => {
      if (responseWatchdogTimer) clearTimeout(responseWatchdogTimer);
      responseWatchdogTimer = null;
      responseWatchdogNudged = false;
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
          scheduleResponseWatchdog();
          return;
        }
        responseWatchdogNudged = false;
        logger.warn('upstream response watchdog still silent after nudge', {
          turn,
          timeoutMs: VOICE_UPSTREAM_RESPONSE_TIMEOUT_MS,
        });
        if (!modelUnresponsiveNotified) {
          modelUnresponsiveNotified = true;
          onEvent({
            type: 'notice',
            code: 'VOICE_MODEL_UNRESPONSIVE',
            message: '模型没有回应，可以再说一遍，或挂断重拨',
          });
        }
      }, VOICE_UPSTREAM_RESPONSE_TIMEOUT_MS);
    };
    const armResponseWatchdog = () => {
      clearResponseWatchdog();
      scheduleResponseWatchdog();
    };
    const settlePendingInjection = (error?: Error): void => {
      const pending = pendingInjectionAck;
      pendingInjectionAck = null;
      pendingInjectionAt = null;
      if (!pending) return;
      clearTimeout(pending.timer);
      if (error) pending.reject(error);
      else pending.resolve();
    };
    const rejectPendingInjection = (message: string): void => {
      settlePendingInjection(new Error(message));
    };
    const sendInjectedItem = (text: string, waitForAck: boolean): Promise<void> | undefined => {
      if (ws.readyState !== WebSocket.OPEN) {
        if (waitForAck) return Promise.reject(new Error('voice upstream is not open'));
        return undefined;
      }
      // The upstream exposes only one injection rejection window. Serialise all
      // injections at this transport boundary so a typed user message cannot be
      // mistaken for a narration rejection (or vice versa).
      if (pendingInjectionAt !== null) {
        if (waitForAck) return Promise.reject(new Error('voice injection already in flight'));
        return undefined;
      }

      pendingInjectionAt = Date.now();
      let ack: Promise<void> | undefined;
      if (waitForAck) {
        ack = new Promise<void>((resolve, reject) => {
          const timer = setTimeout(() => {
            if (!pendingInjectionAck) return;
            pendingInjectionAck = null;
            pendingInjectionAt = null;
            reject(new Error('voice injection acknowledgement timed out'));
          }, INJECTION_ACK_WINDOW_MS);
          pendingInjectionAck = { resolve, reject, timer };
        });
      }

      try {
        ws.send(JSON.stringify({
          type: 'conversation.item.create',
          item: { type: 'message', role: 'user', content: [{ type: 'input_text', text }] },
        }));
        ws.send(JSON.stringify({ type: 'response.create' }));
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
      return true;
    };

    /**
     * 工具结果回灌：写进对话项后必须再发一次 response.create，否则模型拿到结果也不开口。
     * 执行失败不抛回上游——把失败文案当结果说出去，比通话卡死好。
     */
    async function handleToolCall(callId: string, name: string, args: string): Promise<void> {
      if (!onToolCall) return;
      const output = await onToolCall({ callId, name, arguments: args })
        .catch((err: unknown) => `工具执行失败：${err instanceof Error ? err.message : 'unknown'}`);
      if (ws.readyState !== WebSocket.OPEN) return;
      ws.send(JSON.stringify({
        type: 'conversation.item.create',
        item: { type: 'function_call_output', call_id: callId, output },
      }));
      ws.send(JSON.stringify({ type: 'response.create' }));
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
          const responseId = responseIdOf(event, 'legacy-response');
          activeResponseId = responseId;
          responseCreateQueued = false;
          settlePendingInjection();
          if (responseId) onEvent({ type: 'response.created', responseId });
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
            onAudio(Buffer.from(event.delta, 'base64'));
          }
          break;
        case 'response.audio_transcript.delta':
        case 'response.output_audio_transcript.delta': {
          if (typeof event.delta === 'string') {
            const responseId = responseIdOf(event, activeResponseId);
            if (responseId) {
              const itemId = responseItemIds.get(responseId) ?? event.item_id;
              if (itemId && !responseItemIds.has(responseId)) responseItemIds.set(responseId, itemId);
              onEvent({
                type: 'assistant.transcript',
                text: event.delta,
                done: false,
                responseId,
                ...(itemId ? { itemId } : {}),
              });
            }
          }
          break;
        }
        case 'response.audio_transcript.done':
        case 'response.output_audio_transcript.done': {
          const responseId = responseIdOf(event, activeResponseId || 'legacy-response');
          if (responseId) {
            const itemId = responseItemIds.get(responseId) ?? event.item_id;
            if (itemId && !responseItemIds.has(responseId)) responseItemIds.set(responseId, itemId);
            onEvent({
              type: 'assistant.transcript',
              text: typeof event.transcript === 'string' ? event.transcript : '',
              done: true,
              responseId,
              ...(itemId ? { itemId } : {}),
            });
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
          clearResponseWatchdog();
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
            void handleToolCall(event.call_id, event.name, typeof event.arguments === 'string' ? event.arguments : '{}');
          }
          break;
        case 'response.done': {
          const responseId = responseIdOf(event, activeResponseId || 'legacy-response');
          const usage = parseResponseUsage(profile, event.response?.usage);
          if (!usage) {
            logger.warn('response.done usage missing or unrecognized', {
              provider: profile.id,
              sessionShape: profile.sessionShape,
              hasUsage: event.response?.usage !== undefined,
            });
          }
          if (responseId === activeResponseId) activeResponseId = '';
          if (responseId) cancellingResponseIds.delete(responseId);
          if (responseId) responseItemIds.delete(responseId);
          pendingInjectionAt = null;
          if (responseId) {
            onEvent({
              type: 'response.done',
              responseId,
              ...(ttfaModelMs !== undefined ? { ttfaModelMs } : {}),
              ...(ttfaPerceivedMs !== undefined ? { ttfaPerceivedMs } : {}),
              ...(usage ? { usage } : {}),
            });
          }
          if (responseCreateQueued) sendResponseCreate();
          break;
        }
        case 'error':
          if (event.error?.code === RESPONSE_IDLE_TIMEOUT_CODE) {
            clearResponseWatchdog();
            activeResponseId = '';
            cancellingResponseIds.clear();
            cancellingResponseItemIds.clear();
            responseItemIds.clear();
            responseCreateQueued = false;
            queuedResponseInstructions = '';
            sentResponseInstructions = '';
            pendingInjectionAt = null;
            logger.info('upstream session ended after idle timeout', {
              code: event.error.code,
              message: event.error.message,
            });
            onEvent({ type: 'session.ended', reason: 'idle-timeout' });
            break;
          }
          // message 必须一起记：上游的 code 常常是 COMMON_ERROR 这种无信息量的占位，
          // 真正说明原因的只有 message。2026-07-26 真机踩到——现场只剩一个 COMMON_ERROR，
          // 解释在哪查不到（那句话当时只发给了渲染侧）。
          logger.warn('upstream error', { code: event.error?.code, message: event.error?.message });
          if (pendingInjectionAt !== null && Date.now() - pendingInjectionAt <= INJECTION_ACK_WINDOW_MS) {
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
      clearResponseWatchdog();
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
      respond(instructions?: string) {
        responseCreateQueued = true;
        queuedResponseInstructions = instructions?.trim() ?? '';
        sendResponseCreate();
      },
      injectItem(text: string) {
        // 与工具结果回灌同一套路：写进对话项后必须再发一次 response.create，
        // 否则模型收下了也不开口（handleToolCall 顶注是同一条踩坑）。
        // narration 继续使用这个 fire-and-forget 入口；用户文字走下面的 ack 入口，
        // 被拒时才能可靠回到 durable queue。
        sendInjectedItem(text, false);
      },
      injectItemWithAck(text: string) {
        const ack = sendInjectedItem(text, true);
        return ack ?? Promise.reject(new Error('voice injection was not sent'));
      },
      isResponding() {
        return Boolean(activeResponseId);
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
        clearResponseWatchdog();
        if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) ws.close();
      },
    };
  },
};
}
