// ============================================================================
// Bootstrap - 服务初始化入口（thin orchestrator）
//
// 各阶段实现已拆分到独立模块：
//   Phase 1: initCoreServices.ts — DB, config, logger, shell environment
//   Phase 2: initBackgroundServices.ts — cron, telemetry, cloud, updates, MCP
//   Phase 3: createAgentRuntime.ts — orchestrator, task manager, channels
//   Phase 4: restoreSession.ts — session restoration, planning service
// ============================================================================

import { createLogger } from '../services/infra/logger';
import { ConfigService } from '../services';
import { AgentOrchestrator } from '../agent/agentOrchestrator';
import { getTaskManager, type TaskManager } from '../task';
import type { PlanningService } from '../planning';

import { initializeCoreServices as initCoreServicesImpl } from './initCoreServices';
import { initializeBackgroundInfra } from './initBackgroundServices';
import { createAgentRuntime } from './createAgentRuntime';
import { initializeSession, initializePlanningService } from './restoreSession';

const logger = createLogger('Bootstrap');

// Global state
let configService: ConfigService | null = null;
let agentOrchestrator: AgentOrchestrator | null = null;
let currentSessionId: string | null = null;
let planningService: PlanningService | null = null;

// ── Getters / Setters (preserve existing export signatures) ─────────────

/**
 * 获取配置服务实例
 */
export function getConfigServiceInstance(): ConfigService | null {
  return configService;
}

/**
 * 获取 Agent Orchestrator 实例
 */
export function getAgentOrchestrator(): AgentOrchestrator | null {
  return agentOrchestrator;
}

/**
 * 获取当前会话 ID
 */
export function getCurrentSessionId(): string | null {
  return currentSessionId;
}

/**
 * 设置当前会话 ID
 */
export function setCurrentSessionId(id: string): void {
  currentSessionId = id;
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

  // Phase 3: Agent runtime (orchestrator, task manager, channels)
  agentOrchestrator = createAgentRuntime(configService);

  // Phase 4a: Session restoration
  logger.info('Initializing session...');
  currentSessionId = await initializeSession(settings, agentOrchestrator);
  logger.info('Session initialized');

  // Phase 4b: Planning service
  logger.info('Initializing planning service...');
  planningService = await initializePlanningService(agentOrchestrator, currentSessionId);
  logger.info('Planning service initialized');

  logger.info('Background services initialization complete');
}
