// ============================================================================
// CLI 注入给 shared slash command 的 host 端口。
// shared / renderer 不能 import src/host；真实实现只在 CLI 这一侧加载。
// ============================================================================

import type { ConnectorStatusSummary } from '../../shared/ipc/types';

interface SkillMountReader {
  getMountedSkills(sessionId: string): Array<{ skillName: string; source?: string }>;
}

export function buildSharedCommandHostPorts(deps: {
  agent: { getSessionId?: () => string | null };
  getSessionSkillService: () => unknown;
}): Record<string, unknown> {
  return {
    skillOps: {
      listAvailable: async () => {
        const { getSkillDiscoveryService } = await import('../../host/services/skills/skillDiscoveryService');
        return getSkillDiscoveryService().getAllSkills();
      },
      listMounted: async () => {
        const sessionId = deps.agent.getSessionId?.();
        const getSessionSkillService = deps.getSessionSkillService as () => SkillMountReader;
        return sessionId ? getSessionSkillService().getMountedSkills(sessionId) : [];
      },
      listSelected: () => [] as string[],
    },
    mcpOps: {
      getStatus: async () => {
        const { getMCPClient } = await import('../../host/mcp/mcpClient');
        return getMCPClient().getStatus();
      },
      listServerStates: async () => {
        const { getMCPClient } = await import('../../host/mcp/mcpClient');
        return getMCPClient().getServerStates();
      },
      listTools: async () => {
        const { getMCPClient } = await import('../../host/mcp/mcpClient');
        return getMCPClient().getTools();
      },
    },
    connectorOps: {
      listStatuses: async () => {
        const { getConnectorRegistry } = await import('../../host/connectors');
        const connectors = getConnectorRegistry().list();
        return Promise.all(connectors.map(async (connector) => {
          const status = await connector.getStatus();
          return {
            id: connector.id,
            label: connector.label,
            connected: status.connected,
            readiness: status.readiness,
            detail: status.detail,
            error: status.error,
            checkedAt: status.checkedAt,
            actions: status.actions,
            capabilities: connector.capabilities,
          } satisfies ConnectorStatusSummary;
        }));
      },
      listSelected: () => [] as string[],
    },
    extensionOps: {
      list: async () => (await extensionOpsService()).list(),
      install: async (spec: string) => (await extensionOpsService()).install(spec),
      uninstall: async (id: string) => (await extensionOpsService()).uninstall(id),
      enable: async (id: string) => (await extensionOpsService()).enable(id),
      disable: async (id: string) => (await extensionOpsService()).disable(id),
      reload: async (id?: string) => (await extensionOpsService()).reload(id),
      validate: async (id: string) => (await extensionOpsService()).validate(id),
    },
    loadDoctorRunner: () => import('../../host/diagnostics/doctorRunner'),
    loadProjectMemoryDrafter: async () => {
      const mod = await import('../../host/memory/projectMemoryDraft');
      return { runProjectMemoryDraft: mod.runProjectMemoryDraft };
    },
    loadReadOnlySideChat: () => import('../../host/agent/readOnlySideChat'),
    loadToolResolver: () => import('../../host/tools/dispatch/toolResolver'),
    loadSubagentExecutor: () => import('../../host/agent/subagentExecutor'),
    loadSessionRecovery: () => import('../../host/agent/sessionRecovery'),
    loadSessionStateManager: () => import('../../host/session/sessionStateManager'),
    loadAgentHistory: () => import('../../host/session/agentHistoryPersistence'),
    loadContextHealth: () => import('../../host/context/contextHealthService'),
    loadBudgetService: () => import('../../host/services/core/budgetService'),
    loadAutoCompressor: () => import('../../host/context/autoCompressor'),
    loadPermissionModes: () => import('../../host/permissions/modes'),
    loadExecPolicy: () => import('../../host/security/execPolicy'),
    loadDecisionHistory: () => import('../../host/security/decisionHistory'),
    loadBackgroundTasks: () => import('../../host/tools/shell/backgroundTasks'),
  };
}

async function extensionOpsService() {
  const mod = await import('../../host/services/plugins/extensionOpsService');
  const svc = mod.getExtensionOpsService?.();
  if (!svc) {
    throw new Error('getExtensionOpsService is not available');
  }
  return svc;
}
