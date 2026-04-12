// ============================================================================
// Agent Orchestrator - Types & Constants
// ============================================================================

import type { AgentEvent } from '../../../shared/contract';
import type { ConfigService } from '../../services/core/configService';
import type { PlanningService } from '../../planning';
import type { DAGVisualizationEvent } from '../../../shared/contract/dagVisualization';

/**
 * Agent Orchestrator 配置
 * @internal
 */
export interface AgentOrchestratorConfig {
  configService: ConfigService;
  onEvent: (event: AgentEvent) => void;
  planningService?: PlanningService;
  getHomeDir?: () => string;
  broadcastDAGEvent?: (event: DAGVisualizationEvent) => void;
}

/** 消息历史最大长度（内存管理） */
export const MAX_MESSAGES_IN_MEMORY = 200;
