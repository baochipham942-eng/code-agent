// ============================================================================
// Gummy Realtime transport（DashScope，WebSocket 流式识别）
//
// Host 持 API key；PCM16 二进制帧只在内存中转，不落盘、不写日志。
// ============================================================================

import { randomUUID } from 'node:crypto';
import WebSocket from 'ws';
import {
  GUMMY_REALTIME_FINISH_TIMEOUT_MS,
  GUMMY_REALTIME_MAX_END_SILENCE_MS,
  GUMMY_REALTIME_MODEL,
  GUMMY_REALTIME_PRESTART_FRAME_LIMIT,
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
  streamId: string;
  signal?: AbortSignal;
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
  streamId,
  signal,
  onTranscript,
  onError,
}: GummyRealtimeConnectOptions): Promise<GummyRealtimeHandle> {
  const taskId = randomUUID().replace(/-/g, '');
  const ws = new WebSocket(GUMMY_REALTIME_WS_URL, {
    headers: { Authorization: `Bearer ${apiKey}` },
  });

  await new Promise<void>((resolve, reject) => {
    let settled = false;
    const onOpen = () => settle();
    const onConnectError = (err: Error) => {
      ws.terminate();
      settle(err);
    };
    const onAbort = () => {
      ws.terminate();
      settle(new Error('Gummy realtime connection cancelled'));
    };
    const cleanup = () => {
      clearTimeout(timer);
      ws.off('open', onOpen);
      ws.off('error', onConnectError);
      signal?.removeEventListener('abort', onAbort);
    };
    const settle = (err?: Error) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (err) reject(err);
      else resolve();
    };
    const timer = setTimeout(() => {
      ws.terminate();
      settle(new Error('SPEECH_NO_CHANNEL'));
    }, VOICE_UPSTREAM_CONNECT_TIMEOUT_MS);
    ws.once('open', onOpen);
    ws.once('error', onConnectError);
    signal?.addEventListener('abort', onAbort, { once: true });
    if (signal?.aborted) onAbort();
  });
  logger.info('upstream connection established', { streamId });

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
  let finishTimer: ReturnType<typeof setTimeout> | null = null;
  let releaseLogged = false;
  // task-started 之前不许推音频（协议约束）；这些帧先攒着，别把用户的第一个字吞掉。
  let prestartFrames: Buffer[] | null = [];

  const logReleased = (reason: string) => {
    if (releaseLogged) return;
    releaseLogged = true;
    logger.info('upstream connection released', { streamId, reason });
  };

  const closeSocket = (reason: string) => {
    if (finishTimer) {
      clearTimeout(finishTimer);
      finishTimer = null;
    }
    prestartFrames = null;
    if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) ws.close();
    logReleased(reason);
  };

  /** 收尾只有一个出口：settle 一次 + 关连接（这是按秒计费的上游，泄漏一条就一直在烧钱）。 */
  const settleFinish = (err?: Error, reason = err ? 'error' : 'task-finished') => {
    if (!settled) {
      settled = true;
      if (err) finishReject?.(err);
      else finishResolve?.();
    }
    closeSocket(reason);
  };

  const sendFinish = () => {
    if (!taskStarted || !finishRequested || ws.readyState !== WebSocket.OPEN) return;
    ws.send(JSON.stringify({
      header: { action: 'finish-task', task_id: taskId, streaming: 'duplex' },
      payload: { input: {} },
    }));
  };

  const fail = (code: string, message: string) => {
    logger.warn('upstream task failed', { code, message });
    onError(code, message);
    settleFinish(new Error(message));
  };

  ws.on('message', (raw) => {
    const event = parseEvent(raw);
    if (!event) return;
    switch (event.header?.event) {
      case 'task-started': {
        taskStarted = true;
        const buffered = prestartFrames ?? [];
        prestartFrames = null;
        if (ws.readyState === WebSocket.OPEN) {
          for (const frame of buffered) ws.send(frame, { binary: true });
        }
        sendFinish();
        break;
      }
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
        settleFinish();
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
    logReleased('socket-close');
    if (finishRequested) settleFinish(new Error('Gummy realtime connection closed before task finished'));
  });

  return {
    sendAudio(frame: Buffer) {
      if (finishRequested) return;
      // 协议要求 task-started 之后才允许推音频。起步阶段的帧先缓冲——直接丢会把
      // 用户的第一个字吞掉；缓冲封顶，上游一直不回也不会把内存吃光。
      if (!taskStarted) {
        if (prestartFrames && prestartFrames.length < GUMMY_REALTIME_PRESTART_FRAME_LIMIT) {
          prestartFrames.push(frame);
        }
        return;
      }
      if (ws.readyState !== WebSocket.OPEN) return;
      ws.send(frame, { binary: true });
    },
    finish() {
      if (settled) return Promise.resolve();
      return new Promise<void>((resolve, reject) => {
        finishResolve = resolve;
        finishReject = reject;
        if (finishRequested) return;
        finishRequested = true;
        // 连接已经不在了就别等一帧永远不会来的 task-finished：调用方会一直卡在
        // 「识别中」，那条 WS 也一直挂着计费。
        if (ws.readyState !== WebSocket.OPEN) {
          settleFinish();
          return;
        }
        sendFinish();
        finishTimer = setTimeout(() => {
          logger.warn('finish-task timed out, closing upstream', { timeoutMs: GUMMY_REALTIME_FINISH_TIMEOUT_MS });
          // 超时按收尾成功处理：已经落到输入框的文字留着，比弹一个「识别失败」有用。
          settleFinish();
        }, GUMMY_REALTIME_FINISH_TIMEOUT_MS);
      });
    },
    close() {
      settleFinish(new Error('Gummy realtime connection closed'), 'client-close');
    },
  };
}
