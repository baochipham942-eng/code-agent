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
  VOICE_TURN_DETECTION_DEFAULT,
  VOICE_UPSTREAM_CONNECT_TIMEOUT_MS,
} from '../../../shared/constants/voice';
import type { VoiceTransport, VoiceTransportHandle, VoiceTurnDetectionConfig } from '../../../shared/contract/voice';
import { getConfigService } from '../core/configService';
import { createLogger } from '../infra/logger';

const logger = createLogger('QwenOmniVoice');

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
    return configured === undefined ? VOICE_TURN_DETECTION_DEFAULT : configured;
  } catch {
    return VOICE_TURN_DETECTION_DEFAULT;
  }
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
    logger.info('connecting upstream', { model, toolCount: registeredTools.length });

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
    let speechStoppedAt = 0;
    let ttfaModelMs: number | undefined;
    let ttfaPerceivedMs: number | undefined;

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

    ws.on('message', (raw) => {
      const event = parseEvent(raw);
      if (!event) return;

      switch (event.type) {
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
        case 'conversation.item.input_audio_transcription.completed':
          onEvent({ type: 'user.transcript', text: typeof event.transcript === 'string' ? event.transcript : '', done: true });
          break;
        case 'input_audio_buffer.speech_started':
          speechStoppedAt = 0;
          ttfaModelMs = undefined;
          ttfaPerceivedMs = undefined;
          onEvent({ type: 'speech.started' });
          break;
        case 'input_audio_buffer.speech_stopped':
          speechStoppedAt = Date.now();
          break;
        case 'session.updated':
          // 静默降级留痕：上一代模型对 tools 是「收下不报错、回显 null」，
          // 不告警的话现场只能看到「模型死活不肯派活」，查不到根因。
          if (registeredTools.length && !upstreamAcceptedTools(event)) {
            logger.warn('upstream dropped registered tools (model likely lacks function calling)', {
              model,
              sent: registeredTools.length,
            });
          }
          break;
        case 'response.function_call_arguments.done':
          if (onToolCall && typeof event.call_id === 'string' && typeof event.name === 'string') {
            void handleToolCall(event.call_id, event.name, typeof event.arguments === 'string' ? event.arguments : '{}');
          }
          break;
        case 'response.done':
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
          onEvent({
            type: 'error',
            code: event.error?.code ?? 'UPSTREAM_ERROR',
            message: event.error?.message ?? 'upstream error',
          });
          break;
        default:
          break;
      }
    });

    ws.on('close', () => onEvent({ type: 'state', state: 'closed' }));
    ws.on('error', (err: Error) => onEvent({ type: 'error', code: 'UPSTREAM_SOCKET', message: err.message }));

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
      interrupt() {
        if (ws.readyState !== WebSocket.OPEN) return;
        ws.send(JSON.stringify({ type: 'response.cancel' }));
      },
      async close() {
        if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) ws.close();
      },
    };
  },
};
