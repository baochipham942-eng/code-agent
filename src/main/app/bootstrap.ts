// ============================================================================
// Bootstrap - 服务初始化入口（thin orchestrator）
//
// 各阶段实现已拆分到独立模块：
//   Phase 1: initCoreServices.ts — DB, config, logger, shell environment
//   Phase 2: initBackgroundServices.ts — cron, telemetry, cloud, updates, MCP
//   Phase 3: createAgentRuntime.ts — TaskManager (sole orchestrator owner), channels
//   Phase 4: restoreSession.ts — session restoration, planning service
// ============================================================================

import { createLogger } from '../services/infra/logger';
import { ConfigService } from '../services';
import { AgentOrchestrator } from '../agent/agentOrchestrator';
import { getTaskManager, type TaskManager } from '../task';
import type { PlanningService } from '../planning';
import type { AgentApplicationService } from '../../shared/types/appService';
import { AgentAppServiceImpl } from './agentAppService';

import { initializeCoreServices as initCoreServicesImpl } from './initCoreServices';
import { initializeBackgroundInfra } from './initBackgroundServices';
import { createAgentRuntime } from './createAgentRuntime';
import { initializeSession, initializePlanningService } from './restoreSession';

const logger = createLogger('Bootstrap');

// Global state (reduced: no more global agentOrchestrator)
let configService: ConfigService | null = null;
let planningService: PlanningService | null = null;
let appService: AgentApplicationService | null = null;

// ── Getters / Setters (preserve existing export signatures) ─────────────

/**
 * 获取配置服务实例
 */
export function getConfigServiceInstance(): ConfigService | null {
  return configService;
}

/**
 * 获取 Agent Orchestrator 实例
 *
 * Delegates to TaskManager — returns the orchestrator for the current
 * active session. Returns null if no session is active yet.
 */
export function getAgentOrchestrator(): AgentOrchestrator | null {
  const taskManager = getTaskManager();
  return taskManager.getOrCreateCurrentOrchestrator() ?? null;
}

/**
 * 获取当前会话 ID
 */
export function getCurrentSessionId(): string | null {
  return getTaskManager().getCurrentSessionId();
}

/**
 * 设置当前会话 ID
 */
export function setCurrentSessionId(id: string): void {
  getTaskManager().setCurrentSessionId(id);
}

/**
 * 获取 Planning Service 实例
 */
export function getPlanningServiceInstance(): PlanningService | null {
  return planningService;
}

/**
 * 获取 TaskManager 实例
 */
export function getTaskManagerInstance(): TaskManager | null {
  return getTaskManager();
}

/**
 * 获取 AgentApplicationService 实例
 * IPC handler 的唯一业务依赖（替代直接 import AgentOrchestrator/TaskManager）
 */
export function getAppServiceInstance(): AgentApplicationService | null {
  return appService;
}

// ── Phase 1: Core Services ─────────────────────────────────────────────

/**
 * 核心服务初始化 - 必须在窗口创建前完成
 * 只包含 IPC handlers 依赖的最小服务集
 */
export async function initializeCoreServices(): Promise<ConfigService> {
  configService = await initCoreServicesImpl();
  return configService;
}

// ── Phase 2–4: Background Services (called after window creation) ──────

/**
 * 后台服务初始化 - 窗口创建后异步执行
 * 不阻塞用户交互
 */
export async function initializeBackgroundServices(): Promise<void> {
  if (!configService) {
    throw new Error('Core services not initialized');
  }

  logger.info('Starting background services...');

  const settings = configService.getSettings();

  // Phase 2: Background infrastructure (cloud, MCP, cron, updates, etc.)
  await initializeBackgroundInfra(configService);

  // Phase 3: Agent runtime (TaskManager as sole orchestrator owner, channels)
  createAgentRuntime(configService);

  // Phase 3b: Create AgentApplicationService (facade for IPC layer)
  appService = new AgentAppServiceImpl(
    () => getTaskManager(),
    () => configService,
    () => getTaskManager().getCurrentSessionId(),
    (id: string) => getTaskManager().setCurrentSessionId(id),
  );

  // Phase 4a: Session restoration (uses TaskManager to manage orchestrator)
  logger.info('Initializing session...');
  const currentSessionId = await initializeSession(settings);
  logger.info('Session initialized', { currentSessionId });

  // Phase 4b: Planning service
  logger.info('Initializing planning service...');
  planningService = await initializePlanningService(currentSessionId);
  logger.info('Planning service initialized');

  logger.info('Background services initialization complete');
}
