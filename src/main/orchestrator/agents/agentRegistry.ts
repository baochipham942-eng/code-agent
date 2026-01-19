// ============================================================================
// AgentRegistry - Agent 注册表
// 管理所有 Agent 定义和实例
// ============================================================================

import { EventEmitter } from 'events';
import type {
  AgentDefinition,
  AgentInstance,
  AgentRole,
  AgentStatus,
  AgentCapability,
} from './types';
import { AGENT_TIMEOUT, AGENT_ITERATIONS } from '../../../shared/constants';

// ============================================================================
// 内置 Agent 定义
// ============================================================================

const BUILTIN_AGENTS: AgentDefinition[] = [
  {
    id: 'planner-v1',
    role: 'planner',
    name: 'Task Planner',
    description: '分析复杂任务并生成结构化的执行计划',
    systemPrompt: `你是一个专业的任务规划师。你的职责是：
1. 分析用户的复杂任务需求
2. 将任务分解为可执行的子任务
3. 确定子任务之间的依赖关系
4. 评估每个子任务需要的资源和能力
5. 生成结构化的执行计划

输出格式：
- 使用 Markdown 列表格式
- 每个子任务包含：描述、预估时间、所需能力、依赖项
- 标注可并行执行的任务
- 指出潜在风险和应对策略`,
    capabilities: ['file_read', 'code_analysis', 'task_delegation'],
    availableTools: ['read_file', 'glob', 'grep', 'list_directory', 'todo_write'],
    maxIterations: AGENT_ITERATIONS.PLANNER,
    timeout: AGENT_TIMEOUT.PLANNER,
    temperature: 0.3,
    preferredLocation: 'cloud',
    canDelegate: true,
    canReceiveDelegation: true,
    delegationTargets: ['researcher', 'coder', 'reviewer'],
  },
  {
    id: 'researcher-v1',
    role: 'researcher',
    name: 'Research Specialist',
    description: '搜索、收集和分析信息',
    systemPrompt: `你是一个专业的研究员。你的职责是：
1. 根据给定的主题进行深入研究
2. 搜索相关的技术文档、最佳实践和案例
3. 分析和整理收集到的信息
4. 提供有价值的见解和建议

研究原则：
- 优先使用官方文档和权威来源
- 注明信息来源
- 区分事实和观点
- 提供多角度分析`,
    capabilities: ['web_search', 'web_scrape', 'file_read', 'memory_access'],
    availableTools: ['web_fetch', 'cloud_search', 'cloud_scrape', 'read_file', 'memory_search'],
    maxIterations: AGENT_ITERATIONS.RESEARCHER,
    timeout: AGENT_TIMEOUT.RESEARCHER,
    temperature: 0.5,
    preferredLocation: 'cloud',
    canDelegate: false,
    canReceiveDelegation: true,
  },
  {
    id: 'coder-v1',
    role: 'coder',
    name: 'Code Developer',
    description: '编写、修改和优化代码',
    systemPrompt: `你是一个专业的软件开发者。你的职责是：
1. 根据需求编写高质量的代码
2. 遵循项目的编码规范和最佳实践
3. 编写清晰的注释和文档
4. 考虑代码的可维护性和可测试性

编码原则：
- 代码简洁清晰
- 遵循 SOLID 原则
- 适当处理错误和边界情况
- 使用有意义的变量和函数名`,
    capabilities: ['file_read', 'file_write', 'shell_execute', 'code_analysis'],
    availableTools: ['read_file', 'write_file', 'edit_file', 'bash', 'glob', 'grep'],
    maxIterations: AGENT_ITERATIONS.CODER,
    timeout: AGENT_TIMEOUT.CODER,
    temperature: 0.2,
    preferredLocation: 'local',
    canDelegate: true,
    canReceiveDelegation: true,
    delegationTargets: ['researcher', 'tester'],
  },
  {
    id: 'reviewer-v1',
    role: 'reviewer',
    name: 'Code Reviewer',
    description: '代码审查和质量检查',
    systemPrompt: `你是一个严格的代码审查员。你的职责是：
1. 审查代码的正确性和完整性
2. 检查潜在的 bug 和安全漏洞
3. 评估代码的可读性和可维护性
4. 确保代码符合项目规范

审查重点：
- 逻辑错误和边界情况
- 安全漏洞（注入、XSS、CSRF 等）
- 性能问题
- 代码重复和冗余
- 命名和注释质量
- 测试覆盖`,
    capabilities: ['file_read', 'code_analysis'],
    availableTools: ['read_file', 'glob', 'grep', 'list_directory'],
    maxIterations: AGENT_ITERATIONS.REVIEWER,
    timeout: AGENT_TIMEOUT.REVIEWER,
    temperature: 0.3,
    preferredLocation: 'any',
    canDelegate: false,
    canReceiveDelegation: true,
  },
  {
    id: 'writer-v1',
    role: 'writer',
    name: 'Technical Writer',
    description: '编写文档、报告和技术内容',
    systemPrompt: `你是一个专业的技术写作者。你的职责是：
1. 编写清晰、准确的技术文档
2. 创建易于理解的 README 和指南
3. 撰写 API 文档和使用示例
4. 生成项目报告和总结

写作原则：
- 使用清晰简洁的语言
- 结构化组织内容
- 包含实用的示例
- 考虑目标读者的技术水平`,
    capabilities: ['file_read', 'file_write', 'memory_access'],
    availableTools: ['read_file', 'write_file', 'edit_file', 'glob', 'memory_search'],
    maxIterations: AGENT_ITERATIONS.WRITER,
    timeout: AGENT_TIMEOUT.WRITER,
    temperature: 0.7,
    preferredLocation: 'any',
    canDelegate: false,
    canReceiveDelegation: true,
  },
  {
    id: 'tester-v1',
    role: 'tester',
    name: 'Test Engineer',
    description: '编写和执行测试',
    systemPrompt: `你是一个专业的测试工程师。你的职责是：
1. 设计全面的测试用例
2. 编写单元测试和集成测试
3. 执行测试并分析结果
4. 报告和跟踪 bug

测试原则：
- 覆盖正常和异常情况
- 测试边界条件
- 保持测试独立和可重复
- 使用有意义的断言消息`,
    capabilities: ['file_read', 'file_write', 'shell_execute', 'test_execution'],
    availableTools: ['read_file', 'write_file', 'edit_file', 'bash', 'glob'],
    maxIterations: AGENT_ITERATIONS.TESTER,
    timeout: AGENT_TIMEOUT.TESTER,
    temperature: 0.2,
    preferredLocation: 'local',
    canDelegate: false,
    canReceiveDelegation: true,
  },
  {
    id: 'coordinator-v1',
    role: 'coordinator',
    name: 'Agent Coordinator',
    description: '协调多个 Agent 完成复杂任务',
    systemPrompt: `你是一个 Agent 协调员。你的职责是：
1. 分析复杂任务并分配给合适的 Agent
2. 监控各 Agent 的执行进度
3. 协调 Agent 之间的通信和依赖
4. 汇总和整合各 Agent 的输出
5. 处理执行过程中的问题和异常

协调原则：
- 合理分配任务负载
- 最大化并行执行
- 及时处理阻塞和依赖
- 保持全局视角`,
    capabilities: ['task_delegation', 'file_read', 'memory_access'],
    availableTools: ['read_file', 'glob', 'todo_write', 'memory_store', 'memory_search'],
    maxIterations: AGENT_ITERATIONS.COORDINATOR,
    timeout: AGENT_TIMEOUT.COORDINATOR,
    temperature: 0.4,
    preferredLocation: 'any',
    canDelegate: true,
    canReceiveDelegation: false,
    delegationTargets: ['planner', 'researcher', 'coder', 'reviewer', 'writer', 'tester'],
  },
];

