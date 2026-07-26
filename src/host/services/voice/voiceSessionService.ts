// ============================================================================
// VoiceSessionService —— Phase 0 最小实现
//
// 职责：全局单路互斥、生命周期、Renderer WS ↔ 上游 transport 的内存中继。
// 媒体面：Renderer 二进制帧 = PCM16@16k 单声道上行；Host 二进制帧 = PCM16@24k 下行。
//         控制/事件面走同一条 WS 的文本帧（JSON）。音频帧不落盘、不进日志。
// ============================================================================

import type { WebSocket as WsSocket } from 'ws';
import { VOICE_SESSION_MAX_DURATION_MS } from '../../../shared/constants/voice';
import type { VoiceClientCommand, VoiceEvent, VoiceTransportHandle } from '../../../shared/contract/voice';
import { getDashscopeApiKey } from '../media/imageGenerationService';
import { createLogger } from '../infra/logger';
import { qwenOmniTransport } from './qwenOmniTransport';

const logger = createLogger('VoiceSession');

interface ActiveSession {
  id: string;
  neoSessionId: string;
  client: WsSocket;
  upstream: VoiceTransportHandle;
  maxDurationTimer: NodeJS.Timeout;
}

// ponytail: 单进程内一个模块级变量就是「全局单路」的全部实现（方案 §2.6）。
// 多进程/多窗口场景真出现时再抬到共享状态。
let active: ActiveSession | null = null;
let sessionSeq = 0;

export function getActiveVoiceSessionId(): string | null {
  return active?.id ?? null;
}

function send(client: WsSocket, event: VoiceEvent): void {
  if (client.readyState === client.OPEN) client.send(JSON.stringify(event));
}

async function teardown(reason: string): Promise<void> {
  const session = active;
  if (!session) return;
  active = null;
  clearTimeout(session.maxDurationTimer);
  logger.info('session ended', { voiceSessionId: session.id, reason });
  await session.upstream.close().catch(() => undefined);
  if (session.client.readyState === session.client.OPEN) session.client.close();
}

/**
 * 接管一条来自 Renderer 的媒体面 WS。webServer 的 upgrade 处理器调用。
 * 互斥：已有活跃通话时直接拒绝，不排队。
 */
export async function attachVoiceClient(client: WsSocket, neoSessionId: string): Promise<void> {
  if (active) {
    send(client, { type: 'error', code: 'VOICE_SESSION_BUSY', message: '已有一路通话在进行中' });
    client.close();
    return;
  }

  const apiKey = getDashscopeApiKey();
  if (!apiKey) {
    send(client, { type: 'error', code: 'VOICE_PROVIDER_UNCONFIGURED', message: '未配置 DashScope API Key' });
    client.close();
    return;
  }

  const id = `voice-${Date.now()}-${++sessionSeq}`;
  send(client, { type: 'state', state: 'connecting' });

  let upstream: VoiceTransportHandle;
  try {
    upstream = await qwenOmniTransport.connect({
      apiKey,
      config: { neoSessionId },
      onEvent: (event) => send(client, event),
      onAudio: (frame) => {
        if (client.readyState === client.OPEN) client.send(frame, { binary: true });
      },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'connect failed';
    logger.warn('upstream connect failed', { voiceSessionId: id, message });
    send(client, { type: 'error', code: 'VOICE_UPSTREAM_UNAVAILABLE', message });
    client.close();
    return;
  }

  // 客户端在 await 期间就断了：别留悬空的上游连接（会持续计费）。
  if (client.readyState !== client.OPEN) {
    await upstream.close().catch(() => undefined);
    return;
  }

  active = {
    id,
    neoSessionId,
    client,
    upstream,
    maxDurationTimer: setTimeout(() => {
      logger.warn('session hit max duration, force closing', { voiceSessionId: id });
      void teardown('max-duration');
    }, VOICE_SESSION_MAX_DURATION_MS),
  };
  logger.info('session started', { voiceSessionId: id, neoSessionId });

  client.on('message', (data: Buffer, isBinary: boolean) => {
    if (active?.id !== id) return;
    if (isBinary) {
      upstream.sendAudio(data);
      return;
    }
    let command: VoiceClientCommand;
    try {
      command = JSON.parse(data.toString()) as VoiceClientCommand;
    } catch {
      return;
    }
    if (command.type === 'end') void teardown('client-end');
    else if (command.type === 'interrupt') upstream.interrupt();
  });

  client.on('close', () => {
    if (active?.id === id) void teardown('client-closed');
  });
  client.on('error', () => {
    if (active?.id === id) void teardown('client-error');
  });
}

/** 测试用：强制释放当前通话。 */
export async function endActiveVoiceSession(): Promise<void> {
  await teardown('explicit-end');
}
