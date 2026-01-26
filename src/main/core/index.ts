// ============================================================================
// Core Module - 核心模块导出
// ============================================================================

// Container
export {
  Container,
  Lifecycle,
  ServiceToken,
  createToken,
  getContainer,
  setContainer,
  resetContainer,
  type Initializable,
  type Disposable,
  type ContainerConfig,
} from './container';

// Lifecycle
export {
  LifecycleManager,
  ServicePhase,
  ServiceStatus,
  getLifecycle,
  setLifecycle,
  type ServiceDefinition,
  type ServiceInfo,
  type LifecycleConfig,
} from './lifecycle';

// Tokens
export {
  SERVICE_TOKENS,
  ConfigServiceToken,
  DatabaseServiceToken,
  MemoryServiceToken,
  SessionManagerToken,
  AuthServiceToken,
  SyncServiceToken,
  AgentOrchestratorToken,
  GenerationManagerToken,
  PlanningServiceToken,
  TaskManagerToken,
  MCPClientToken,
  BudgetServiceToken,
  SkillDiscoveryToken,
  SkillRepositoryToken,
} from './tokens';

// Service Definitions
export { defineServices, createLifecycleManager } from './services';
