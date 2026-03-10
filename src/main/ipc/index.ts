// ============================================================================
// IPC Module - 统一注册所有 IPC handlers
// ============================================================================

import type { IpcMain, BrowserWindow } from 'electron';
import type { AgentOrchestrator } from '../agent/agentOrchestrator';
import type { ConfigService } from '../services';
import type { PlanningService } from '../planning';
import type { TaskManager } from '../task';
import { createLogger } from '../services/infra/logger';

const logger = createLogger('IPC');

import { registerAgentHandlers } from './agent.ipc';
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
import { registerSpeechHandlers } from './speech.ipc';
import { registerTaskHandlers } from './task.ipc';
import { registerStatusHandlers } from './status.ipc';
import { registerContextHealthHandlers } from './contextHealth.ipc';
import { registerSessionStatusHandlers } from './sessionStatus.ipc';
import { registerSkillHandlers } from './skill.ipc';
import { registerMarketplaceHandlers } from './marketplace.ipc';
import { registerLabHandlers } from './lab.ipc';
import { registerChannelHandlers } from './channel.ipc';
import { registerAgentRoutingHandlers } from './agentRouting.ipc';
import { registerCheckpointHandlers } from './checkpoint.ipc';
// evaluation.ipc is loaded dynamically — excluded from production bundle via EVAL_DISABLED define
import { registerLSPHandlers } from './lsp.ipc';
import { registerBackgroundHandlers } from './background.ipc';
import { registerDiffHandlers } from './diff.ipc';
import { registerSwarmHandlers } from './swarm.ipc';
import { registerTaskListHandlers } from '../agent/taskList/taskList.ipc';
import { registerTelemetryHandlers } from './telemetry.ipc';
import { registerCronHandlers } from './cron.ipc';
import { registerCaptureHandlers } from './capture.ipc';
import { registerSuggestionsHandlers } from './suggestions.ipc';
import { registerSoulHandlers } from './soul.ipc';
import { registerVoicePasteHandlers } from './voicePaste.ipc';

export * from './types';

/**
 * IPC handler 注册所需的依赖
 */
export interface IpcDependencies {
  getMainWindow: () => BrowserWindow | null;
  getOrchestrator: () => AgentOrchestrator | null;
  getConfigService: () => ConfigService | null;
  getPlanningService: () => PlanningService | null;
  getTaskManager: () => TaskManager | null;
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
    getConfigService,
    getPlanningService,
    getTaskManager,
    getCurrentSessionId,
    setCurrentSessionId,
  } = deps;

  // Agent handlers
  registerAgentHandlers(ipcMain, getOrchestrator);

  // Session handlers
  registerSessionHandlers(ipcMain, {
    getConfigService,
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

  // Speech handlers
  registerSpeechHandlers(ipcMain);


  // Task handlers (Wave 5: 多任务并行)
  registerTaskHandlers(ipcMain, getTaskManager);

  // Status handlers (UX 改进)
  registerStatusHandlers();

  // Context health handlers (上下文健康度)
  registerContextHealthHandlers();

  // Session status handlers (多会话并行)
  registerSessionStatusHandlers();

  // Skill handlers (Skill 仓库管理和会话挂载)
  registerSkillHandlers(ipcMain);

  // Marketplace handlers (Skill Marketplace)
  registerMarketplaceHandlers(ipcMain);

  // Lab handlers (实验室)
  registerLabHandlers(ipcMain, getMainWindow);

  // Channel handlers (多通道接入)
  registerChannelHandlers(ipcMain, getMainWindow);

  // Agent Routing handlers (Agent 路由)
  registerAgentRoutingHandlers(ipcMain);

  // Checkpoint handlers
  registerCheckpointHandlers(ipcMain);

  // Evaluation handlers (会话评测) — dynamic import, excluded from production bundle
  if (process.env.EVAL_DISABLED !== 'true') {
    import('./evaluation.ipc').then(({ registerEvaluationHandlers, registerSubsetHandlers }) => {
      registerEvaluationHandlers();
      registerSubsetHandlers();
    }).catch(() => { /* evaluation module not available in production build */ });
  }

  // LSP handlers (语言服务器)
  registerLSPHandlers();

  // Background task handlers (后台任务)
  registerBackgroundHandlers(getMainWindow);

  // Diff handlers (变更追踪)
  registerDiffHandlers();

  // Swarm handlers (Agent Teams P2P 通信)
  registerSwarmHandlers(getOrchestrator);

  // TaskList handlers (任务列表可视化与管理)
  registerTaskListHandlers();

  // Telemetry handlers (会话遥测)
  registerTelemetryHandlers(getMainWindow);

  // Cron handlers (定时任务)
  registerCronHandlers();

  // Capture handlers (浏览器采集)
  registerCaptureHandlers(ipcMain);

  // Soul handlers (人格)
  registerSoulHandlers();

  // Suggestions handlers (智能提示)
  registerSuggestionsHandlers(() => {
    const orchestrator = getOrchestrator();
    return (orchestrator as any)?.workingDirectory || process.cwd();
  });

  // VoicePaste handlers (全局语音粘贴 Cmd+`)
  registerVoicePasteHandlers(ipcMain);

  logger.info('All handlers registered');
}
