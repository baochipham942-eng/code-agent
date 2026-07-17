import { describe, expect, it } from 'vitest';
import { formatProviderFallbackToast } from '../../../src/renderer/components/ProviderStatusNotice';
import type { ProviderFallbackEvent } from '../../../src/shared/ipc';
import { zh } from '../../../src/renderer/i18n/zh';

describe('ProviderStatusNotice', () => {
  it('formats provider fallback as model strategy recovery when strategy is present', () => {
    const event: ProviderFallbackEvent = {
      from: { provider: 'moonshot', model: 'kimi-k2.5' },
      to: { provider: 'deepseek', model: 'deepseek-v4-flash' },
      reason: 'Moonshot API error: 503 service unavailable',
      category: 'provider_unavailable',
      strategy: 'adaptive-provider-fallback',
    };

    expect(formatProviderFallbackToast(event, zh)).toBe(
      '自动策略恢复：moonshot/kimi-k2.5 服务不可用，已切换到 deepseek/deepseek-v4-flash 继续任务',
    );
  });

  it('keeps legacy fallback wording when no strategy is present', () => {
    const event: ProviderFallbackEvent = {
      from: { provider: 'moonshot', model: 'kimi-k2.5' },
      to: { provider: 'deepseek', model: 'deepseek-v4-flash' },
      reason: 'Moonshot API error: 503 service unavailable',
      category: 'provider_unavailable',
    };

    expect(formatProviderFallbackToast(event, zh)).toBe(
      'moonshot/kimi-k2.5 服务不可用，已自动切换到 deepseek/deepseek-v4-flash 继续任务',
    );
  });

  it('formats adaptive main task recovery without saying it switched away', () => {
    const event: ProviderFallbackEvent = {
      from: { provider: 'zhipu', model: 'glm-4.7-flash' },
      to: { provider: 'moonshot', model: 'kimi-k2.5' },
      reason: 'Zhipu API error: 429 rate limit exceeded',
      category: 'rate_limit',
      strategy: 'adaptive-main-task-recovery',
    };

    expect(formatProviderFallbackToast(event, zh)).toBe(
      '回到主任务模型：zhipu/glm-4.7-flash 触发限流，已回到 moonshot/kimi-k2.5 继续任务',
    );
  });
});
