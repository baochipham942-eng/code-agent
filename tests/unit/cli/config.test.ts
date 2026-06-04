import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

describe('CLIConfigService env api key mapping', () => {
  const savedEnv = { ...process.env };

  beforeEach(() => {
    vi.resetModules();
    process.env = { ...savedEnv };
  });

  afterEach(() => {
    process.env = { ...savedEnv };
  });

  it('reads xiaomi api key from XIAOMI_API_KEY', async () => {
    process.env.XIAOMI_API_KEY = 'xiaomi-test-key';

    const { getCLIConfigService } = await import('../../../src/cli/config');
    const service = getCLIConfigService();

    expect(service.getApiKey('xiaomi')).toBe('xiaomi-test-key');
  });

  it('strips surrounding quotes from env api keys copied from .env backups', async () => {
    process.env.XIAOMI_API_KEY = '"xiaomi-test-key"';

    const { getCLIConfigService } = await import('../../../src/cli/config');
    const service = getCLIConfigService();

    expect(service.getApiKey('xiaomi')).toBe('xiaomi-test-key');
  });

  it('prefers MOONSHOT_API_KEY and falls back to KIMI_K25_API_KEY', async () => {
    process.env.MOONSHOT_API_KEY = '';
    process.env.KIMI_K25_API_KEY = 'kimi-fallback-key';

    {
      const { getCLIConfigService } = await import('../../../src/cli/config');
      const service = getCLIConfigService();
      expect(service.getApiKey('moonshot')).toBe('kimi-fallback-key');
    }

    vi.resetModules();
    process.env = { ...savedEnv, KIMI_K25_API_KEY: 'kimi-fallback-key', MOONSHOT_API_KEY: 'moonshot-primary-key' };

    const { getCLIConfigService } = await import('../../../src/cli/config');
    const service = getCLIConfigService();

    expect(service.getApiKey('moonshot')).toBe('moonshot-primary-key');
  });
});
