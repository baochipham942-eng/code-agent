// ============================================================================
// Dictation 流式识别 WS upgrade：query token 鉴权，路径不匹配时交给其他处理器。
// ============================================================================

import { WebSocketServer } from 'ws';
import { DICTATION_STREAM_WS_PATH } from '../shared/constants/voice';
import { attachDictationClient } from '../host/services/speech/dictationStreamService';
import type { HostWebSocketUpgradeContribution } from '../host/services/capabilities/hostCapabilityContributions';
import { createLogger } from '../host/services/infra/logger';
import { verifyToken } from './middleware/auth';

const logger = createLogger('DictationUpgrade');

export function createDictationStreamUpgradeContribution(): HostWebSocketUpgradeContribution {
  const wss = new WebSocketServer({ noServer: true });
  return {
    path: DICTATION_STREAM_WS_PATH,
    handleUpgrade(req, socket, head) {
      const url = new URL(req.url ?? '/', 'http://localhost');
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
    },
    cleanup() {
      for (const client of wss.clients) client.close(1001, 'voice-input capability unloaded');
      wss.close();
    },
  };
}
