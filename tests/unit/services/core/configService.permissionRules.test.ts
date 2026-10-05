import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AppSettings } from '../../../../src/shared/contract';
import { ConfigService } from '../../../../src/host/services/core/configService';
import { resetPolicyEngine } from '../../../../src/host/permissions/policyEngine';

describe('ConfigService permission rule validation', () => {
  afterEach(() => {
    resetPolicyEngine();
    vi.restoreAllMocks();
  });

  function service(): ConfigService {
    const created = new ConfigService();
    vi.spyOn(created as unknown as { save(): Promise<void> }, 'save').mockResolvedValue();
    return created;
  }

  it('rejects a malformed allow rule and leaves config unchanged', async () => {
    const config = service();
    const before = JSON.stringify(config.getSettings());
    await expect(config.updateSettings({
      permissions: { allow: ['Bash('] },
    } as Partial<AppSettings>)).rejects.toThrow(/Invalid permission rule in allow: "Bash\("/);
    expect(JSON.stringify(config.getSettings())).toBe(before);
    expect((config as unknown as { save(): Promise<void> }).save).not.toHaveBeenCalled();
  });

  it('rejects an allow-all Bash rule and still saves the same rule on ask or deny', async () => {
    const rejected = service();
    const before = JSON.stringify(rejected.getSettings());
    await expect(rejected.updateSettings({
      permissions: { allow: ['Bash(*)'] },
    } as Partial<AppSettings>)).rejects.toThrow(/Invalid permission rule in allow: "Bash\(\*\)"/);
    expect(JSON.stringify(rejected.getSettings())).toBe(before);

    const asked = service();
    await asked.updateSettings({
      permissions: { ...asked.getSettings().permissions, ask: ['Bash(*)'] },
    });
    expect(asked.getSettings().permissions.ask).toEqual(['Bash(*)']);

    const denied = service();
    await denied.updateSettings({
      permissions: { ...denied.getSettings().permissions, deny: ['Bash(*)'] },
    });
    expect(denied.getSettings().permissions.deny).toEqual(['Bash(*)']);
  });

  it('lets an update that echoes stored legacy rules through (handleSetDevMode shape)', async () => {
    // 存量非法规则：旧版设置页什么都收，旧占位符还示范过 Network(*)。
    const config = service();
    const stored = config.getSettings();
    (config as unknown as { settings: AppSettings }).settings = {
      ...stored,
      permissions: { ...stored.permissions, deny: ['Network(*)'], allow: ['Bash(*)'] },
    };

    // settings.ipc handleSetDevMode 的形状：整份旧规则原样带上，只改 devModeAutoApprove。
    await expect(config.updateSettings({
      permissions: { ...config.getSettings().permissions, devModeAutoApprove: false },
    } as Partial<AppSettings>)).resolves.toBeUndefined();
    expect(config.getSettings().permissions.devModeAutoApprove).toBe(false);
    expect(config.getSettings().permissions.deny).toEqual(['Network(*)']);
    expect((config as unknown as { save(): Promise<void> }).save).toHaveBeenCalled();
  });

  it('still rejects an invalid rule on a list the update actually changes', async () => {
    const config = service();
    const stored = config.getSettings();
    (config as unknown as { settings: AppSettings }).settings = {
      ...stored,
      permissions: { ...stored.permissions, deny: ['Network(*)'] },
    };
    const before = JSON.stringify(config.getSettings());

    await expect(config.updateSettings({
      permissions: { ...config.getSettings().permissions, allow: ['Bash('] },
    } as Partial<AppSettings>)).rejects.toThrow(/Invalid permission rule in allow: "Bash\("/);
    expect(JSON.stringify(config.getSettings())).toBe(before);
    expect((config as unknown as { save(): Promise<void> }).save).not.toHaveBeenCalled();
  });
});
