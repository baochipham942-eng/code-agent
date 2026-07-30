// ============================================================================
// Qwen-Omni Realtime transport（DashScope，WebSocket 流式）
//
// Host 持 API key 建 WS，音频帧只在内存中转，不落盘、不进日志。
// 事件名以 DashScope 文档为准，2026-07-26 实测通过。
// ============================================================================

import WebSocket from 'ws';
import {
  QWEN_OMNI_REALTIME_MODEL,
  QWEN_OMNI_REALTIME_TRANSCRIPTION_MODEL,
  QWEN_OMNI_REALTIME_VOICE,
  QWEN_OMNI_REALTIME_WS_URL,
  VOICE_STALE_PREFIX_DEFAULTS_MS,
  VOICE_STALE_SILENCE_DEFAULTS_MS,
  VOICE_TURN_DETECTION_DEFAULT,
  VOICE_UPSTREAM_CONNECT_TIMEOUT_MS,
  VOICE_UPSTREAM_HEARTBEAT_INTERVAL_MS,
  VOICE_UPSTREAM_RESPONSE_TIMEOUT_MS,
  VOICE_UPSTREAM_SILENCE_TIMEOUT_MS,
} from '../../../shared/constants/voice';
import type { VoiceTransport, VoiceTransportHandle, VoiceTurnDetectionConfig } from '../../../shared/contract/voice';
import { getConfigService } from '../core/configService';
import { createLogger } from '../infra/logger';

const logger = createLogger('QwenOmniVoice');
const INJECTION_ACK_WINDOW_MS = 5_000;

interface UpstreamEvent {
  type: string;
  delta?: string;
  transcript?: string;
  audio?: string;
  error?: { code?: string; message?: string };
  [key: string]: unknown;
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
  | { type: 'server_vad'; threshold?: number; prefix_padding_ms?: number; silence_duration_ms?: number }
  | { type: 'semantic_vad'; eagerness?: 'low' | 'medium' | 'high' | 'auto' }
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
      ...(config.eagerness ? { eagerness: config.eagerness } : {}),
    };
  }
  return {
    type: 'server_vad',
    ...(config.threshold !== undefined ? { threshold: config.threshold } : {}),
    ...(config.prefixPaddingMs !== undefined ? { prefix_padding_ms: config.prefixPaddingMs } : {}),
    ...(config.silenceDurationMs !== undefined ? { silence_duration_ms: config.silenceDurationMs } : {}),
  };
}

