// ============================================================================
// 实时语音媒体面的 WS upgrade 处理器
//
// Renderer ↔ Host 的音频通道：二进制帧 = PCM 音频，文本帧 = 事件/控制。
// 音频帧率高（双向各 ~10 帧/秒），走不了请求/响应式 IPC，所以在 webServer 上
// 单开一条 WS。只认 VOICE_STREAM_WS_PATH，鉴权复用同一个 SERVER_AUTH_TOKEN
// （query token，与 SSE /api/events 同款——WebSocket 浏览器 API 不能自定义 header）。
// ============================================================================

import type { Server } from 'http';
import { WebSocketServer } from 'ws';
import { VOICE_STREAM_WS_PATH } from '../shared/constants/voice';
import { attachVoiceClient } from '../host/services/voice/voiceSessionService';
import { createLogger } from '../host/services/infra/logger';
import { verifyToken } from './middleware/auth';

const logger = createLogger('VoiceUpgrade');

export function attachVoiceStreamUpgrade<T extends Server>(server: T): T {
  const wss = new WebSocketServer({ noServer: true });

  server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    if (url.pathname !== VOICE_STREAM_WS_PATH) return; // 其他路径留给别的 upgrade 消费者

    // 拒绝路径必须留痕：静默 403 会让「客户端连不上」在 host 日志里完全不可见。
    const token = url.searchParams.get('token');
    if (!token || !verifyToken(token)) {
      logger.warn('rejected voice upgrade', { reason: token ? 'invalid-token' : 'missing-token' });
      socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
      socket.destroy();
      return;
    }

    const neoSessionId = url.searchParams.get('sessionId');
    if (!neoSessionId) {
      logger.warn('rejected voice upgrade', { reason: 'missing-session-id' });
      socket.write('HTTP/1.1 400 Bad Request\r\n\r\n');
      socket.destroy();
      return;
    }

    // 通话身份来自 Renderer 的 activeAgentId（按会话存在 Renderer 侧，host 无存量可查）。
    // 缺省 = 会话默认 agent，不是错误，所以不拒绝握手。
    const requestedAgentId = url.searchParams.get('agentId') ?? undefined;

    wss.handleUpgrade(req, socket, head, (client) => {
      void attachVoiceClient(client, neoSessionId, requestedAgentId);
    });
  });

  return server;
}
