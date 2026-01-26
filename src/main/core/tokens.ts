// ============================================================================
// Service Tokens - 服务令牌定义
// ============================================================================
//
// 所有服务的类型安全标识符，用于依赖注入容器
// 使用 ServiceToken<T> 确保类型安全

import { createToken } from './container';

// 导入服务类型（仅用于类型定义）
import type { ConfigService } from '../services/core/configService';
import type { DatabaseService } from '../services/core/databaseService';
import type { MemoryService } from '../memory/memoryService';
import type { MCPClient } from '../mcp/mcpClient';
import type { AuthService } from '../services/auth/authService';
import type { SyncService } from '../services/sync/syncService';
import type { SessionManager } from '../services/infra/sessionManager';
import type { AgentOrchestrator } from '../agent/agentOrchestrator';
import type { GenerationManager } from '../generation/generationManager';
import type { PlanningService } from '../planning';
import type { TaskManager } from '../task';
import type { BudgetService } from '../services/core/budgetService';
import type { SkillDiscoveryService } from '../services/skills/skillDiscoveryService';
import type { SkillRepositoryService } from '../services/skills/skillRepositoryService';

// ----------------------------------------------------------------------------
// Core Services - 核心服务（必须在窗口创建前初始化）
// ----------------------------------------------------------------------------

/** 配置服务 */
export const ConfigServiceToken = createToken<ConfigService>('ConfigService');

/** 数据库服务 */
export const DatabaseServiceToken = createToken<DatabaseService>('DatabaseService');

/** 内存服务 */
export const MemoryServiceToken = createToken<MemoryService>('MemoryService');

/** 会话管理器 */
export const SessionManagerToken = createToken<SessionManager>('SessionManager');

// ----------------------------------------------------------------------------
// Auth Services - 认证服务
// ----------------------------------------------------------------------------

/** 认证服务 */
export const AuthServiceToken = createToken<AuthService>('AuthService');

/** 同步服务 */
export const SyncServiceToken = createToken<SyncService>('SyncService');

// ----------------------------------------------------------------------------
// Agent Services - Agent 服务
// ----------------------------------------------------------------------------

/** Agent 编排器 */
export const AgentOrchestratorToken = createToken<AgentOrchestrator>('AgentOrchestrator');

/** 生成管理器 */
export const GenerationManagerToken = createToken<GenerationManager>('GenerationManager');

/** 规划服务 */
export const PlanningServiceToken = createToken<PlanningService>('PlanningService');

/** 任务管理器 */
export const TaskManagerToken = createToken<TaskManager>('TaskManager');

// ----------------------------------------------------------------------------
// Infrastructure Services - 基础设施服务
// ----------------------------------------------------------------------------

/** MCP 客户端 */
export const MCPClientToken = createToken<MCPClient>('MCPClient');

/** 预算服务 */
export const BudgetServiceToken = createToken<BudgetService>('BudgetService');

// ----------------------------------------------------------------------------
// Skill Services - 技能服务
// ----------------------------------------------------------------------------

/** 技能发现服务 */
export const SkillDiscoveryToken = createToken<SkillDiscoveryService>('SkillDiscoveryService');

/** 技能仓库服务 */
export const SkillRepositoryToken = createToken<SkillRepositoryService>('SkillRepositoryService');

// ----------------------------------------------------------------------------
// 导出所有 Token 的集合（便于遍历）
// ----------------------------------------------------------------------------

export const SERVICE_TOKENS = {
  // Core
  ConfigService: ConfigServiceToken,
  DatabaseService: DatabaseServiceToken,
  MemoryService: MemoryServiceToken,
  SessionManager: SessionManagerToken,

  // Auth
  AuthService: AuthServiceToken,
  SyncService: SyncServiceToken,

  // Agent
  AgentOrchestrator: AgentOrchestratorToken,
  GenerationManager: GenerationManagerToken,
  PlanningService: PlanningServiceToken,
  TaskManager: TaskManagerToken,

  // Infrastructure
  MCPClient: MCPClientToken,
  BudgetService: BudgetServiceToken,

  // Skills
  SkillDiscovery: SkillDiscoveryToken,
  SkillRepository: SkillRepositoryToken,
} as const;
