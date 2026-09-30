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
});
