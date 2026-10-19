// realtimeTransport 的上游 WS 连接生命周期件（N-MAXLINES-MINEFIELD-2-FU1-S3 逐字拆出）：
// 代理解析、建连超时、心跳看门狗、首次 session.update 握手。行为零变化，只做代码搬家。
import WebSocket from 'ws';
import {
  VOICE_UPSTREAM_CONNECT_TIMEOUT_MS,
  VOICE_UPSTREAM_HEARTBEAT_INTERVAL_MS,
  VOICE_UPSTREAM_SILENCE_TIMEOUT_MS,
} from '../../../shared/constants/voice';
import type { RealtimeVoiceProviderProfile } from '../../../shared/constants/realtimeVoiceProviders';
import type { VoiceEvent } from '../../../shared/contract/voice';
import { createLogger } from '../infra/logger';
import { getHttpsAgent } from '../../model/providers/providerHttp';

const logger = createLogger('RealtimeVoice');
// Realtime 协议族的 provider 不保证必发 session.updated；超时降级是预期路径，不是建连失败。
const INITIAL_SESSION_HANDSHAKE_TIMEOUT_MS = 8_000;

export function resolveProxyAgent(profile: RealtimeVoiceProviderProfile, url: string) {
  if (!profile.needsProxy) return undefined;
  // Built-in providers retain their provider-level direct/proxy override.
  // Custom realtime IDs are not part of the model-provider registry, so passing
  // their ID would classify them as direct. Let the target URL and global proxy
  // settings decide instead.
  return profile.id === 'openai-realtime'
    ? getHttpsAgent(url, profile.keyProvider)
    : getHttpsAgent(url);
}

export async function waitForWebSocketOpen(ws: WebSocket): Promise<void> {
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
}

export function startUpstreamHeartbeat(
  ws: WebSocket,
  onEvent: (event: VoiceEvent) => void,
): { markSignal: () => void; clear: () => void } {
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

  return { markSignal: markUpstreamSignal, clear: clearHeartbeat };
}

export function createInitialSessionHandshake(): { promise: Promise<boolean>; confirm: () => void } {
  let confirmHandshake: (() => void) | null = null;
  const promise = new Promise<boolean>((resolve) => {
    let settled = false;
    const finish = (confirmed: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      confirmHandshake = null;
      resolve(confirmed);
    };
    const timer = setTimeout(() => finish(false), INITIAL_SESSION_HANDSHAKE_TIMEOUT_MS);
    confirmHandshake = () => finish(true);
  });
  return { promise, confirm: () => confirmHandshake?.() };
}
