import { Router, type Request, type Response } from 'express';
import { WebSocketServer } from 'ws';
import { VOICE_STREAM_WS_PATH } from '../../../shared/constants/voice';
import type { VoiceStatusResponse } from '../../../shared/contract/voice';
import type {
  HostWebRouteContribution,
  HostWebSocketUpgradeContribution,
} from '../capabilities/hostCapabilityContributions';
import { getConfigService } from '../core/configService';
import { getDashscopeApiKey } from '../media/imageGenerationService';
import { createLogger } from '../infra/logger';
import { verifyToken } from '../../../web/middleware/auth';
import {
  getRealtimeVoiceProviderApiKey,
  resolveConfiguredRealtimeVoiceProfile,
} from './customRealtimeVoiceProviders';
import { getActiveVoiceSessionId, attachVoiceClient } from './voiceSessionService';
import { getVoiceUsageSummary } from './voiceUsageLedger';
import {
  formatVoiceCallTimelineMarkdown,
  getVoiceCallTimeline,
  listVoiceCalls,
} from './voiceCallAudit';

const logger = createLogger('VoiceUpgrade');

export function createVoiceWebRouteContribution(): HostWebRouteContribution {
  const router = Router();
  router.get('/voice/status', (_req: Request, res: Response) => {
    const settings = getConfigService().getSettings();
    const profile = resolveConfiguredRealtimeVoiceProfile(settings.voice?.live?.providerId, settings.voice?.live);
    const configured = profile.id === 'dashscope-qwen-omni'
      ? Boolean(getDashscopeApiKey())
      : Boolean(getRealtimeVoiceProviderApiKey(profile));
    const payload: VoiceStatusResponse = {
      provider: profile.id,
      configured,
      active: getActiveVoiceSessionId() !== null,
      usage: getVoiceUsageSummary(Date.now()),
    };
    res.json(payload);
  });
  router.get('/voice/calls', (req: Request, res: Response) => {
    const limit = Number(req.query.limit) || 50;
    res.json({ calls: listVoiceCalls(Math.min(Math.max(limit, 1), 500)) });
  });
  router.get('/voice/calls/:id/timeline', (req: Request, res: Response) => {
    const id = String(req.params.id);
    const timeline = getVoiceCallTimeline(id);
    if (!timeline) {
      res.status(404).json({ error: 'voice call not found', id });
      return;
    }
    if (req.query.format === 'markdown') {
      res.type('text/markdown; charset=utf-8').send(formatVoiceCallTimelineMarkdown(timeline));
      return;
    }
    res.json(timeline);
  });
  return { path: '/voice', handler: router };
}

export function createVoiceStreamUpgradeContribution(): HostWebSocketUpgradeContribution {
  const wss = new WebSocketServer({ noServer: true });
  return {
    path: VOICE_STREAM_WS_PATH,
    handleUpgrade(request, socket, head) {
      const url = new URL(request.url ?? '/', 'http://localhost');
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
      const requestedAgentId = url.searchParams.get('agentId') ?? undefined;
      wss.handleUpgrade(request, socket, head, (client) => {
        void attachVoiceClient(client, neoSessionId, requestedAgentId);
      });
    },
    cleanup() {
      for (const client of wss.clients) client.close(1001, 'voice-live capability unloaded');
      wss.close();
    },
  };
}
