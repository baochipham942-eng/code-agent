import { afterEach, describe, expect, it, vi } from 'vitest';
import { ConfigService } from '../../../../src/host/services/core/configService';

describe('devModeAutoApprove runtime channel guard', () => {
  const originalNodeEnv = process.env.NODE_ENV;
  const originalDataDir = process.env.CODE_AGENT_DATA_DIR;

  afterEach(() => {
    if (originalNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = originalNodeEnv;
    if (originalDataDir === undefined) delete process.env.CODE_AGENT_DATA_DIR;
    else process.env.CODE_AGENT_DATA_DIR = originalDataDir;
  });

  it('only enables the stored value for strict dev-slot data directories in release NODE_ENV', async () => {
    process.env.NODE_ENV = 'production';
    process.env.CODE_AGENT_DATA_DIR = '/Users/test/.code-agent-dev3';
    const service = new ConfigService();
    vi.spyOn(service as unknown as { save(): Promise<void> }, 'save').mockResolvedValue();

    const settings = service.getSettings();
    await service.updateSettings({
      permissions: { ...settings.permissions, devModeAutoApprove: true },
    });
    expect(service.getSettings().permissions.devModeAutoApprove).toBe(true);

    for (const dataDir of [
      '/Users/test/.code-agent-dev',
      '/Users/test/.code-agent-dev2',
      '/Users/test/.code-agent-dev9',
    ]) {
      process.env.CODE_AGENT_DATA_DIR = dataDir;
      expect(service.isDevModeAutoApproveEnabled()).toBe(true);
    }

    for (const dataDir of [
      '',
      '/Users/test/.code-agent',
      '/Users/test/.code-agent-developer',
      '/Users/test/.code-agent-dev-old',
      '/Users/test/.code-agent-dev02',
      '/Users/test/.code-agent-dev10',
    ]) {
      process.env.CODE_AGENT_DATA_DIR = dataDir;
      expect(service.isDevModeAutoApproveEnabled()).toBe(false);
    }
  });
});
