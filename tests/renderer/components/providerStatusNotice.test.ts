import { describe, expect, it } from 'vitest';
import { formatProviderFallbackToast, formatVisionUnavailableToast } from '../../../src/renderer/components/ProviderStatusNotice';
import type { ProviderFallbackEvent } from '../../../src/shared/ipc';
import { zh } from '../../../src/renderer/i18n/zh';
import { en } from '../../../src/renderer/i18n/en';

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

  // T7：识图预处理全失败——两个新 category 走独立文案，不套用 from/to 切换模板
  // （没有目标模型可切）。zh/en 都要覆盖，防止只改了一边。
  it('formats the zero-vision-key toast distinctly from a generic fallback in zh and en', () => {
    expect(formatVisionUnavailableToast('vision_no_key', zh)).toBe(
      '这张图片没能被识别：还没有配置支持读图的模型。去设置里加一个识图模型（免费的智谱 GLM-4.6V Flash 也可以）。',
    );
    expect(formatVisionUnavailableToast('vision_no_key', en)).toBe(
      "This image couldn't be read: no image-recognition model is set up yet. Add one in settings (the free Zhipu GLM-4.6V Flash works too).",
    );
  });

  it('formats the vision-attempts-failed toast distinctly from the zero-key case in zh and en', () => {
    expect(formatVisionUnavailableToast('vision_unavailable', zh)).toBe(
      '这张图片没能被识别：已配置的识图模型暂时都调不通，可能是网络或额度问题，稍后再试或去设置检查一下。',
    );
    expect(formatVisionUnavailableToast('vision_unavailable', en)).toBe(
      "This image couldn't be read: the configured image-recognition models are all unreachable right now, likely a network or quota issue. Try again later or check settings.",
    );
  });
});
