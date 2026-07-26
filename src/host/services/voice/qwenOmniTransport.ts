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
  VOICE_UPSTREAM_CONNECT_TIMEOUT_MS,
} from '../../../shared/constants/voice';
import type { VoiceTransport, VoiceTransportHandle } from '../../../shared/contract/voice';
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

export const qwenOmniTransport: VoiceTransport = {
  id: 'qwen-omni',

  async connect({ apiKey, config, onEvent, onAudio }): Promise<VoiceTransportHandle> {
    const model = config.model ?? QWEN_OMNI_REALTIME_MODEL;
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
          // server_vad：上游断句并自动触发回复，全双工体验的默认档。
          turn_detection: { type: 'server_vad' },
          ...(config.instructions ? { instructions: config.instructions } : {}),
        },
      }),
    );

    // TTFA = 用户说完（上游 speech_stopped）→ 第一个下行音频包。
    let speechStoppedAt = 0;
    let ttfaMs: number | undefined;

    ws.on('message', (raw) => {
      const event = parseEvent(raw);
      if (!event) return;

      switch (event.type) {
        case 'response.audio.delta':
          if (typeof event.delta === 'string') {
            if (speechStoppedAt && ttfaMs === undefined) {
              ttfaMs = Date.now() - speechStoppedAt;
              logger.info('ttfa', { ms: ttfaMs });
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
          ttfaMs = undefined;
          onEvent({ type: 'speech.started' });
          break;
        case 'input_audio_buffer.speech_stopped':
          speechStoppedAt = Date.now();
          break;
        case 'response.done':
          onEvent({ type: 'response.done', ttfaMs });
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
      provider: 'qwen-omni',
      clientBootstrap: null,
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
