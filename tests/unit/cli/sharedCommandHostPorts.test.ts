import { describe, expect, it, vi } from 'vitest';
import { buildSharedCommandHostPorts } from '../../../src/cli/commands/sharedCommandHostPorts';

const extensionOpsHost = vi.hoisted(() => ({
  install: vi.fn(),
}));

vi.mock('../../../src/host/services/plugins/extensionOpsService', () => ({
  getExtensionOpsService: () => ({
    list: async () => [],
    install: (...args: unknown[]) => extensionOpsHost.install(...args),
    uninstall: async () => {},
    enable: async () => {},
    disable: async () => {},
    reload: async () => {},
    validate: async () => ({ valid: true, errors: [], warnings: [] }),
  }),
}));

const LOADER_KEYS = [
  'loadDoctorRunner',
  'loadReadOnlySideChat',
  'loadToolResolver',
  'loadSubagentExecutor',
  'loadSessionRecovery',
  'loadSessionStateManager',
  'loadAgentHistory',
  'loadContextHealth',
  'loadBudgetService',
  'loadAutoCompressor',
  'loadPermissionModes',
  'loadExecPolicy',
  'loadDecisionHistory',
  'loadBackgroundTasks',
];

describe('CLI shared command host ports', () => {
  it('exposes the injected port map without loading host modules', async () => {
    const ports = buildSharedCommandHostPorts({
      agent: { getSessionId: () => null },
      getSessionSkillService: () => ({ getMountedSkills: () => [] }),
    });

    for (const key of LOADER_KEYS) {
      expect(typeof ports[key]).toBe('function');
    }

    const skillOps = ports.skillOps as {
      listAvailable: unknown;
      listMounted: () => Promise<unknown[]>;
      listSelected: () => string[];
    };
    expect(typeof skillOps.listAvailable).toBe('function');
    await expect(skillOps.listMounted()).resolves.toEqual([]);
    expect(skillOps.listSelected()).toEqual([]);

    const mcpOps = ports.mcpOps as Record<string, unknown>;
    expect(typeof mcpOps.getStatus).toBe('function');
    expect(typeof mcpOps.listServerStates).toBe('function');
    expect(typeof mcpOps.listTools).toBe('function');

    const connectorOps = ports.connectorOps as { listStatuses: unknown; listSelected: () => string[] };
    expect(typeof connectorOps.listStatuses).toBe('function');
    expect(connectorOps.listSelected()).toEqual([]);

    const extensionOps = ports.extensionOps as Record<string, unknown>;
    for (const method of ['list', 'install', 'uninstall', 'enable', 'disable', 'reload', 'validate']) {
      expect(typeof extensionOps[method]).toBe('function');
    }
  });

  it('extensionOps.install forwards the caution token to the host service', async () => {
    extensionOpsHost.install.mockResolvedValueOnce(undefined);
    const ports = buildSharedCommandHostPorts({
      agent: { getSessionId: () => null },
      getSessionSkillService: () => ({ getMountedSkills: () => [] }),
    });
    const extensionOps = ports.extensionOps as {
      install: (spec: string, options?: { cautionConfirmationToken?: string }) => Promise<unknown>;
    };

    await expect(extensionOps.install('demo@local', { cautionConfirmationToken: 'f'.repeat(64) })).resolves.toBeUndefined();

    expect(extensionOpsHost.install).toHaveBeenCalledWith('demo@local', { cautionConfirmationToken: 'f'.repeat(64) });
  });

  it('extensionOps.install converts a caution confirmation error into its result', async () => {
    const { SkillCautionConfirmationRequiredError } = await import(
      '../../../src/host/skills/marketplace/skillInstallCautionGate'
    );
    const required = {
      success: false as const,
      code: 'SKILL_CAUTION_CONFIRMATION_REQUIRED' as const,
      pluginSpec: 'demo@local',
      sourceTrust: 'local-marketplace' as const,
      cautionHits: [{ file: 'skills/demo/SKILL.md', ruleId: 'recursive_delete_targeted', snippet: 'rm -rf ./build' }],
      confirmationToken: 'a'.repeat(64),
    };
    extensionOpsHost.install.mockRejectedValueOnce(new SkillCautionConfirmationRequiredError(required));
    const ports = buildSharedCommandHostPorts({
      agent: { getSessionId: () => null },
      getSessionSkillService: () => ({ getMountedSkills: () => [] }),
    });
    const extensionOps = ports.extensionOps as {
      install: (spec: string, options?: { cautionConfirmationToken?: string }) => Promise<unknown>;
    };

    await expect(extensionOps.install('demo@local')).resolves.toEqual(required);
    expect(extensionOpsHost.install).toHaveBeenCalledWith('demo@local', undefined);
  });

  it('extensionOps.install keeps rethrowing non-caution errors untouched', async () => {
    extensionOpsHost.install.mockRejectedValueOnce(new Error('marketplace unreachable'));
    const ports = buildSharedCommandHostPorts({
      agent: { getSessionId: () => null },
      getSessionSkillService: () => ({ getMountedSkills: () => [] }),
    });
    const extensionOps = ports.extensionOps as {
      install: (spec: string, options?: { cautionConfirmationToken?: string }) => Promise<unknown>;
    };

    await expect(extensionOps.install('demo@local')).rejects.toThrow('marketplace unreachable');
  });
});
