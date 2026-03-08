// ============================================================================
// Unified Orchestrator - Cloud task execution orchestration
// ============================================================================

import { createLogger } from '../services/infra/logger';

const logger = createLogger('Orchestrator');

export interface CloudExecutorConfig {
  maxConcurrent: number;
  defaultTimeout: number;
  maxIterations: number;
  apiEndpoint: string;
}

export interface OrchestratorConfig {
  cloudExecutor: CloudExecutorConfig;
}

let orchestratorConfig: OrchestratorConfig | null = null;

/**
 * Initialize the unified orchestrator
 */
export function initUnifiedOrchestrator(config: OrchestratorConfig): void {
  orchestratorConfig = config;
  logger.info('Unified orchestrator initialized', {
    maxConcurrent: config.cloudExecutor.maxConcurrent,
    apiEndpoint: config.cloudExecutor.apiEndpoint,
  });
}

/**
 * Get the orchestrator config
 */
export function getOrchestratorConfig(): OrchestratorConfig | null {
  return orchestratorConfig;
}
