// ============================================================================
// Tools Commands - /tools, /skills
// ============================================================================

import type { CommandDefinition } from '../types';
import type { ParsedSkill } from '../../contract/agentSkill';
import type { SessionSkillMount } from '../../contract/skillRepository';
import type { ConnectorStatusSummary, MCPStatus, MCPTool } from '../../ipc/types';

interface SkillOpsCommandService {
  listAvailable(): Promise<ParsedSkill[]>;
  listMounted(): Promise<SessionSkillMount[]>;
  listSelected(): string[];
}

interface McpServerCommandState {
  config: {
    name: string;
    enabled: boolean;
    type: string;
  };
  status: string;
  toolCount: number;
  resourceCount: number;
  error?: string;
}

interface McpOpsCommandService {
  getStatus(): Promise<MCPStatus>;
  listServerStates(): Promise<McpServerCommandState[]>;
  listTools(): Promise<MCPTool[]>;
}

interface ConnectorOpsCommandService {
  listStatuses(): Promise<ConnectorStatusSummary[]>;
  listSelected(): string[];
}

function isSkillOpsCommandService(value: unknown): value is SkillOpsCommandService {
  if (!value || typeof value !== 'object') return false;
  const maybe = value as Partial<Record<keyof SkillOpsCommandService, unknown>>;
  return (
    typeof maybe.listAvailable === 'function' &&
    typeof maybe.listMounted === 'function' &&
    typeof maybe.listSelected === 'function'
  );
}

function isMcpOpsCommandService(value: unknown): value is McpOpsCommandService {
  if (!value || typeof value !== 'object') return false;
  const maybe = value as Partial<Record<keyof McpOpsCommandService, unknown>>;
  return (
    typeof maybe.getStatus === 'function' &&
    typeof maybe.listServerStates === 'function' &&
    typeof maybe.listTools === 'function'
  );
}

function isConnectorOpsCommandService(value: unknown): value is ConnectorOpsCommandService {
  if (!value || typeof value !== 'object') return false;
  const maybe = value as Partial<Record<keyof ConnectorOpsCommandService, unknown>>;
  return (
    typeof maybe.listStatuses === 'function' &&
    typeof maybe.listSelected === 'function'
  );
}

async function resolveSkillOps(ctx: Record<string, unknown>): Promise<SkillOpsCommandService | null> {
  if (isSkillOpsCommandService(ctx.skillOps)) {
    return ctx.skillOps;
  }

  if (ctx.surface === 'gui') {
    return null;
  }

  const getSessionSkillService = ctx.getSessionSkillService as (() => {
    getMountedSkills(sessionId: string): SessionSkillMount[];
  }) | undefined;
  const agent = ctx.agent as { getSessionId?: () => string | null } | undefined;
  if (!getSessionSkillService || !agent?.getSessionId) {
    return null;
  }

  return {
    listAvailable: async () => {
      const { getSkillDiscoveryService } = await import('../../../main/services/skills/skillDiscoveryService');
      return getSkillDiscoveryService().getAllSkills();
    },
    listMounted: async () => {
      const sessionId = agent.getSessionId?.();
      return sessionId ? getSessionSkillService().getMountedSkills(sessionId) : [];
    },
    listSelected: () => [],
  };
}

async function resolveMcpOps(ctx: Record<string, unknown>): Promise<McpOpsCommandService | null> {
  if (isMcpOpsCommandService(ctx.mcpOps)) {
    return ctx.mcpOps;
  }

  if (ctx.surface === 'gui') {
    return null;
  }

  return {
    getStatus: async () => {
      const { getMCPClient } = await import('../../../main/mcp/mcpClient');
      return getMCPClient().getStatus();
    },
    listServerStates: async () => {
      const { getMCPClient } = await import('../../../main/mcp/mcpClient');
      return getMCPClient().getServerStates() as McpServerCommandState[];
    },
    listTools: async () => {
      const { getMCPClient } = await import('../../../main/mcp/mcpClient');
      return getMCPClient().getTools();
    },
  };
}

