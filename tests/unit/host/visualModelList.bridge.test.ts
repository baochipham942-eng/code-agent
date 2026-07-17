import { describe, it, expect, vi } from 'vitest';

vi.mock('../../../src/host/services/media/imageGenerationService', () => ({
  providerKeyConfigured: () => false,
  getDashscopeApiKey: () => '', getZhipuOfficialApiKey: () => '',
  getGptImageConfig: () => ({}), getMinimaxApiKey: () => '',
  getGeminiApiKey: () => '', getArkApiKey: () => '',
}));

describe('list handler 合并桥接生成模型', () => {
  const settings = { models: { providers: { 'custom-agnes': {
    displayName: 'Agnes', baseUrl: 'https://apihub.agnes-ai.com/v1',
    apiKeyConfigured: true, enabled: true,
    models: {
      'agnes-image-2.1-flash': { capabilities: ['imageGen'], enabled: true },
      'agnes-video-v2.0': { capabilities: ['videoGen'], enabled: true },
    },
  } } } } as any;

  it('桥接图像模型出现在 listVisualImageModels，标 source=bridged + available', async () => {
    const { handleListVisualImageModels } = await import('../../../src/host/ipc/workspace.ipc');
    const res = await handleListVisualImageModels(() => settings, () => true);
    const bridged = res.models.find((m: any) => m.id === 'custom-agnes:agnes-image-2.1-flash');
    expect(bridged).toMatchObject({ source: 'bridged', sourceLabel: 'Agnes', available: true });
    // 安全护栏：桥接条目出参键集恰为安全字段，绝不夹带 apiKey/baseUrl/modelName 等敏感凭据。
    expect(Object.keys(bridged!).sort()).toEqual(
      ['available', 'id', 'label', 'provider', 'source', 'sourceLabel'].sort(),
    );
    expect(JSON.stringify(bridged)).not.toContain('apihub.agnes-ai.com');
  });

  it('桥接视频模型出现在 listVisualVideoModels', async () => {
    const { handleListVisualVideoModels } = await import('../../../src/host/ipc/workspace.ipc');
    const res = await handleListVisualVideoModels(() => settings, () => true);
    expect(res.models.find((m: any) => m.id === 'custom-agnes:agnes-video-v2.0')?.source).toBe('bridged');
  });

  it('listVisualMusicModels 含内置 MiniMax + 桥接（无音乐桥接时仅内置）', async () => {
    const { handleListVisualMusicModels } = await import('../../../src/host/ipc/workspace.ipc');
    const res = await handleListVisualMusicModels(() => settings, () => true);
    expect(res.models.some((m: any) => m.source === 'builtin')).toBe(true);
  });
});
