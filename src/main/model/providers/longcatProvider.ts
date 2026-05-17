// ============================================================================
// LongCatProvider - LongCat API 开放平台 Provider 实现
// ============================================================================

import type { ModelConfig } from '../../../shared/contract';
import { MODEL_API_ENDPOINTS } from '../../../shared/constants';
import { BaseOpenAIProvider } from './baseOpenAIProvider';

export class LongCatProvider extends BaseOpenAIProvider {
  readonly name = 'LongCat';

  protected getBaseUrl(config: ModelConfig): string {
    return config.baseUrl || MODEL_API_ENDPOINTS.longcat;
  }

  protected getApiKey(config: ModelConfig): string {
    return config.apiKey || process.env.LONGCAT_API_KEY || '';
  }
}