async function resolveConnectorOps(ctx: Record<string, unknown>): Promise<ConnectorOpsCommandService | null> {
  if (isConnectorOpsCommandService(ctx.connectorOps)) {
    return ctx.connectorOps;
  }

  if (ctx.surface === 'gui') {
    return null;
  }

  return {
    listStatuses: async () => {
      const { getConnectorRegistry } = await import('../../../main/connectors');
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
    listSelected: () => [],
  };
}

export const toolsCommand: CommandDefinition = {
  id: 'tools',
  name: '工具列表',
  description: '列出已加载工具',
  category: 'tools',
  surfaces: ['cli'],
  handler: async (ctx) => {
    // 工具列表依赖 CLI bootstrap 的 toolExecutor，保留在 CLI fallback
    // 这里提供一个基础实现
    const getToolExecutor = ctx.getToolExecutor as (() => {
      toolRegistry: {
        getAllTools(): Array<{ name: string; description: string }>;
      };
    } | null) | undefined;

    if (!getToolExecutor) {
      ctx.output.info('Tool executor not available');
      return { success: false, message: 'Tool executor not available' };
    }

    try {
      const executor = getToolExecutor();
      if (!executor) {
        ctx.output.info('Tool executor not available');
        return { success: false };
      }

      const allTools = executor.toolRegistry.getAllTools();
      const mcpTools = allTools.filter(t => t.name.startsWith('mcp_') || t.name.startsWith('mcp__'));
      const builtinTools = allTools.filter(t => !t.name.startsWith('mcp_') && !t.name.startsWith('mcp__'));

      const lines: string[] = [];
      lines.push(`Tools (${allTools.length} total)`);

      if (builtinTools.length > 0) {
        lines.push(`  Built-in (${builtinTools.length}):`);
        const names = builtinTools.map(t => t.name).sort();
        for (let i = 0; i < names.length; i += 4) {
          const row = names.slice(i, i + 4).map(n => n.padEnd(22)).join('');
          lines.push(`    ${row}`);
        }
      }

      if (mcpTools.length > 0) {
        lines.push(`  MCP (${mcpTools.length}):`);
        for (const t of mcpTools.sort((a, b) => a.name.localeCompare(b.name))) {
          const desc = t.description ? t.description.substring(0, 50) : '';
          lines.push(`    🔌 ${t.name}${desc ? `  ${desc}` : ''}`);
        }
      }

      ctx.output.info(lines.join('\n'));
      return { success: true, data: { total: allTools.length } };
    } catch {
      ctx.output.error('Failed to list tools');
      return { success: false, message: 'Failed to list tools' };
    }
  },
};

export const skillsCommand: CommandDefinition = {
  id: 'skills',
  name: '技能列表',
  description: '列出可用和已挂载 Skills',
  category: 'tools',
  surfaces: ['cli', 'gui'],
  aliases: ['skill'],
  handler: async (ctx) => {
    const svc = await resolveSkillOps(ctx);
    if (!svc) {
      ctx.output.info('Skill service not available');
      return { success: false };
    }

    try {
      const [available, mounted] = await Promise.all([
        svc.listAvailable(),
        svc.listMounted(),
      ]);
      const selected = svc.listSelected();
      const mountedNames = new Set(mounted.map((skill) => skill.skillName));
      const selectedNames = new Set(selected);
      const availableUnselected = available
        .filter((skill) => !mountedNames.has(skill.name) && !selectedNames.has(skill.name))
        .slice(0, 12);

      const lines = [
        `Skills (${available.length} available, ${mounted.length} mounted, ${selected.length} selected)`,
      ];

      if (selected.length > 0) {
        lines.push(`  Selected: ${selected.join(', ')}`);
      }
      if (mounted.length > 0) {
        lines.push(`  Mounted: ${mounted.map((skill) => `${skill.skillName}${skill.source === 'auto' ? ' [auto]' : ''}`).join(', ')}`);
      }
      if (availableUnselected.length > 0) {
        const suffix = available.length > availableUnselected.length ? ` +${available.length - availableUnselected.length} more` : '';
        lines.push(`  Available: ${availableUnselected.map((skill) => skill.name).join(', ')}${suffix}`);
      }

      ctx.output.info(lines.join('\n'));
      return { success: true, data: { available: available.length, mounted: mounted.length, selected: selected.length } };
    } catch {
      ctx.output.error('Failed to list skills');
      return { success: false, message: 'Failed to list skills' };
    }
  },
};

export const mcpCommand: CommandDefinition = {
  id: 'mcp',
  name: 'MCP',
  description: '列出 MCP server 和工具状态',
  category: 'tools',
  surfaces: ['cli', 'gui'],
  handler: async (ctx) => {
    const svc = await resolveMcpOps(ctx);
    if (!svc) {
      ctx.output.info('MCP service not available');
      return { success: false };
    }

    try {
      const [status, serverStates, tools] = await Promise.all([
        svc.getStatus(),
        svc.listServerStates(),
        svc.listTools(),
      ]);
      const lines = [
        `MCP (${serverStates.length} servers, ${tools.length} tools)`,
        `  Connected: ${(status.connectedServers || []).join(', ') || '(none)'}`,
      ];
      for (const server of serverStates.slice(0, 12)) {
        const marker = server.status === 'connected' ? '+' : server.status === 'error' ? '!' : '-';
        const enabled = server.config.enabled ? 'enabled' : 'disabled';
        const err = server.error ? ` (${server.error})` : '';
        lines.push(`  ${marker} ${server.config.name}  ${server.status}/${enabled}  tools:${server.toolCount} resources:${server.resourceCount}${err}`);
      }
      if (serverStates.length > 12) {
        lines.push(`  ... and ${serverStates.length - 12} more`);
      }
      ctx.output.info(lines.join('\n'));
      return { success: true, data: { servers: serverStates.length, tools: tools.length } };
    } catch {
      ctx.output.error('Failed to list MCP servers');
      return { success: false, message: 'Failed to list MCP servers' };
    }
  },
};

export const connectorsCommand: CommandDefinition = {
  id: 'connectors',
  name: '连接器',
  description: '列出本地 connectors 状态',
  category: 'tools',
  surfaces: ['cli', 'gui'],
  aliases: ['connector'],
  handler: async (ctx) => {
    const svc = await resolveConnectorOps(ctx);
    if (!svc) {
      ctx.output.info('Connector service not available');
      return { success: false };
    }

    try {
      const statuses = await svc.listStatuses();
      const selected = new Set(svc.listSelected());
      const lines = [`Connectors (${statuses.length} total, ${selected.size} selected)`];
      for (const connector of statuses.slice(0, 12)) {
        const marker = connector.connected ? '+' : connector.readiness === 'failed' ? '!' : '-';
        const selectedMarker = selected.has(connector.id) ? ' selected' : '';
        const readiness = connector.readiness ? ` ${connector.readiness}` : '';
        const err = connector.error ? ` (${connector.error})` : '';
        lines.push(`  ${marker} ${connector.id}  ${connector.label}${selectedMarker}${readiness}${err}`);
      }
      if (statuses.length > 12) {
        lines.push(`  ... and ${statuses.length - 12} more`);
      }
      ctx.output.info(lines.join('\n'));
      return { success: true, data: { count: statuses.length, selected: selected.size } };
    } catch {
      ctx.output.error('Failed to list connectors');
      return { success: false, message: 'Failed to list connectors' };
    }
  },
};

export const toolsCommands: CommandDefinition[] = [
  toolsCommand,
  skillsCommand,
  mcpCommand,
  connectorsCommand,
];
