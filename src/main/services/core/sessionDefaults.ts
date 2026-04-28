// ============================================================================
// Session Default ModelConfig - 新建 session 的默认 modelConfig 解析
// ============================================================================
//
// 复用 src/cli/bootstrap.ts:212 buildCLIConfig 的优先级：
//   args > settings.models.providers[p] > settings.models.defaultProvider > constants
//
// audit B5 follow-up（艾克斯 review MED1）：webServer.ts 和 routes/sessions.ts
// 之前直写 DEFAULT_PROVIDER + DEFAULT_MODELS.chat 绕过了 user settings，
// 这个 helper 解决两处共同根因。
// ============================================================================

import {
  DEFAULT_PROVIDER,
  DEFAULT_MODELS,
  getModelMaxOutputTokens,
} from '../../../shared/constants';
import type { ModelConfig, ModelProvider } from '../../../shared/contract';
import { getConfigService } from './configService';

export interface SessionDefaultArgs {
  provider?: string;
  model?: string;
  temperature?: number;
  maxTokens?: number;
}

export function resolveSessionDefaultModelConfig(args: SessionDefaultArgs = {}): ModelConfig {
  let config: ReturnType<typeof getConfigService> | null = null;
  try {
    config = getConfigService();
  } catch {
    // ConfigService 未初始化（如某些测试场景）—— 用纯常量 fallback
  }
  const settings = (config?.getSettings() ?? {}) as Record<string, unknown> & {
    models?: {
      defaultProvider?: string;
      providers?: Record<string, { model?: string; temperature?: number; maxTokens?: number }>;
    };
  };

  const provider = (args.provider || settings.models?.defaultProvider || DEFAULT_PROVIDER) as ModelProvider;
  const providerCfg = settings.models?.providers?.[provider];
  const model = args.model || providerCfg?.model || DEFAULT_MODELS.chat;

  return {
    provider,
    model,
    apiKey: config?.getApiKey?.(provider) ?? '',
    temperature: args.temperature ?? providerCfg?.temperature ?? 0.7,
    maxTokens: args.maxTokens ?? providerCfg?.maxTokens ?? getModelMaxOutputTokens(model),
  };
}
