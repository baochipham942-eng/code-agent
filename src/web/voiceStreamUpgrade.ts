// ============================================================================
// 实时语音媒体面的 WS upgrade 处理器
//
// 只认 VOICE_STREAM_WS_PATH，鉴权用 webServer 同一个 SERVER_AUTH_TOKEN
// （query token，与 SSE /api/events 同款——WebSocket 浏览器 API 不能自定义 header）。
// ============================================================================

import type { Server } from 'http';
import { WebSocketServer } from 'ws';
import { VOICE_STREAM_WS_PATH } from '../shared/constants/voice';
import { attachVoiceClient } from '../host/services/voice/voiceSessionService';
import { verifyToken } from './middleware/auth';

export function attachVoiceStreamUpgrade(server: Server): void {
  const wss = new WebSocketServer({ noServer: true });

  server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    if (url.pathname !== VOICE_STREAM_WS_PATH) return; // 其他路径留给别的 upgrade 消费者

    const token = url.searchParams.get('token');
    if (!token || !verifyToken(token)) {
      socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
      socket.destroy();
      return;
    }

    const neoSessionId = url.searchParams.get('sessionId');
    if (!neoSessionId) {
      socket.write('HTTP/1.1 400 Bad Request\r\n\r\n');
      socket.destroy();
      return;
    }

    wss.handleUpgrade(req, socket, head, (client) => {
      void attachVoiceClient(client, neoSessionId);
    });
  });
}
