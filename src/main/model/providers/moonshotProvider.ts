// ============================================================================
// MoonshotProvider - Kimi K2.5 Provider 实现
// ============================================================================

import https from 'https';
import type { ModelConfig } from '../../../shared/types';
import { BaseOpenAIProvider } from './baseOpenAIProvider';
import { MODEL_API_ENDPOINTS } from '../../../shared/constants';
import { httpsAgent } from './shared';

// 专用 HTTPS Agent: 禁用 keepAlive 避免 SSE 流结束后连接复用导致 "socket hang up"
const moonshotAgent = httpsAgent || new https.Agent({
  keepAlive: false,
  maxSockets: 10,
});

export class MoonshotProvider extends BaseOpenAIProvider {
  readonly name = 'Moonshot';

  protected getBaseUrl(config: ModelConfig): string {
    const isKimiK25 = config.model === 'kimi-k2.5';
    return isKimiK25
      ? (process.env.KIMI_K25_API_URL || MODEL_API_ENDPOINTS.kimiK25)
      : (config.baseUrl || MODEL_API_ENDPOINTS.moonshot);
  }

  protected getApiKey(config: ModelConfig): string {
    const isKimiK25 = config.model === 'kimi-k2.5';
    return isKimiK25
      ? (process.env.KIMI_K25_API_KEY || config.apiKey || '')
      : (config.apiKey || '');
  }

  protected getAgent(): https.Agent {
    return moonshotAgent;
  }
}
