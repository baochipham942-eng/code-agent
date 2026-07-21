// ============================================================================
// IPC Module - 统一注册所有 IPC handlers
// ============================================================================

import { app, type IpcMain, type AppWindow } from '../platform';
import type { ConfigService } from '../services';
import type { PlanningService } from '../planning';
import type { TaskManager } from '../task';
import type { AgentApplicationService } from '../../shared/contract/appService';
import { createLogger } from '../services/infra/logger';

const logger = createLogger('IPC');

import { registerAgentHandlers } from './agent.ipc';
import { registerSessionHandlers } from './session.ipc';
import { registerAuthHandlers } from './auth.ipc';
import { registerAdminHandlers } from './admin.ipc';
import { registerSyncHandlers } from './sync.ipc';
import { registerWorkspaceHandlers } from './workspace.ipc';
import { registerSettingsHandlers } from './settings.ipc';
import { registerUpdateHandlers } from './update.ipc';
import { registerMcpHandlers } from './mcp.ipc';
import { registerOpenchronicleHandlers } from './openchronicle.ipc';
import { registerConnectorHandlers } from './connector.ipc';
import { registerMemoryHandlers } from './memory.ipc';
import { registerPlanningHandlers } from './planning.ipc';
import { registerDataHandlers } from './data.ipc';
import { registerSpeechHandlers } from './speech.ipc';
import { registerTaskHandlers } from './task.ipc';
import { registerStatusHandlers } from './status.ipc';
import { registerContextHealthHandlers } from './contextHealth.ipc';
import { registerSessionStatusHandlers } from './sessionStatus.ipc';
import { registerSkillHandlers } from './skill.ipc';
import { registerPromptCommandHandlers } from './commands.ipc';
import { registerEvaluationHandlers } from './evaluation.ipc';
import { registerMarketplaceHandlers } from './marketplace.ipc';
import { registerExtensionHandlers } from './extension.ipc';
import { registerLabHandlers } from './lab.ipc';
import { registerChannelHandlers } from './channel.ipc';
import { registerAgentRoutingHandlers } from './agentRouting.ipc';
import { registerCheckpointHandlers } from './checkpoint.ipc';
import { registerLSPHandlers } from './lsp.ipc';
import { registerBackgroundHandlers } from './background.ipc';
import { registerBackgroundTaskLedgerHandlers } from './backgroundTaskLedger.ipc';
import { registerQueuedInputHandlers } from './queuedInput.ipc';
import { registerDiffHandlers } from './diff.ipc';
import { registerSwarmHandlers } from './swarm.ipc';
// 模块加载即自装 workflow EventBus → renderer 专用 bridge（P3a 进度树）；
// registerWorkflowHandlers 注册启动审批 approve/reject 回传（P3b）。
import { registerWorkflowHandlers } from './workflow.ipc';
import { registerTaskListHandlers } from '../agent/taskList/taskList.ipc';
import { registerTelemetryHandlers } from './telemetry.ipc';
import { registerCronHandlers } from './cron.ipc';
import { registerLoopHandlers } from './loop.ipc';
import { registerSessionAutomationHandlers } from './sessionAutomation.ipc';
import { registerNotificationHandlers } from './notification.ipc';
import { registerCaptureHandlers } from './capture.ipc';
import { registerDesktopHandlers } from './desktop.ipc';
import { registerSurfaceExecutionHandlers } from './surfaceExecution.ipc';
import { registerSuggestionsHandlers } from './suggestions.ipc';
import { registerSoulHandlers } from './soul.ipc';
import { registerVoicePasteHandlers } from './voicePaste.ipc';
import { registerContextHandlers } from './context.ipc';
import { registerProviderHandlers } from './provider.ipc';
import { registerLivePreviewHandlers } from './livePreview.ipc';
import { registerActivityHandlers } from './activity.ipc';
import { registerInAppValidationHandlers } from './inAppValidation.ipc';
import { registerPromptHandlers } from './prompt.ipc';
import { registerHookHandlers } from './hook.ipc';
import { registerDiagnosticsHandlers } from './diagnostics.ipc';
import { registerAgentRegistryHandlers } from './agentRegistry.ipc';
import { registerRolesHandlers } from './roles.ipc';
import { registerProjectHandlers } from './project.ipc';
import { registerTagHandlers } from './tag.ipc';
import { registerAgentEngineHandlers } from './agentEngine.ipc';
import { registerCapabilityHandlers } from './capability.ipc';
import { registerHandoffHandlers } from './handoff.ipc';
import { registerPiiHandlers } from './pii.ipc';
import { registerAlmaRegistryHandlers } from './almaRegistry.ipc';
import { registerGenerativeUIHandlers } from './generativeUI.ipc';
import { registerFolderTrustHandlers } from './folderTrust.ipc';
import { getApplicationRunRegistry } from '../app/applicationRunRegistry';

