import { describe, expect, it } from 'vitest';
import { buildSharedCommandHostPorts } from '../../../src/cli/commands/sharedCommandHostPorts';

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
});
