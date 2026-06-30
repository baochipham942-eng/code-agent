import { describe, it, expect } from 'vitest';
import { deriveBridgedVisualModels } from '../../../src/shared/visualModelBridge';
import type { AppSettings } from '../../../src/shared/contract';

function settingsWith(models: Record<string, { capabilities?: string[]; enabled?: boolean }>): AppSettings {
  return {
    models: {
      providers: {
        'custom-agnes': {
          displayName: 'Agnes', baseUrl: 'https://apihub.agnes-ai.com/v1',
          apiKeyConfigured: true, enabled: true, models,
        },
      },
    },
  } as unknown as AppSettings;
}

describe('deriveBridgedVisualModels', () => {
  it('带 imageGen/videoGen 的聊天模型 → 派生视觉条目', () => {
    const out = deriveBridgedVisualModels(settingsWith({
      'agnes-image-2.1-flash': { capabilities: ['imageGen'] },
      'agnes-video-v2.0': { capabilities: ['videoGen'] },
      'agnes-2.0-flash': { capabilities: ['general'] },
    }));
    expect(out.map((m) => m.id)).toEqual([
      'custom-agnes:agnes-image-2.1-flash',
      'custom-agnes:agnes-video-v2.0',
    ]);
    expect(out[0]).toMatchObject({ mediaType: 'image', sourceProvider: 'custom-agnes', modelName: 'agnes-image-2.1-flash', sourceLabel: 'Agnes' });
    expect(out[1].mediaType).toBe('video');
  });
  it('未配置 key 的 provider 不派生', () => {
    const s = settingsWith({ 'x-image': { capabilities: ['imageGen'] } });
    (s.models!.providers!['custom-agnes'] as any).apiKeyConfigured = false;
    (s.models!.providers!['custom-agnes'] as any).apiKey = undefined;
    expect(deriveBridgedVisualModels(s)).toEqual([]);
  });
});
