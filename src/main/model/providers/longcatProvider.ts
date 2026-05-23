// ============================================================================
// LongCatProvider - LongCat API 开放平台 Provider 实现
// ============================================================================

import type { ModelConfig } from '../../../shared/contract';
import { BaseOpenAIProvider } from './baseOpenAIProvider';
import { resolveProviderBaseUrl, resolveProviderApiKey } from './providerResolution';

export class LongCatProvider extends BaseOpenAIProvider {
  readonly name = 'LongCat';

  protected getBaseUrl(config: ModelConfig): string {
    return resolveProviderBaseUrl(config);
  }

  protected getApiKey(config: ModelConfig): string {
    return resolveProviderApiKey(config);
  }
}
