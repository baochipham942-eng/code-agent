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
import { getActiveVoiceSessionId } from '../../host/services/voice/voiceSessionService';
import { getVoiceUsageSummary } from '../../host/services/voice/voiceUsageLedger';

export function createVoiceRouter(): Router {
  const router = Router();

  router.get('/voice/status', (_req: Request, res: Response) => {
    const payload: VoiceStatusResponse = {
      provider: 'qwen-omni',
      configured: Boolean(getDashscopeApiKey()),
      active: getActiveVoiceSessionId() !== null,
      usage: getVoiceUsageSummary(Date.now()),
    };
    res.json(payload);
  });

  return router;
}
