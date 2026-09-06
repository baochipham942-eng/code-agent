// ============================================================================
// Agent Orchestrator - Types & Constants
// ============================================================================

import type { AgentEvent } from '../../../shared/contract';
import type { ConfigService } from '../../services/core/configService';
import type { PlanningService } from '../../planning';
import type { DAGVisualizationEvent } from '../../../shared/contract/dagVisualization';
import type { RunRegistry } from '../../runtime/runRegistry';
import type { PendingApprovalRepository } from '../../services/core/repositories/PendingApprovalRepository';

/**
 * Agent Orchestrator 配置
 * @internal
 */
export interface AgentOrchestratorConfig {
  configService: ConfigService;
  onEvent: (event: AgentEvent) => void;
  /** 当前宿主是否存在能裁决工具审批的 UI；无 UI 时审批继续按短超时 fail-closed。 */
  hasApprovalUi: () => boolean;
  planningService?: PlanningService;
  runRegistry?: RunRegistry;
  getHomeDir?: () => string;
  broadcastDAGEvent?: (event: DAGVisualizationEvent) => void;
  /**
   * 停车审批的持久化仓库。生产不注入时懒取 getDatabase()；
   * 测试注入 :memory: repo，避免真库依赖。
   */
  pendingApprovalRepo?: PendingApprovalRepository;
}

/** 消息历史最大长度（内存管理） */
export const MAX_MESSAGES_IN_MEMORY = 200;