// ============================================================================
// AgentRegistry 类
// ============================================================================

export class AgentRegistry extends EventEmitter {
  private definitions: Map<string, AgentDefinition> = new Map();
  private instances: Map<string, AgentInstance> = new Map();
  private roleIndex: Map<AgentRole, Set<string>> = new Map();
  private capabilityIndex: Map<AgentCapability, Set<string>> = new Map();

  constructor() {
    super();
    this.registerBuiltinAgents();
  }

  // --------------------------------------------------------------------------
  // Agent 定义管理
  // --------------------------------------------------------------------------

  /**
   * 注册 Agent 定义
   */
  registerDefinition(definition: AgentDefinition): void {
    if (this.definitions.has(definition.id)) {
      throw new Error(`Agent definition ${definition.id} already exists`);
    }

    this.definitions.set(definition.id, definition);
    this.indexDefinition(definition);
    this.emit('definition:registered', definition);
  }

  /**
   * 更新 Agent 定义
   */
  updateDefinition(id: string, updates: Partial<AgentDefinition>): void {
    const definition = this.definitions.get(id);
    if (!definition) {
      throw new Error(`Agent definition ${id} not found`);
    }

    // 移除旧索引
    this.unindexDefinition(definition);

    // 更新定义
    const updated = { ...definition, ...updates };
    this.definitions.set(id, updated);

    // 重建索引
    this.indexDefinition(updated);

    this.emit('definition:updated', updated);
  }

