// ============================================================================
// Cowork Contract Manager - 合约管理
// Phase 1: Cowork 角色体系重构
// ============================================================================

import type {
  CoworkContract,
  CoworkAgentRole,
  CoworkExecutionRules,
  CoworkTemplateId,
} from '../../shared/types/cowork';
import { COWORK_TEMPLATES, getCoworkTemplate } from '../../shared/types/cowork';
import { getPredefinedAgent } from '../agent/agentDefinition';
import { createLogger } from '../services/infra/logger';

const logger = createLogger('CoworkContract');

// ============================================================================
// Contract Validation
// ============================================================================

/**
 * 合约验证结果
 */
export interface ContractValidationResult {
  valid: boolean;
  errors: string[];
  warnings: string[];
}

/**
 * 验证 Cowork 合约
 */
export function validateContract(contract: CoworkContract): ContractValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  // 1. 基本字段验证
  if (!contract.id) {
    errors.push('Contract must have an id');
  }
  if (!contract.name) {
    errors.push('Contract must have a name');
  }
  if (!contract.agentRoles || contract.agentRoles.length === 0) {
    errors.push('Contract must have at least one agent role');
  }

  // 2. Agent 角色验证
  const agentTypes = new Set<string>();
  for (const role of contract.agentRoles) {
    // 检查重复
    if (agentTypes.has(role.agentType)) {
      errors.push(`Duplicate agent type: ${role.agentType}`);
    }
    agentTypes.add(role.agentType);

    // 检查 Agent 是否存在
    if (!getPredefinedAgent(role.agentType)) {
      warnings.push(`Unknown agent type: ${role.agentType}`);
    }

    // 检查职责和交付物
    if (!role.responsibilities || role.responsibilities.length === 0) {
      warnings.push(`Agent ${role.agentType} has no responsibilities defined`);
    }
    if (!role.deliverables || role.deliverables.length === 0) {
      warnings.push(`Agent ${role.agentType} has no deliverables defined`);
    }
  }

  // 3. 执行规则验证
  const rules = contract.executionRules;
  if (rules) {
    // 验证依赖关系引用的 Agent 存在
    if (rules.dependencies) {
      for (const [agent, deps] of Object.entries(rules.dependencies)) {
        if (!agentTypes.has(agent)) {
          errors.push(`Dependency references unknown agent: ${agent}`);
        }
        for (const dep of deps) {
          if (!agentTypes.has(dep)) {
            errors.push(`Dependency references unknown agent: ${dep}`);
          }
        }
      }

      // 检测循环依赖
      const cycle = detectCyclicDependency(rules.dependencies);
      if (cycle) {
        errors.push(`Cyclic dependency detected: ${cycle.join(' -> ')}`);
      }
    }

    // 验证并行组引用的 Agent 存在
    if (rules.parallelGroups) {
      for (const group of rules.parallelGroups) {
        for (const agent of group) {
          if (!agentTypes.has(agent)) {
            warnings.push(`Parallel group references unknown agent: ${agent}`);
          }
        }
      }
    }
  }

  return {
    valid: errors.length === 0,
    errors,
    warnings,
  };
}

/**
 * 检测循环依赖
 */
function detectCyclicDependency(dependencies: Record<string, string[]>): string[] | null {
  const visited = new Set<string>();
  const recursionStack = new Set<string>();
  const path: string[] = [];

  function dfs(node: string): boolean {
    visited.add(node);
    recursionStack.add(node);
    path.push(node);

    const deps = dependencies[node] || [];
    for (const dep of deps) {
      if (!visited.has(dep)) {
        if (dfs(dep)) {
          return true;
        }
      } else if (recursionStack.has(dep)) {
        path.push(dep);
        return true;
      }
    }

    path.pop();
    recursionStack.delete(node);
    return false;
  }

  for (const node of Object.keys(dependencies)) {
    if (!visited.has(node)) {
      if (dfs(node)) {
        // 返回循环路径
        const cycleStart = path[path.length - 1];
        const cycleStartIndex = path.indexOf(cycleStart);
        return path.slice(cycleStartIndex);
      }
    }
  }

  return null;
}

// ============================================================================
// Contract Resolution
// ============================================================================

/**
 * 解析合约：支持模板 ID 或自定义合约
 */
