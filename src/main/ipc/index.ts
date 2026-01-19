// ============================================================================
// IPC Module - 统一注册所有 IPC handlers
// ============================================================================

import type { IpcMain, BrowserWindow } from 'electron';
import type { AgentOrchestrator } from '../agent/agentOrchestrator';
import type { GenerationManager } from '../generation/generationManager';
import type { ConfigService } from '../services';
import type { PlanningService } from '../planning';
import { createLogger } from '../services/infra/logger';

const logger = createLogger('IPC');

import { registerAgentHandlers } from './agent.ipc';
import { registerGenerationHandlers } from './generation.ipc';
import { registerSessionHandlers } from './session.ipc';
import { registerAuthHandlers } from './auth.ipc';
import { registerSyncHandlers } from './sync.ipc';
import { registerCloudHandlers } from './cloud.ipc';
import { registerWorkspaceHandlers } from './workspace.ipc';
import { registerSettingsHandlers } from './settings.ipc';
import { registerUpdateHandlers } from './update.ipc';
import { registerMcpHandlers } from './mcp.ipc';
import { registerMemoryHandlers } from './memory.ipc';
import { registerPlanningHandlers } from './planning.ipc';
import { registerDataHandlers } from './data.ipc';

export * from './types';

/**
 * IPC handler 注册所需的依赖
 */
export interface IpcDependencies {
  getMainWindow: () => BrowserWindow | null;
  getOrchestrator: () => AgentOrchestrator | null;
  getGenerationManager: () => GenerationManager | null;
  getConfigService: () => ConfigService | null;
  getPlanningService: () => PlanningService | null;
  getCurrentSessionId: () => string | null;
  setCurrentSessionId: (id: string) => void;
}

/**
 * 注册所有 IPC handlers
 */
export function setupAllIpcHandlers(ipcMain: IpcMain, deps: IpcDependencies): void {
  const {
    getMainWindow,
    getOrchestrator,
    getGenerationManager,
    getConfigService,
    getPlanningService,
    getCurrentSessionId,
    setCurrentSessionId,
  } = deps;

  // Agent handlers
  registerAgentHandlers(ipcMain, getOrchestrator);

  // Generation handlers
  registerGenerationHandlers(ipcMain, getGenerationManager);

  // Session handlers
  registerSessionHandlers(ipcMain, {
    getConfigService,
    getGenerationManager,
    getOrchestrator,
    getCurrentSessionId,
    setCurrentSessionId,
  });

  // Auth handlers
  registerAuthHandlers(ipcMain);

  // Sync handlers
  registerSyncHandlers(ipcMain);

  // Cloud handlers
  registerCloudHandlers(ipcMain);

  // Workspace handlers
  registerWorkspaceHandlers(ipcMain, getMainWindow, getOrchestrator);

  // Settings handlers
  registerSettingsHandlers(ipcMain, getConfigService);

  // Update handlers
  registerUpdateHandlers(ipcMain);

  // MCP handlers
  registerMcpHandlers(ipcMain);

  // Memory handlers
  registerMemoryHandlers(ipcMain);

  // Planning handlers
  registerPlanningHandlers(ipcMain, getPlanningService);

  // Data/Cache handlers
  registerDataHandlers(ipcMain);

  logger.info('All handlers registered');
}
