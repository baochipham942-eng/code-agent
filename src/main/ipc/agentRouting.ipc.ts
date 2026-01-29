// ============================================================================
// Agent Routing IPC Handlers - agent-routing:* 通道
// ============================================================================

import type { IpcMain } from 'electron';
import { IPC_CHANNELS } from '../../shared/ipc';
import type { AgentRoutingConfig } from '../../shared/types/agentRouting';
import { getRoutingService } from '../routing';
import { createLogger } from '../services/infra/logger';

const logger = createLogger('AgentRoutingIPC');

// ----------------------------------------------------------------------------
// Internal Handlers
// ----------------------------------------------------------------------------

interface AgentListResult {
  agents: AgentRoutingConfig[];
  defaultAgentId: string;
}

async function handleList(): Promise<AgentListResult> {
  try {
    const routingService = getRoutingService();
    const agents = routingService.getAllAgents();
    // 默认 agent ID 需要从服务中获取，这里简化处理
    const defaultAgentId = agents.find(a => a.id === 'default')?.id || 'default';
    return { agents, defaultAgentId };
  } catch (error) {
    logger.error('Failed to list agents', error);
    return { agents: [], defaultAgentId: 'default' };
  }
}

async function handleUpsert(agent: AgentRoutingConfig): Promise<boolean> {
  try {
    const routingService = getRoutingService();
    await routingService.upsertAgent(agent);
    return true;
  } catch (error) {
    logger.error('Failed to upsert agent', error);
    return false;
  }
}

async function handleDelete(id: string): Promise<boolean> {
  try {
    const routingService = getRoutingService();
    return await routingService.deleteAgent(id);
  } catch (error) {
    logger.error('Failed to delete agent', error);
    return false;
  }
}

async function handleSetEnabled(id: string, enabled: boolean): Promise<boolean> {
  try {
    const routingService = getRoutingService();
    await routingService.setAgentEnabled(id, enabled);
    return true;
  } catch (error) {
    logger.error('Failed to set agent enabled state', error);
    return false;
  }
}

async function handleSetDefault(id: string): Promise<boolean> {
  try {
    const routingService = getRoutingService();
    await routingService.setDefaultAgent(id);
    return true;
  } catch (error) {
    logger.error('Failed to set default agent', error);
    return false;
  }
}

// ----------------------------------------------------------------------------
// Public Registration
// ----------------------------------------------------------------------------

/**
 * 注册 Agent Routing 相关 IPC handlers
 */
export function registerAgentRoutingHandlers(ipcMain: IpcMain): void {
  // List all agents
  ipcMain.handle(IPC_CHANNELS.AGENT_ROUTING_LIST, async () => {
    return handleList();
  });

  // Create or update agent
  ipcMain.handle(IPC_CHANNELS.AGENT_ROUTING_UPSERT, async (_, agent: AgentRoutingConfig) => {
    return handleUpsert(agent);
  });

  // Delete agent
  ipcMain.handle(IPC_CHANNELS.AGENT_ROUTING_DELETE, async (_, id: string) => {
    return handleDelete(id);
  });

  // Set agent enabled state
  ipcMain.handle(IPC_CHANNELS.AGENT_ROUTING_SET_ENABLED, async (_, id: string, enabled: boolean) => {
    return handleSetEnabled(id, enabled);
  });

  // Set default agent
  ipcMain.handle(IPC_CHANNELS.AGENT_ROUTING_SET_DEFAULT, async (_, id: string) => {
    return handleSetDefault(id);
  });

  logger.info('Agent routing IPC handlers registered');
}
