// ============================================================================
// Agent Orchestrator - Types & Constants
// ============================================================================

import type { AgentEvent, PermissionRequest } from '../../../shared/contract';
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
  /**
   * 这条审批请求**能不能真的送到某个能裁决它的界面上**；不能时继续按短超时 fail-closed。
   * 判据是「这张卡送得到吗」而不是「有没有通道在线」——手机通道在线但卡片因超长被跳过时，
   * 按通道回答会取消超时，运行就永久挂在一个谁也没看见的 tool call 上。
   */
  hasApprovalUi: (request: PermissionRequest) => boolean;
  planningService?: PlanningService;
  runRegistry?: RunRegistry;
  getHomeDir?: () => string;
  broadcastDAGEvent?: (event: DAGVisualizationEvent) => void;
  /**
   * 无人值守停车审批的持久化仓库（B2）。生产不注入时懒取 getDatabase()；
   * 测试注入 :memory: repo，避免真库依赖。
   */
  pendingApprovalRepo?: PendingApprovalRepository;
}

/** 消息历史最大长度（内存管理） */
export const MAX_MESSAGES_IN_MEMORY = 200;