  /**
   * 删除 Agent 定义
   */
  removeDefinition(id: string): void {
    const definition = this.definitions.get(id);
    if (!definition) return;

    // 检查是否有活跃实例
    const activeInstances = this.getInstancesByDefinition(id);
    if (activeInstances.length > 0) {
      throw new Error(`Cannot remove definition ${id} with ${activeInstances.length} active instances`);
    }

    this.unindexDefinition(definition);
    this.definitions.delete(id);

    this.emit('definition:removed', { id });
  }

  /**
   * 获取 Agent 定义
   */
  getDefinition(id: string): AgentDefinition | undefined {
    return this.definitions.get(id);
  }

  /**
   * 获取所有 Agent 定义
   */
  getAllDefinitions(): AgentDefinition[] {
    return Array.from(this.definitions.values());
  }

  /**
   * 按角色获取定义
   */
  getDefinitionsByRole(role: AgentRole): AgentDefinition[] {
    const ids = this.roleIndex.get(role) || new Set();
    return Array.from(ids)
      .map((id) => this.definitions.get(id))
      .filter((d): d is AgentDefinition => d !== undefined);
  }

  /**
   * 按能力获取定义
   */
  getDefinitionsByCapability(capability: AgentCapability): AgentDefinition[] {
    const ids = this.capabilityIndex.get(capability) || new Set();
    return Array.from(ids)
      .map((id) => this.definitions.get(id))
      .filter((d): d is AgentDefinition => d !== undefined);
  }

  // --------------------------------------------------------------------------
  // Agent 实例管理
  // --------------------------------------------------------------------------