/**
 * IPC handler 注册所需的依赖
 */
export interface IpcDependencies {
  getMainWindow: () => AppWindow | null;
  getAppService: () => AgentApplicationService | null;
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
    getAppService,
    getConfigService,
    getPlanningService,
    getTaskManager,
  } = deps;

  // Agent handlers (via AgentApplicationService)
  registerAgentHandlers(ipcMain, getAppService);

  // Session handlers (via AgentApplicationService)
  registerSessionHandlers(ipcMain, getAppService);

  // Auth handlers
  registerAuthHandlers(ipcMain);

  // Admin handlers
  registerAdminHandlers(ipcMain);

  // Sync handlers
  registerSyncHandlers(ipcMain);

  // Workspace handlers
  registerWorkspaceHandlers(ipcMain, getMainWindow, getAppService, getConfigService);

  // Settings handlers
  registerSettingsHandlers(ipcMain, getConfigService);

  // Update handlers
  registerUpdateHandlers(ipcMain);

  // MCP handlers
  registerMcpHandlers(ipcMain, {
    getWorkingDirectory: () => getAppService()?.getWorkingDirectory() || app.getPath('home'),
  });

  // OpenChronicle (屏幕记忆) handlers
  registerOpenchronicleHandlers(ipcMain);

  // PII 防线 handlers (B3 一键启用本地 GLiNER PII 防线)
  registerPiiHandlers(ipcMain);
  registerGenerativeUIHandlers(ipcMain);
  registerFolderTrustHandlers(ipcMain, getAppService);

  // Connector handlers
  registerConnectorHandlers(ipcMain, getMainWindow, getConfigService);

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
  registerContextHealthHandlers({ getAppService, getTaskManager });

  // Session status handlers (多会话并行)
  registerSessionStatusHandlers();

  // Skill handlers (Skill 仓库管理和会话挂载)
  registerSkillHandlers(ipcMain);

  // Prompt command handlers (/命令协议层, roadmap 2.2)
  registerPromptCommandHandlers(ipcMain);

  // Evaluation handlers (GAP-017: Harness 对照实验)
  registerEvaluationHandlers(ipcMain);

  // Marketplace handlers (Skill Marketplace)
  registerMarketplaceHandlers(ipcMain);

  // Unified extension handlers (/plugins GUI command)
  registerExtensionHandlers(ipcMain);

  // Lab handlers (实验室)
  registerLabHandlers(ipcMain, getMainWindow);

  // Channel handlers (多通道接入)
  registerChannelHandlers(ipcMain, getMainWindow);

  // Agent Routing handlers (Agent 路由)
  registerAgentRoutingHandlers(ipcMain);

  // Checkpoint handlers
  registerCheckpointHandlers(ipcMain);

  // LSP handlers (语言服务器)
  registerLSPHandlers();

  // Background task handlers (后台任务)
  registerBackgroundHandlers(getMainWindow);
  registerBackgroundTaskLedgerHandlers(ipcMain);
  registerQueuedInputHandlers(ipcMain, {
    resolveModelSpec: (sessionId) => {
      const activeRunModelSpec = getApplicationRunRegistry().getModelSpecBySessionId(sessionId);
      if (activeRunModelSpec) return activeRunModelSpec;

      const activeTaskModelSpec = getTaskManager()?.getActiveModelSpec(sessionId);
      if (activeTaskModelSpec) return activeTaskModelSpec;

      const override = getAppService()?.getModelOverride(sessionId);
      return override && override.adaptive !== true
        ? { provider: override.provider, model: override.model }
        : undefined;
    },
  });

  // Diff handlers (变更追踪)
  registerDiffHandlers();

  // Swarm handlers (Agent Teams P2P 通信)
  registerSwarmHandlers(getAppService);

  // dynamic-workflow 启动审批 approve/reject 回传（P3b）
  registerWorkflowHandlers();

  // TaskList handlers (任务列表可视化与管理)
  registerTaskListHandlers();

  // Telemetry handlers (会话遥测)
  registerTelemetryHandlers(getMainWindow);

  // Cron handlers (定时任务)
  registerCronHandlers();

  // Loop handlers (会话内循环 /loop)
  registerLoopHandlers();

  // Session automation handlers (会话级自动化统计与回流)
  registerSessionAutomationHandlers();

  // Notification handlers (桌面通知只读查询)
  registerNotificationHandlers();

  // Capture handlers (浏览器采集)
  registerCaptureHandlers(ipcMain);

  // Desktop handlers (原生桌面活动)
  registerDesktopHandlers(ipcMain);

  // Surface Execution (Browser / Computer owner-aware snapshot + controls)
  registerSurfaceExecutionHandlers(ipcMain);

  // Activity context handlers (统一活动上下文)
  registerActivityHandlers(ipcMain);

  // Handoff proposals (assistant tail -> pending continuation object)
  registerHandoffHandlers(ipcMain);

  // In-App HTML validation result handler
  registerInAppValidationHandlers(ipcMain);

  // Soul handlers (人格)
  registerSoulHandlers();

  // Suggestions handlers (智能提示)
  registerSuggestionsHandlers(() => {
    const appService = getAppService();
    return appService?.getWorkingDirectory() || app.getPath('home');
  });

  // VoicePaste handlers (全局语音粘贴 Cmd+`)
  registerVoicePasteHandlers(ipcMain);

  // Context observability handlers (/context true-view)
  registerContextHandlers({ getAppService });

  // Provider handlers (连接测试)
  registerProviderHandlers(ipcMain);

  // Alma registry audit refresh
  registerAlmaRegistryHandlers(ipcMain);

  // Live Preview handlers (click-to-source bridge 配合)
  registerLivePreviewHandlers(ipcMain);

  // Prompt handlers (提示词管理 + override)
  registerPromptHandlers(ipcMain);

  // Hook handlers (Hook 列表 + 打开配置)
  registerHookHandlers(ipcMain, getAppService);

  // Diagnostics handlers (exec policy / 决策历史 / budget / 压缩统计 — 供 GUI 命令查询)
  registerDiagnosticsHandlers(ipcMain);

  // Agent Registry handlers (自定义 agent 列表 + 变更推送)
  registerAgentRegistryHandlers(ipcMain, () => {
    // 用 BrowserWindow.getAllWindows() 拿全部窗口（不光是 main），保证 Lab/Inspector 等子窗口也能收到变更
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { AppWindow } = require('../platform') as typeof import('../platform');
    return AppWindow.getAllWindows();
  });

  // Roles handlers (持久化角色资产面板：列表/详情/记忆删改)
  registerRolesHandlers(ipcMain);

  // Project handlers (P0-2 项目空间容器：项目/目标/角色入驻/产物聚合)
  registerProjectHandlers(ipcMain);

  // Tag handlers (@neo work card contract)
  registerTagHandlers(ipcMain);

  // Agent Engine handlers (Native / Codex CLI / Claude Code detection)
  registerAgentEngineHandlers(ipcMain);

  // Capability Center handlers (Skill / MCP / Tool / Channel inventory)
  registerCapabilityHandlers(ipcMain, { getConfigService, getAppService });

  logger.info('All handlers registered');
}
