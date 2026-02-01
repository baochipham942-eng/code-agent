// ============================================================================
// Cowork Module - 多 Agent 协作框架
// Phase 1: Cowork 角色体系重构
// ============================================================================

// Types
export type {
  CoworkContract,
  CoworkAgentRole,
  CoworkSharedResources,
  CoworkExecutionRules,
  CoworkTaskInput,
  CoworkAgentResult,
  CoworkResult,
  CoworkTemplateId,
} from '../../shared/types/cowork';

// Contract Management
export {
  validateContract,
  resolveContract,
  mergeContractOverrides,
  calculateExecutionOrder,
  type ExecutionStage,
  type ContractValidationResult,
  // Re-exports from shared
  COWORK_TEMPLATES,
  getCoworkTemplate,
  listCoworkTemplates,
} from './coworkContract';

// Orchestrator
export {
  CoworkOrchestrator,
  createCoworkOrchestrator,
  type CoworkOrchestratorConfig,
} from './coworkOrchestrator';
