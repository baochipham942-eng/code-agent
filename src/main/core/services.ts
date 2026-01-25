// ============================================================================
// Service Definitions - 服务定义
// ============================================================================
//
// 定义所有服务及其依赖关系，用于生命周期管理器
// 采用渐进式迁移策略：保持现有初始化函数兼容

import { app } from 'electron';
import path from 'path';
import { Container, Lifecycle } from './container';
import { LifecycleManager, ServicePhase, type ServiceDefinition } from './lifecycle';
import {
  ConfigServiceToken,
  DatabaseServiceToken,
  MemoryServiceToken,
  SessionManagerToken,
  AuthServiceToken,
  SyncServiceToken,
  AgentOrchestratorToken,
  GenerationManagerToken,
  MCPClientToken,
  BudgetServiceToken,
  SkillDiscoveryToken,
  SkillRepositoryToken,
  TaskManagerToken,
} from './tokens';
import { createLogger } from '../services/infra/logger';
import { TOOL_CACHE } from '../../shared/constants';

const logger = createLogger('ServiceDefinitions');

// ----------------------------------------------------------------------------
// Service Factory Functions
// ----------------------------------------------------------------------------

/**
 * 创建配置服务
 */
async function createConfigService() {
  const { ConfigService } = await import('../services/core/configService');
  const service = new ConfigService();
  await service.initialize();
  return service;
}

/**
 * 创建数据库服务
 */
async function createDatabaseService() {
  const { initDatabase, getDatabase } = await import('../services/core/databaseService');
  await initDatabase();
  const userDataPath = app.getPath('userData');
  logger.info('Database initialized', { path: path.join(userDataPath, 'code-agent.db') });
  return getDatabase();
}

/**
 * 创建内存服务
 */
async function createMemoryService() {
  const { initMemoryService, getMemoryService } = await import('../memory/memoryService');
  initMemoryService({
    maxRecentMessages: 10,
    toolCacheTTL: TOOL_CACHE.DEFAULT_TTL,
    maxSessionMessages: 100,
    maxRAGResults: 5,
    ragTokenLimit: 2000,
  });
  logger.info('Memory service initialized');
  return getMemoryService();
}

/**
 * 创建会话管理器
 */
async function createSessionManager() {
  const { getSessionManager } = await import('../services/infra/sessionManager');
  return getSessionManager();
}

/**
 * 创建认证服务
 */
async function createAuthService(container: Container) {
  const { getAuthService } = await import('../services/auth/authService');
  return getAuthService();
}

/**
 * 创建同步服务
 */
async function createSyncService(container: Container) {
  const { getSyncService } = await import('../services/sync/syncService');
  return getSyncService();
}

/**
 * 创建 MCP 客户端
 */
async function createMCPClient(container: Container) {
  const mcpModule = await import('../mcp/mcpClient');
  const configService = container.resolveSync(ConfigServiceToken);
  const settings = configService.getSettings();
  const mcpConfigs = settings.mcp?.servers || [];

  logger.info('Initializing MCP servers...', { customCount: mcpConfigs.length });
  await mcpModule.initMCPClient(mcpConfigs);

  return mcpModule.getMCPClient();
}

/**
 * 创建预算服务
 */
async function createBudgetService() {
  const { initBudgetService, getBudgetService } = await import('../services/core/budgetService');
  initBudgetService({});
  return getBudgetService();
}

/**
 * 创建生成管理器
 */
async function createGenerationManager() {
  const { GenerationManager } = await import('../generation/generationManager');
  return new GenerationManager();
}

/**
 * 创建技能发现服务
 */
async function createSkillDiscoveryService() {
  const { getSkillDiscoveryService } = await import('../services/skills/skillDiscoveryService');
  const service = getSkillDiscoveryService();
  await service.initialize(process.cwd());
  return service;
}

/**
 * 创建技能仓库服务
 */
async function createSkillRepositoryService() {
  const { getSkillRepositoryService } = await import('../services/skills/skillRepositoryService');
  const service = getSkillRepositoryService();
  await service.initialize();
  return service;
}

/**
 * 创建任务管理器
 */
async function createTaskManager(container: Container) {
  const { getTaskManager } = await import('../task');
  const generationManager = container.resolveSync(GenerationManagerToken);
  const configService = container.resolveSync(ConfigServiceToken);

  const taskManager = getTaskManager();
  taskManager.initialize({
    generationManager,
    configService,
    planningService: undefined, // Will be set later
    onAgentEvent: () => {}, // Will be set by bootstrap
  });

  return taskManager;
}

// ----------------------------------------------------------------------------
// Service Definitions
// ----------------------------------------------------------------------------

/**
 * 定义所有服务
 */
export function defineServices(lifecycle: LifecycleManager): void {
  // =========================================================================
  // Core Services (Phase: Core) - 必须在窗口创建前完成
  // =========================================================================

  lifecycle.define({
    token: ConfigServiceToken,
    phase: ServicePhase.Core,
    factory: createConfigService,
    critical: true,
  });

  lifecycle.define({
    token: DatabaseServiceToken,
    phase: ServicePhase.Core,
    factory: createDatabaseService,
    critical: true,
  });

  lifecycle.define({
    token: MemoryServiceToken,
    phase: ServicePhase.Core,
    factory: createMemoryService,
    dependencies: [DatabaseServiceToken],
    critical: true,
  });

  lifecycle.define({
    token: SessionManagerToken,
    phase: ServicePhase.Core,
    factory: createSessionManager,
    dependencies: [DatabaseServiceToken],
    critical: true,
  });

  // =========================================================================
  // Background Services (Phase: Background) - 窗口创建后异步初始化
  // =========================================================================

  lifecycle.define({
    token: AuthServiceToken,
    phase: ServicePhase.Background,
    factory: createAuthService,
    critical: false,
  });

  lifecycle.define({
    token: SyncServiceToken,
    phase: ServicePhase.Background,
    factory: createSyncService,
    dependencies: [AuthServiceToken],
    critical: false,
  });

  lifecycle.define({
    token: GenerationManagerToken,
    phase: ServicePhase.Background,
    factory: createGenerationManager,
    critical: true,
  });

  lifecycle.define({
    token: BudgetServiceToken,
    phase: ServicePhase.Background,
    factory: createBudgetService,
    critical: false,
  });

  lifecycle.define({
    token: TaskManagerToken,
    phase: ServicePhase.Background,
    factory: createTaskManager,
    dependencies: [GenerationManagerToken, ConfigServiceToken],
    critical: false,
  });

  // =========================================================================
  // Lazy Services (Phase: Lazy) - 按需初始化
  // =========================================================================

  lifecycle.define({
    token: MCPClientToken,
    phase: ServicePhase.Lazy,
    factory: createMCPClient,
    dependencies: [ConfigServiceToken],
    timeout: 60000, // MCP 连接可能较慢
    critical: false,
  });

  lifecycle.define({
    token: SkillRepositoryToken,
    phase: ServicePhase.Lazy,
    factory: createSkillRepositoryService,
    critical: false,
  });

  lifecycle.define({
    token: SkillDiscoveryToken,
    phase: ServicePhase.Lazy,
    factory: createSkillDiscoveryService,
    dependencies: [SkillRepositoryToken],
    critical: false,
  });
}

// ----------------------------------------------------------------------------
// Helper Functions
// ----------------------------------------------------------------------------

/**
 * 创建并配置生命周期管理器
 */
export function createLifecycleManager(container: Container): LifecycleManager {
  const lifecycle = new LifecycleManager(container, {
    defaultTimeout: 30000,
    parallelInit: true,
  });

  defineServices(lifecycle);

  return lifecycle;
}
