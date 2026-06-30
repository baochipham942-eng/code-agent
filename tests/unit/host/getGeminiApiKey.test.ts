import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const getApiKey = vi.fn();
vi.mock('../../../src/host/services/core/configService', () => ({
  getConfigService: () => ({ getApiKey }),
}));

import { getGeminiApiKey } from '../../../src/host/services/media/imageGenerationService';

describe('getGeminiApiKey', () => {
  beforeEach(() => { getApiKey.mockReset(); delete process.env.GEMINI_API_KEY; });
  afterEach(() => { delete process.env.GEMINI_API_KEY; });

  it('env GEMINI_API_KEY 优先', () => {
    process.env.GEMINI_API_KEY = 'env-key';
    expect(getGeminiApiKey()).toBe('env-key');
    expect(getApiKey).not.toHaveBeenCalled();
  });
  it('无 env 时回落 gemini 槽位', () => {
    getApiKey.mockReturnValue('cfg-key');
    expect(getGeminiApiKey()).toBe('cfg-key');
    expect(getApiKey).toHaveBeenCalledWith('gemini');
  });
  it('都没有返回 undefined', () => {
    getApiKey.mockReturnValue(undefined);
    expect(getGeminiApiKey()).toBeUndefined();
  });
});
