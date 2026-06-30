import { describe, it, expect } from 'vitest';
import { buildRuntimeModelOptions } from '../../../src/shared/modelRuntime';
import type { AppSettings } from '../../../src/shared/contract';

const settings = {
  models: { providers: { 'custom-agnes': {
    displayName: 'Agnes', baseUrl: 'https://apihub.agnes-ai.com/v1',
    apiKeyConfigured: true, enabled: true,
    models: {
      'agnes-image-2.1-flash': { capabilities: ['imageGen'], enabled: true },
      'agnes-2.0-flash': { capabilities: ['general'], enabled: true },
    },
  } } },
} as unknown as AppSettings;

describe('聊天选择器过滤纯生成模型', () => {
  it('纯生成模型不进对话选择器，聊天模型保留', () => {
    const ids = buildRuntimeModelOptions(settings).map((o) => o.model);
    expect(ids).toContain('agnes-2.0-flash');
    expect(ids).not.toContain('agnes-image-2.1-flash');
  });
});
