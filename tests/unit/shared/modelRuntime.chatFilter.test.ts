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
  it('自动发现的纯生成模型（无 override capabilities，走推断）也从对话选择器隐藏', () => {
    const s = {
      models: { providers: { 'custom-agnes': {
        displayName: 'Agnes', baseUrl: 'https://apihub.agnes-ai.com/v1',
        apiKeyConfigured: true, enabled: true,
        models: {
          'agnes-image-2.1-flash': { enabled: true },   // 无 capabilities → 走 inferModelCapabilities
          'agnes-2.0-flash': { enabled: true },
        },
      } } },
    } as unknown as AppSettings;
    const ids = buildRuntimeModelOptions(s).map((o) => o.model);
    expect(ids).toContain('agnes-2.0-flash');
    expect(ids).not.toContain('agnes-image-2.1-flash');
  });
});