export function resolveContract(
  contractOrId: string | CoworkContract
): CoworkContract | undefined {
  if (typeof contractOrId === 'string') {
    // 尝试作为模板 ID 解析
    return getCoworkTemplate(contractOrId as CoworkTemplateId);
  }
  return contractOrId;
}

/**
 * 合并合约与覆盖配置
 */
export function mergeContractOverrides(
  contract: CoworkContract,
  overrides?: {
    excludeRoles?: string[];
    additionalRoles?: CoworkAgentRole[];
  }
): CoworkContract {
  if (!overrides) {
    return contract;
  }

  let agentRoles = [...contract.agentRoles];

  // 排除角色
  if (overrides.excludeRoles && overrides.excludeRoles.length > 0) {
    agentRoles = agentRoles.filter(
      role => !overrides.excludeRoles!.includes(role.agentType)
    );
  }

  // 添加角色
  if (overrides.additionalRoles && overrides.additionalRoles.length > 0) {
    agentRoles = [...agentRoles, ...overrides.additionalRoles];
  }

  return {
    ...contract,
    agentRoles,
  };
}

// ============================================================================
// Execution Order Calculation
// ============================================================================

/**
 * 执行阶段
 */
export interface ExecutionStage {
  /** 阶段编号 */
  stage: number;
  /** 可并行执行的 Agent */
  agents: string[];
}

/**
 * 计算执行顺序
 *
 * 基于依赖关系和并行组，计算最优执行顺序
 */
export function calculateExecutionOrder(contract: CoworkContract): ExecutionStage[] {
  const rules = contract.executionRules;
  const agentTypes = contract.agentRoles.map(r => r.agentType);
  const stages: ExecutionStage[] = [];

  // 无依赖关系：所有 Agent 可并行
  if (!rules.dependencies || Object.keys(rules.dependencies).length === 0) {
    // 检查是否有并行组定义
    if (rules.parallelGroups && rules.parallelGroups.length > 0) {
      let stageNum = 0;
      const scheduled = new Set<string>();

      for (const group of rules.parallelGroups) {
        const validAgents = group.filter(a => agentTypes.includes(a) && !scheduled.has(a));
        if (validAgents.length > 0) {
          stages.push({ stage: stageNum++, agents: validAgents });
          validAgents.forEach(a => scheduled.add(a));
        }
      }

      // 调度剩余未分组的 Agent
      const remaining = agentTypes.filter(a => !scheduled.has(a));
      if (remaining.length > 0) {
        stages.push({ stage: stageNum, agents: remaining });
      }
    } else {
      // 全部并行
      stages.push({ stage: 0, agents: agentTypes });
    }
    return stages;
  }

  // 有依赖关系：拓扑排序
  const dependencies = rules.dependencies;
  const inDegree = new Map<string, number>();
  const adjList = new Map<string, string[]>();

  // 初始化
  for (const agent of agentTypes) {
    inDegree.set(agent, 0);
    adjList.set(agent, []);
  }

  // 构建图
  for (const [dependent, deps] of Object.entries(dependencies)) {
    if (!agentTypes.includes(dependent)) continue;
    for (const dep of deps) {
      if (!agentTypes.includes(dep)) continue;
      adjList.get(dep)!.push(dependent);
      inDegree.set(dependent, (inDegree.get(dependent) || 0) + 1);
    }
  }

  // BFS 分层
  let stageNum = 0;
  let queue = agentTypes.filter(a => inDegree.get(a) === 0);

  while (queue.length > 0) {
    stages.push({ stage: stageNum++, agents: [...queue] });

    const nextQueue: string[] = [];
    for (const agent of queue) {
      for (const dependent of adjList.get(agent) || []) {
        const newDegree = (inDegree.get(dependent) || 0) - 1;
        inDegree.set(dependent, newDegree);
        if (newDegree === 0) {
          nextQueue.push(dependent);
        }
      }
    }
    queue = nextQueue;
  }

  // 检查是否所有 Agent 都被调度
  const scheduled = stages.flatMap(s => s.agents);
  const unscheduled = agentTypes.filter(a => !scheduled.includes(a));
  if (unscheduled.length > 0) {
    logger.warn('Some agents could not be scheduled (possible cycle)', { unscheduled });
  }

  return stages;
}

// ============================================================================
// Export
// ============================================================================

export {
  COWORK_TEMPLATES,
  getCoworkTemplate,
  listCoworkTemplates,
} from '../../shared/types/cowork';
