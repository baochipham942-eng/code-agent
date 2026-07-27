// ============================================================================
// Gummy Realtime transport（DashScope，WebSocket 流式识别）
//
// Host 持 API key；PCM16 二进制帧只在内存中转，不落盘、不写日志。
// ============================================================================

import { randomUUID } from 'node:crypto';
import WebSocket from 'ws';
import {
  GUMMY_REALTIME_MAX_END_SILENCE_MS,
  GUMMY_REALTIME_MODEL,
  GUMMY_REALTIME_SAMPLE_RATE,
  GUMMY_REALTIME_WS_URL,
  VOICE_UPSTREAM_CONNECT_TIMEOUT_MS,
} from '../../../shared/constants/voice';
import { createLogger } from '../infra/logger';

const logger = createLogger('GummyDictation');

export interface GummyTranscript {
  text: string;
  sentenceId: number;
  done: boolean;
}

export interface GummyRealtimeHandle {
  sendAudio(frame: Buffer): void;
  finish(): Promise<void>;
  close(): void;
}

export interface GummyRealtimeConnectOptions {
  apiKey: string;
  onTranscript: (transcript: GummyTranscript) => void;
  onError: (code: string, message: string) => void;
}

interface GummyEvent {
  header?: {
    event?: string;
    error_code?: string;
    error_message?: string;
  };
  payload?: {
    output?: {
      transcription?: {
        sentence_id?: number;
        text?: string;
        sentence_end?: boolean;
      };
    };
  };
}

function parseEvent(raw: unknown): GummyEvent | null {
  try {
    const parsed: unknown = JSON.parse(String(raw));
    return parsed && typeof parsed === 'object' ? parsed as GummyEvent : null;
  } catch {
    // 上游非 JSON 帧可能含不可记录内容，静默忽略。
    return null;
  }
}

export async function connectGummyRealtime({
  apiKey,
  onTranscript,
  onError,
}: GummyRealtimeConnectOptions): Promise<GummyRealtimeHandle> {
  const taskId = randomUUID().replace(/-/g, '');
  const ws = new WebSocket(GUMMY_REALTIME_WS_URL, {
    headers: { Authorization: `Bearer ${apiKey}` },
  });

  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      ws.terminate();
      reject(new Error('SPEECH_NO_CHANNEL'));
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

  ws.send(JSON.stringify({
    header: { action: 'run-task', task_id: taskId, streaming: 'duplex' },
    payload: {
      task_group: 'audio',
      task: 'asr',
      function: 'recognition',
      model: GUMMY_REALTIME_MODEL,
      input: {},
      parameters: {
        sample_rate: GUMMY_REALTIME_SAMPLE_RATE,
        format: 'pcm',
        source_language: 'auto',
        transcription_enabled: true,
        translation_enabled: false,
        max_end_silence: GUMMY_REALTIME_MAX_END_SILENCE_MS,
      },
    },
  }));

  let taskStarted = false;
  let finishRequested = false;
  let settled = false;
  let finishResolve: (() => void) | null = null;
  let finishReject: ((err: Error) => void) | null = null;

  const closeSocket = () => {
    if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) ws.close();
  };

  const sendFinish = () => {
    if (!taskStarted || !finishRequested || ws.readyState !== WebSocket.OPEN) return;
    ws.send(JSON.stringify({
      header: { action: 'finish-task', task_id: taskId, streaming: 'duplex' },
      payload: { input: {} },
    }));
  };

  const fail = (code: string, message: string) => {
    if (!settled) {
      settled = true;
      finishReject?.(new Error(message));
    }
    logger.warn('upstream task failed', { code, message });
    onError(code, message);
    closeSocket();
  };

  ws.on('message', (raw) => {
    const event = parseEvent(raw);
    if (!event) return;
    switch (event.header?.event) {
      case 'task-started':
        taskStarted = true;
        sendFinish();
        break;
      case 'result-generated': {
        const transcription = event.payload?.output?.transcription;
        if (
          typeof transcription?.text === 'string'
          && typeof transcription.sentence_id === 'number'
          && typeof transcription.sentence_end === 'boolean'
        ) {
          onTranscript({
            text: transcription.text,
            sentenceId: transcription.sentence_id,
            done: transcription.sentence_end,
          });
        }
        break;
      }
      case 'task-finished':
        if (!settled) {
          settled = true;
          finishResolve?.();
        }
        closeSocket();
        break;
      case 'task-failed':
        fail(
          event.header.error_code ?? 'SPEECH_NO_CHANNEL',
          event.header.error_message ?? 'Gummy realtime task failed',
        );
        break;
      default:
        break;
    }
  });

  ws.on('error', (err: Error) => {
    fail('SPEECH_NO_CHANNEL', err.message);
  });
  ws.on('close', () => {
    if (finishRequested && !settled) {
      settled = true;
      finishReject?.(new Error('Gummy realtime connection closed before task finished'));
    }
  });

  return {
    sendAudio(frame: Buffer) {
      // 官方协议要求 task-started 之后才允许推音频；起步阶段的帧直接丢弃。
      if (!taskStarted || finishRequested || ws.readyState !== WebSocket.OPEN) return;
      ws.send(frame, { binary: true });
    },
    finish() {
      if (settled) return Promise.resolve();
      return new Promise<void>((resolve, reject) => {
        finishResolve = resolve;
        finishReject = reject;
        if (!finishRequested) {
          finishRequested = true;
          sendFinish();
        }
      });
    },
    close() {
      if (!settled) {
        settled = true;
        finishReject?.(new Error('Gummy realtime connection closed'));
      }
      closeSocket();
    },
  };
}
