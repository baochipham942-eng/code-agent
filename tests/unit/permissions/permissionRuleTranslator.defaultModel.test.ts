import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_MODEL, DEFAULT_PROVIDER, MODEL_MAX_TOKENS } from '../../../src/shared/constants';

const h = vi.hoisted(() => ({
  chat: vi.fn(async (_request: unknown) => ({ content: '{"status":"unrecognized","reason":"test"}' })),
  settings: {
    models: {
      default: '' as string,
      providers: {} as Record<string, { model?: string }>,
    },
  },
}));

vi.mock('../../../src/host/model/modelRouter', () => ({
  ModelRouter: class {
    chat(request: unknown) {
      return h.chat(request);
    }
  },
}));

vi.mock('../../../src/host/services/core/configService', () => ({
  getConfigService: () => ({
    getSettings: () => h.settings,
    getApiKey: () => '',
  }),
}));

import { translatePermissionSentence } from '../../../src/host/permissions/permissionRuleTranslator';

function chatRequest(): { provider: string; model: string; maxTokens: number } {
  const request = h.chat.mock.calls[0]?.[0];
  if (!request || typeof request !== 'object') throw new Error('missing chat request');
  return request as { provider: string; model: string; maxTokens: number };
}

describe('permissionRuleTranslator default model', () => {
  beforeEach(() => {
    h.chat.mockClear();
    h.chat.mockResolvedValue({ content: '{"status":"unrecognized","reason":"test"}' });
    h.settings.models.default = '';
    h.settings.models.providers = {};
  });

  it('uses the configured user provider and model', async () => {
    h.settings.models.default = 'deepseek';
    h.settings.models.providers = { deepseek: { model: 'deepseek-chat' } };

    await translatePermissionSentence('forbid running rm -rf');

    expect(chatRequest()).toMatchObject({
      provider: 'deepseek',
      model: 'deepseek-chat',
      maxTokens: MODEL_MAX_TOKENS.COMPACT,
    });
  });

  it('falls back to the factory default when nothing is configured', async () => {
    await translatePermissionSentence('forbid running rm -rf');

    expect(chatRequest()).toMatchObject({
      provider: DEFAULT_PROVIDER,
      model: DEFAULT_MODEL,
      maxTokens: MODEL_MAX_TOKENS.COMPACT,
    });
  });
});
