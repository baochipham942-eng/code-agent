import { afterEach, describe, expect, it, vi } from 'vitest';
import { ConfigService, isDevSlotRuntime } from '../../../../src/host/services/core/configService';

describe('devModeAutoApprove runtime channel guard', () => {
  const originalNodeEnv = process.env.NODE_ENV;
  const originalDataDir = process.env.CODE_AGENT_DATA_DIR;

  afterEach(() => {
    if (originalNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = originalNodeEnv;
    if (originalDataDir === undefined) delete process.env.CODE_AGENT_DATA_DIR;
    else process.env.CODE_AGENT_DATA_DIR = originalDataDir;
  });

  it('allows strict dev-slot data directories even in release NODE_ENV', () => {
    process.env.NODE_ENV = 'production';
    expect(isDevSlotRuntime('/Users/test/.code-agent-dev')).toBe(true);
    expect(isDevSlotRuntime('/Users/test/.code-agent-dev2')).toBe(true);
  });

  it('rejects production and near-miss data directories', () => {
    for (const dataDir of [
      undefined,
      '',
      '/Users/test/.code-agent',
      '/Users/test/.code-agent-developer',
      '/Users/test/.code-agent-dev-old',
      '/Users/test/.code-agent-dev02',
      '/Users/test/.code-agent-dev10',
    ]) {
      expect(isDevSlotRuntime(dataDir)).toBe(false);
    }
  });

  it('enables in a release dev slot but the same stored value is ineffective outside it', async () => {
    process.env.NODE_ENV = 'production';
    process.env.CODE_AGENT_DATA_DIR = '/Users/test/.code-agent-dev3';
    const service = new ConfigService();
    vi.spyOn(service as unknown as { save(): Promise<void> }, 'save').mockResolvedValue();

    const settings = service.getSettings();
    await service.updateSettings({
      permissions: { ...settings.permissions, devModeAutoApprove: true },
    });
    expect(service.isDevModeAutoApproveEnabled()).toBe(true);

    process.env.CODE_AGENT_DATA_DIR = '/Users/test/.code-agent';
    expect(service.getSettings().permissions.devModeAutoApprove).toBe(true);
    expect(service.isDevModeAutoApproveEnabled()).toBe(false);
  });
});
