// ============================================================================
// Dictation 流式识别 WS upgrade：query token 鉴权，路径不匹配时交给其他处理器。
// ============================================================================

import type { Server } from 'http';
import { WebSocketServer } from 'ws';
import { DICTATION_STREAM_WS_PATH } from '../shared/constants/voice';
import { attachDictationClient } from '../host/services/speech/dictationStreamService';
import { createLogger } from '../host/services/infra/logger';
import { verifyToken } from './middleware/auth';

const logger = createLogger('DictationUpgrade');

export function attachDictationStreamUpgrade<T extends Server>(server: T): T {
  const wss = new WebSocketServer({ noServer: true });

  server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    if (url.pathname !== DICTATION_STREAM_WS_PATH) return;

    const token = url.searchParams.get('token');
    if (!token || !verifyToken(token)) {
      logger.warn('rejected dictation upgrade', {
        reason: token ? 'invalid-token' : 'missing-token',
      });
      socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
      socket.destroy();
      return;
    }

    wss.handleUpgrade(req, socket, head, (client) => {
      void attachDictationClient(client);
    });
  });

  return server;
}
