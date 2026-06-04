// ============================================================================
// 团队共享 provider（中转站）在模型选择器里的展示验证
// 回答「走共享 key 时模型选择器怎么展示」：reconcile 后的 custom-* provider
// 应当被 buildRuntimeModelOptions 枚举出来，模型 = 控制面下发的白名单。
// ============================================================================

import { describe, it, expect } from 'vitest';
import { buildRuntimeModelOptions } from '../../../src/shared/modelRuntime';
import type { AppSettings } from '../../../src/shared/contract';

function settingsWithRelay(): AppSettings {
  return {
    models: {
      default: 'custom-team-relay',
      providers: {
        'custom-team-relay': {
          enabled: true,
          managedByCloud: true,
          apiKeyConfigured: true, // configService.getSettings() 会动态注入；这里直接置真模拟已下发
          baseUrl: 'https://tokenflux.dev/v1',
          displayName: '团队共享',
          protocol: 'openai',
          billingMode: 'unknown',
          models: {
            'gpt-5.3': { enabled: true },
            'gpt-5.4': { enabled: true, label: 'GPT-5.4' },
          },
        },
      },
      routing: {} as AppSettings['models']['routing'],
    },
  } as unknown as AppSettings;
}

describe('团队共享 provider 选择器展示', () => {
  it('reconcile 后的共享 provider 模型出现在选择器选项里', () => {
    const options = buildRuntimeModelOptions(settingsWithRelay());
    const relayModels = options.filter((o) => o.provider === 'custom-team-relay');

    const modelIds = relayModels.map((o) => o.model);
    expect(modelIds).toContain('gpt-5.3');
    expect(modelIds).toContain('gpt-5.4');

    // 打印实际展示分组，确认「怎么展示」
     
    console.log('[display] 团队共享 provider 选项：', relayModels.map((o) => ({
      model: o.model,
      label: o.label,
      providerLabel: o.providerLabel,
      providerGroup: o.providerGroup,
      providerGroupLabel: o.providerGroupLabel,
    })));

    // 至少有一个选项带上了我们设置的 displayName 作为来源标签
    const labels = relayModels.flatMap((o) => [o.providerLabel, o.providerGroupLabel, o.providerSourceLabel].filter(Boolean));
    expect(labels.some((l) => typeof l === 'string' && l.includes('团队共享'))).toBe(true);
  });

  it('未下发（无该 provider）时选择器里不出现这些模型', () => {
    const empty = { models: { providers: {}, routing: {} } } as unknown as AppSettings;
    const options = buildRuntimeModelOptions(empty);
    expect(options.some((o) => o.provider === 'custom-team-relay')).toBe(false);
  });
});
