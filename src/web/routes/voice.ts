// ============================================================================
// 实时语音的控制面只读查询（媒体面仍是 /api/voice/stream 的 WS upgrade）。
//
// Renderer 的 LiveVoiceButton 可见性需要「Provider 是否已配置」的 host 真相：
// key 可能在 secureStorage 也可能在 env（验证场景 ~/.code-agent-dev/.env），
// renderer 读 settings 的 apiKeyConfigured 两种都盖不全，所以由 host 直接回答。
// ============================================================================

import { Router } from 'express';
import type { Request, Response } from 'express';
import type { VoiceStatusResponse } from '../../shared/contract/voice';
import { getDashscopeApiKey } from '../../host/services/media/imageGenerationService';
import { getConfigService } from '../../host/services/core/configService';
import {
  getRealtimeVoiceProviderApiKey,
  resolveConfiguredRealtimeVoiceProfile,
} from '../../host/services/voice/customRealtimeVoiceProviders';
import { getActiveVoiceSessionId } from '../../host/services/voice/voiceSessionService';
import { getVoiceUsageSummary } from '../../host/services/voice/voiceUsageLedger';
import {
  formatVoiceCallTimelineMarkdown,
  getVoiceCallTimeline,
  listVoiceCalls,
} from '../../host/services/voice/voiceCallAudit';

export function createVoiceRouter(): Router {
  const router = Router();

  router.get('/voice/status', (_req: Request, res: Response) => {
    const settings = getConfigService().getSettings();
    const profile = resolveConfiguredRealtimeVoiceProfile(
      settings.voice?.live?.providerId,
      settings.voice?.live,
    );
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

  // 语音审计（N-L7-AUDIT）：通话清单 + 单通时间线（六本账读取聚合，只读）。
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

  return router;
}