  /**
   * 创建 Agent 实例
   */
  createInstance(definitionId: string): AgentInstance {
    const definition = this.definitions.get(definitionId);
    if (!definition) {
      throw new Error(`Agent definition ${definitionId} not found`);
    }

    const instance: AgentInstance = {
      id: `agent_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      definitionId,
      role: definition.role,
      status: 'idle',
      createdAt: Date.now(),
      lastActiveAt: Date.now(),
      stats: {
        tasksCompleted: 0,
        tasksFailed: 0,
        totalIterations: 0,
        totalDuration: 0,
        averageIterations: 0,
        averageDuration: 0,
      },
    };

    this.instances.set(instance.id, instance);
    this.emit('instance:created', instance);

    return instance;
  }

  /**
   * 更新实例状态
   */
  updateInstanceStatus(id: string, status: AgentStatus, taskId?: string): void {
    const instance = this.instances.get(id);
    if (!instance) return;

    instance.status = status;
    instance.lastActiveAt = Date.now();
    if (taskId !== undefined) {
      instance.currentTaskId = taskId;
    }

    this.emit('instance:updated', instance);
  }

  /**
   * 更新实例统计
   */
  updateInstanceStats(
    id: string,
    update: { success: boolean; iterations: number; duration: number }
  ): void {
    const instance = this.instances.get(id);
    if (!instance) return;

    if (update.success) {
      instance.stats.tasksCompleted++;
    } else {
      instance.stats.tasksFailed++;
    }

    instance.stats.totalIterations += update.iterations;
    instance.stats.totalDuration += update.duration;

    const totalTasks = instance.stats.tasksCompleted + instance.stats.tasksFailed;
    instance.stats.averageIterations = instance.stats.totalIterations / totalTasks;
    instance.stats.averageDuration = instance.stats.totalDuration / totalTasks;

    this.emit('instance:stats', instance);
  }

  /**
   * 销毁实例
   */
  destroyInstance(id: string): void {
    const instance = this.instances.get(id);
    if (!instance) return;

    if (instance.status === 'busy') {
      throw new Error(`Cannot destroy busy agent ${id}`);
    }

    this.instances.delete(id);
    this.emit('instance:destroyed', { id });
  }

  /**
   * 获取实例
   */
  getInstance(id: string): AgentInstance | undefined {
    return this.instances.get(id);
  }

  /**
   * 获取所有实例
   */
  getAllInstances(): AgentInstance[] {
    return Array.from(this.instances.values());
  }

  /**
   * 按定义获取实例
   */
  getInstancesByDefinition(definitionId: string): AgentInstance[] {
    return Array.from(this.instances.values()).filter((i) => i.definitionId === definitionId);
  }

  /**
   * 按角色获取实例
   */
  getInstancesByRole(role: AgentRole): AgentInstance[] {
    return Array.from(this.instances.values()).filter((i) => i.role === role);
  }

  /**
   * 获取空闲实例
   */
  getIdleInstances(role?: AgentRole): AgentInstance[] {
    return Array.from(this.instances.values()).filter(
      (i) => i.status === 'idle' && (!role || i.role === role)
    );
  }

  /**
   * 获取或创建空闲实例
   */
  getOrCreateIdleInstance(role: AgentRole): AgentInstance {
    // 先找空闲的
    const idle = this.getIdleInstances(role)[0];
    if (idle) return idle;

    // 没有就创建
    const definitions = this.getDefinitionsByRole(role);
    if (definitions.length === 0) {
      throw new Error(`No agent definition found for role ${role}`);
    }

    return this.createInstance(definitions[0].id);
  }

  // --------------------------------------------------------------------------
  // 索引管理
  // --------------------------------------------------------------------------

  /**
   * 索引定义
   */
  private indexDefinition(definition: AgentDefinition): void {
    // 角色索引
    if (!this.roleIndex.has(definition.role)) {
      this.roleIndex.set(definition.role, new Set());
    }
    this.roleIndex.get(definition.role)!.add(definition.id);

    // 能力索引
    for (const capability of definition.capabilities) {
      if (!this.capabilityIndex.has(capability)) {
        this.capabilityIndex.set(capability, new Set());
      }
      this.capabilityIndex.get(capability)!.add(definition.id);
    }
  }

  /**
   * 移除定义索引
   */
  private unindexDefinition(definition: AgentDefinition): void {
    // 移除角色索引
    this.roleIndex.get(definition.role)?.delete(definition.id);

    // 移除能力索引
    for (const capability of definition.capabilities) {
      this.capabilityIndex.get(capability)?.delete(definition.id);
    }
  }

  /**
   * 注册内置 Agent
   */
  private registerBuiltinAgents(): void {
    for (const definition of BUILTIN_AGENTS) {
      this.definitions.set(definition.id, definition);
      this.indexDefinition(definition);
    }
  }

  // --------------------------------------------------------------------------
  // 查询方法
  // --------------------------------------------------------------------------

  /**
   * 获取可用的 Agent 角色
   */
  getAvailableRoles(): AgentRole[] {
    return Array.from(this.roleIndex.keys());
  }

  /**
   * 获取统计信息
   */
  getStats(): {
    definitionCount: number;
    instanceCount: number;
    busyCount: number;
    idleCount: number;
    byRole: Record<string, { definitions: number; instances: number }>;
  } {
    const byRole: Record<string, { definitions: number; instances: number }> = {};

    for (const [role, defIds] of this.roleIndex) {
      byRole[role] = {
        definitions: defIds.size,
        instances: this.getInstancesByRole(role).length,
      };
    }

    const instances = Array.from(this.instances.values());

    return {
      definitionCount: this.definitions.size,
      instanceCount: instances.length,
      busyCount: instances.filter((i) => i.status === 'busy').length,
      idleCount: instances.filter((i) => i.status === 'idle').length,
      byRole,
    };
  }

  /**
   * 清理资源
   */
  dispose(): void {
    this.instances.clear();
    this.removeAllListeners();
  }
}

// ============================================================================
// 单例实例
// ============================================================================

let registryInstance: AgentRegistry | null = null;

export function getAgentRegistry(): AgentRegistry {
  if (!registryInstance) {
    registryInstance = new AgentRegistry();
  }
  return registryInstance;
}
