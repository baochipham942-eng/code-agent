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
    const configured = getConfigService().getSettings().voice?.turnDetection;
    return configured === undefined ? VOICE_TURN_DETECTION_DEFAULT : configured;
  } catch {
    return VOICE_TURN_DETECTION_DEFAULT;
  }
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

  async connect({ apiKey, config, onEvent, onAudio }): Promise<VoiceTransportHandle> {
    const model = config.model ?? QWEN_OMNI_REALTIME_MODEL;
    const turnDetectionConfig = resolveTurnDetectionConfig();
    const upstreamTurnDetection = toUpstreamTurnDetection(turnDetectionConfig);
    const vadSilenceWindowMs = turnDetectionConfig?.type === 'server_vad'
      ? turnDetectionConfig.silenceDurationMs
      : undefined;
    const url = `${QWEN_OMNI_REALTIME_WS_URL}?model=${encodeURIComponent(model)}`;
    logger.info('connecting upstream', { model });

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
        },
      }),
    );

    // TTFA 模型口径从上游 speech_stopped 开始；体感口径不是实测值，
    // 是按 server_vad 先等待 silence_duration_ms 才发 speech_stopped 这一机制推算。
    let speechStoppedAt = 0;
    let ttfaModelMs: number | undefined;
    let ttfaPerceivedMs: number | undefined;

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
        case 'response.done':
          onEvent({
            type: 'response.done',
            ...(ttfaModelMs !== undefined ? { ttfaModelMs } : {}),
            ...(ttfaPerceivedMs !== undefined ? { ttfaPerceivedMs } : {}),
          });
          break;
        case 'error':
          logger.warn('upstream error', { code: event.error?.code });
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