export const qwenOmniTransport: VoiceTransport = {
  id: 'qwen-omni',

  async connect({ apiKey, config, onEvent, onAudio, onToolCall }): Promise<VoiceTransportHandle> {
    const model = config.model ?? QWEN_OMNI_REALTIME_MODEL;
    const turnDetectionConfig = resolveTurnDetectionConfig();
    const upstreamTurnDetection = toUpstreamTurnDetection(turnDetectionConfig);
    const vadSilenceWindowMs = turnDetectionConfig?.type === 'server_vad'
      ? turnDetectionConfig.silenceDurationMs
      : undefined;
    const registeredTools = onToolCall ? config.tools ?? [] : [];
    const url = `${QWEN_OMNI_REALTIME_WS_URL}?model=${encodeURIComponent(model)}`;
    logger.info('connecting upstream', {
      model,
      toolCount: registeredTools.length,
      // 「说了没反应」的头号嫌疑就是这个值（null = 手动档，上游等 commit 才回话）。
      // 此前它完全不可见，真机只能靠猜——2026-07-27 真机踩到。
      turnDetection: upstreamTurnDetection === null ? 'null(manual)' : upstreamTurnDetection.type,
      turnDetectionRaw: JSON.stringify(upstreamTurnDetection),
    });

    const ws = new WebSocket(url, { headers: { Authorization: `Bearer ${apiKey}` } });

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

    ws.send(
      JSON.stringify({
        type: 'session.update',
        session: {
          modalities: ['text', 'audio'],
          voice: config.voice ?? QWEN_OMNI_REALTIME_VOICE,
          input_audio_format: 'pcm16',
          output_audio_format: 'pcm16',
          input_audio_transcription: { model: QWEN_OMNI_REALTIME_TRANSCRIPTION_MODEL },
          turn_detection: upstreamTurnDetection,
          ...(config.instructions ? { instructions: config.instructions } : {}),
          // 没接执行出口就不注册工具：告诉模型有工具却没人执行，比不给工具更糟。
          ...(registeredTools.length ? { tools: registeredTools, tool_choice: 'auto' } : {}),
        },
      }),
    );

    // TTFA 模型口径从上游 speech_stopped 开始；体感口径不是实测值，
    // 是按 server_vad 先等待 silence_duration_ms 才发 speech_stopped 这一机制推算。
    /** item_id → 该轮到目前为止的用户字幕（delta 的 stash 是累计值）。completed 到货即清。 */
    const userTranscriptStash = new Map<string, string>();
    let speechStoppedAt = 0;
    let ttfaModelMs: number | undefined;
    let ttfaPerceivedMs: number | undefined;
    let responseActive = false;
    let pendingInjectionAt: number | null = null;
    let responseWatchdogTimer: ReturnType<typeof setTimeout> | null = null;
    let responseWatchdogNudged = false;
    let modelUnresponsiveNotified = false;

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
          ws.send(JSON.stringify({ type: 'response.create' }));
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

    /**
     * 工具结果回灌：写进对话项后必须再发一次 response.create，否则模型拿到结果也不开口。
     * 执行失败不抛回上游——把失败文案当结果说出去，比通话卡死好。
     */
    async function handleToolCall(callId: string, name: string, args: string): Promise<void> {
      const output = await onToolCall!({ callId, name, arguments: args })
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
          armResponseWatchdog();
          break;
        case 'response.created':
          clearResponseWatchdog();
          responseActive = true;
          pendingInjectionAt = null;
          break;
        case 'response.audio.delta':
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
          if (typeof event.delta === 'string') onEvent({ type: 'assistant.transcript', text: event.delta, done: false });
          break;
        case 'response.audio_transcript.done':
          onEvent({ type: 'assistant.transcript', text: typeof event.transcript === 'string' ? event.transcript : '', done: true });
          break;
        // 用户侧流式字幕（E3）。**文本在 `stash` 里，`text` 字段恒空**——2026-07-30
        // 真上游探针实测（26 个 delta，text 全是 len=0，stash 单调增长 2→21）。
        // stash 是**累计值**不是增量，所以直接当整句下发，renderer 的 partialUser 是替换语义。
        case 'conversation.item.input_audio_transcription.delta': {
          const stash = typeof event.stash === 'string' ? event.stash : '';
          const itemId = typeof event.item_id === 'string' ? event.item_id : '';
          if (!stash) break;
          if (itemId) userTranscriptStash.set(itemId, stash);
          onEvent({ type: 'user.transcript', text: stash, done: false });
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
          onEvent({ type: 'user.transcript', text, done: true });
          break;
        }
        case 'input_audio_buffer.speech_started':
          clearResponseWatchdog();
          speechStoppedAt = 0;
          ttfaModelMs = undefined;
          ttfaPerceivedMs = undefined;
          onEvent({ type: 'speech.started' });
          break;
        case 'input_audio_buffer.speech_stopped':
          speechStoppedAt = Date.now();
          break;
        case 'session.updated': {
          // 上游到底收下了什么档：我们发 server_vad、它回 null，就是「说了没反应」
          // 的直接证据（发出去 ≠ 被采纳）。
          const session = event.session as { tools?: unknown; turn_detection?: unknown } | undefined;
          const echoed = session?.turn_detection;
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
            if (!toolsDroppedNotified) {
              toolsDroppedNotified = true;
              onEvent({
                type: 'notice',
                code: 'VOICE_TOOLS_DROPPED',
                message: `当前通话模型（${model}）不支持在通话中派活，这通电话只能聊天`,
              });
            }
          }
          break;
        }
        case 'response.function_call_arguments.done':
          if (onToolCall && typeof event.call_id === 'string' && typeof event.name === 'string') {
            void handleToolCall(event.call_id, event.name, typeof event.arguments === 'string' ? event.arguments : '{}');
          }
          break;
        case 'response.done':
          responseActive = false;
          pendingInjectionAt = null;
          onEvent({
            type: 'response.done',
            ...(ttfaModelMs !== undefined ? { ttfaModelMs } : {}),
            ...(ttfaPerceivedMs !== undefined ? { ttfaPerceivedMs } : {}),
          });
          break;
        case 'error':
          // message 必须一起记：上游的 code 常常是 COMMON_ERROR 这种无信息量的占位，
          // 真正说明原因的只有 message。2026-07-26 真机踩到——现场只剩一个 COMMON_ERROR，
          // 解释在哪查不到（那句话当时只发给了渲染侧）。
          logger.warn('upstream error', { code: event.error?.code, message: event.error?.message });
          if (pendingInjectionAt !== null && Date.now() - pendingInjectionAt <= INJECTION_ACK_WINDOW_MS) {
            pendingInjectionAt = null;
            onEvent({ type: 'injection.rejected', message: event.error?.message ?? 'injection rejected' });
          } else {
            pendingInjectionAt = null;
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
      onEvent({ type: 'state', state: 'closed' });
    });
    ws.on('error', (err: Error) => onEvent({
      type: 'error',
      code: 'UPSTREAM_SOCKET',
      message: 'upstream socket error',
      detail: err.message,
    }));

    onEvent({ type: 'state', state: 'live' });

    return {
      kind: 'relay',
      provider: 'qwen-omni',
      sendAudio(frame: Buffer) {
        if (ws.readyState !== WebSocket.OPEN) return;
        ws.send(JSON.stringify({ type: 'input_audio_buffer.append', audio: frame.toString('base64') }));
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
        ws.send(JSON.stringify({ type: 'response.create' }));
      },
      injectItem(text: string) {
        if (ws.readyState !== WebSocket.OPEN) return;
        // 与工具结果回灌同一套路：写进对话项后必须再发一次 response.create，
        // 否则模型收下了也不开口（handleToolCall 顶注是同一条踩坑）。
        ws.send(JSON.stringify({
          type: 'conversation.item.create',
          item: { type: 'message', role: 'user', content: [{ type: 'input_text', text }] },
        }));
        pendingInjectionAt = Date.now();
        ws.send(JSON.stringify({ type: 'response.create' }));
      },
      isResponding() {
        return responseActive;
      },
      interrupt() {
        if (ws.readyState !== WebSocket.OPEN) return;
        ws.send(JSON.stringify({ type: 'response.cancel' }));
      },
      async close() {
        clearHeartbeat();
        clearResponseWatchdog();
        if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) ws.close();
      },
    };
  },
};
