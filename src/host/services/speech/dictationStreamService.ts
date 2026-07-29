// ============================================================================
// Dictation 流式会话：Renderer PCM16 ↔ Gummy transcription。
// 每条客户端 WS 独占一路上游；任一侧结束都立即释放另一侧，避免持续计费。
// ============================================================================

import { randomUUID } from 'node:crypto';
import type { WebSocket as WsSocket } from 'ws';
import { getDashscopeApiKey } from '../media/imageGenerationService';
import { createLogger } from '../infra/logger';
import {
  connectGummyRealtime,
  type GummyRealtimeHandle,
} from './gummyRealtimeTransport';

const logger = createLogger('DictationStream');

type DictationServerEvent =
  | { type: 'partial' | 'final'; text: string; sentenceId: number }
  | { type: 'error'; code: string; message: string };

function send(client: WsSocket, event: DictationServerEvent): void {
  if (client.readyState === client.OPEN) client.send(JSON.stringify(event));
}

export async function attachDictationClient(client: WsSocket): Promise<void> {
  const streamId = randomUUID();
  const connectAbort = new AbortController();
  let upstream: GummyRealtimeHandle | null = null;
  let clientGone = false;
  let stopping = false;

  const closeAll = () => {
    connectAbort.abort();
    upstream?.close();
    if (client.readyState === client.OPEN) client.close();
  };

  client.once('close', () => {
    clientGone = true;
    closeAll();
  });
  client.once('error', () => {
    clientGone = true;
    closeAll();
  });

  const apiKey = getDashscopeApiKey();
  if (!apiKey) {
    send(client, {
      type: 'error',
      code: 'SPEECH_NO_CHANNEL',
      message: '未配置 DashScope API Key',
    });
    client.close();
    return;
  }

  try {
    upstream = await connectGummyRealtime({
      apiKey,
      streamId,
      signal: connectAbort.signal,
      onTranscript: ({ text, sentenceId, done }) => {
        send(client, { type: done ? 'final' : 'partial', text, sentenceId });
      },
      onError: (code, message) => {
        send(client, { type: 'error', code, message });
        closeAll();
      },
    });
  } catch (err) {
    if (clientGone) return;
    const message = err instanceof Error ? err.message : 'Gummy realtime connection failed';
    logger.warn('upstream connect failed', { streamId, message });
    send(client, { type: 'error', code: 'SPEECH_NO_CHANNEL', message });
    client.close();
    return;
  }

  // 客户端可能在上游握手期间已断开，不能留一条无人消费的计费连接。
  if (clientGone || client.readyState !== client.OPEN) {
    upstream.close();
    return;
  }

  client.on('message', (data: Buffer, isBinary: boolean) => {
    if (isBinary) {
      if (!stopping) upstream?.sendAudio(data);
      return;
    }

    try {
      const command = JSON.parse(data.toString()) as { type?: string };
      if (command.type !== 'stop' || stopping) return;
      stopping = true;
      void upstream?.finish()
        .then(() => {
          if (client.readyState === client.OPEN) client.close();
        })
        .catch((err: unknown) => {
          const message = err instanceof Error ? err.message : 'Gummy realtime finish failed';
          send(client, { type: 'error', code: 'SPEECH_NO_CHANNEL', message });
          closeAll();
        });
    } catch {
      // 非法控制帧忽略；不要把原文写日志。
    }
  });
}
