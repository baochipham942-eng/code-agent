// ============================================================================
// Task Router - 智能路由器（混合架构 Layer 3）
// ============================================================================
//
// 路由决策：
// 1. 简单任务 → 核心角色（直接执行）
// 2. 中等任务 → 核心角色 + 条件扩展
// 3. 复杂任务 → 动态生成 Agent Swarm
//
// 参考：
// - LangGraph 的条件路由
// - Bloomreach 的混合架构（静态骨架 + 动态执行）
// ============================================================================

import { createLogger } from '../../services/infra/logger';
import { CROSS_VERIFY } from '../../../shared/constants';
import {
  type CoreAgentId,
  type CoreAgentConfig,
  CORE_AGENTS,
  recommendCoreAgent,
  isCoreAgent,
} from './coreAgents';
import {
  type DynamicAgentConfig,
  type DynamicAgentSpec,
  type GenerationContext,
  getDynamicAgentFactory,
  generateAnalysisPrompt,
} from './dynamicFactory';
import { isCodexAvailable } from './crossVerify';

const logger = createLogger('TaskRouter');

// ============================================================================
// Types
// ============================================================================

/**
 * 任务复杂度
 */
export type TaskComplexity = 'simple' | 'moderate' | 'complex';

/**
 * 路由决策类型
 */
export type RoutingDecisionType = 'core' | 'dynamic' | 'swarm';

/**
 * 核心角色路由决策
 */
export interface CoreRoutingDecision {
  type: 'core';
  agent: CoreAgentConfig;
  reason: string;
  /** 标记此任务需要双模型交叉验证（coder 执行完成后触发） */
  crossVerify?: boolean;
  /** 标记此任务需要 Review Loop（执行后自动验证+迭代修复） */
  reviewLoop?: boolean;
}

/**
 * 动态 Agent 路由决策
 */
export interface DynamicRoutingDecision {
  type: 'dynamic';
  agents: DynamicAgentConfig[];
  executionOrder: 'parallel' | 'sequential' | 'mixed';
  reason: string;
  /** 标记此任务需要双模型交叉验证（coder 执行完成后触发） */
  crossVerify?: boolean;
  /** 标记此任务需要 Review Loop（执行后自动验证+迭代修复） */
  reviewLoop?: boolean;
}

/**
 * Agent Swarm 路由决策
 */
export interface SwarmRoutingDecision {
  type: 'swarm';
  agents: DynamicAgentConfig[];
  config: SwarmConfig;
  reason: string;
  /** 标记此任务需要双模型交叉验证（coder 执行完成后触发） */
  crossVerify?: boolean;
  /** 标记此任务需要 Review Loop（执行后自动验证+迭代修复） */
  reviewLoop?: boolean;
}

export type RoutingDecision = CoreRoutingDecision | DynamicRoutingDecision | SwarmRoutingDecision;

/**
 * Swarm 配置
 */
export interface SwarmConfig {
  maxAgents: number;
  reportingMode: 'sparse' | 'full';
  conflictResolution: 'coordinator' | 'vote';
  timeout: number;
  // Agent Teams: 启用 P2P 通信
  enablePeerCommunication?: boolean;
  // Phase 2: 进程隔离选项
  processIsolation?: boolean;
  maxWorkers?: number;
  workerTimeout?: number;
  // E2: 高风险操作审批（默认关闭，显式开启）
  requirePlanApproval?: boolean;
}

/**
 * 任务分析结果
 */
export interface TaskAnalysis {
  /** 任务复杂度 */
  complexity: TaskComplexity;
  /** 推荐的任务类型 */
  taskType: string;
  /** 涉及的文件操作 */
  involvesFiles: boolean;
  /** 涉及网络操作 */
  involvesNetwork: boolean;
  /** 涉及命令执行 */
  involvesExecution: boolean;
  /** 预估步骤数 */
  estimatedSteps: number;
  /** 可并行子任务数 */
  parallelism: number;
  /** 需要的专业能力 */
  specializations: string[];
  /** 分析置信度 */
  confidence: number;
}

/**
 * 路由上下文
 */
export interface RoutingContext {
  /** 用户任务 */
  task: string;
  /** 工作目录 */
  workingDirectory?: string;
  /** 项目结构 */
  projectStructure?: string;
  /** 相关文件 */
  relevantFiles?: string[];
  /** 会话 ID */
  sessionId?: string;
  /** 强制使用的 Agent ID */
  forcedAgentId?: string;
}

// ============================================================================
// Task Analysis
// ============================================================================

/**
 * 复杂度指标
 */
const COMPLEXITY_INDICATORS = {
  simple: [
    /\b(find|search|list|show|get|what is|读取|查找|列出|显示)\b/i,
  ],
  complex: [
    /\b(refactor|redesign|architect|comprehensive|detailed|complete|全面|重构|设计|详细|完整)\b/i,
    /\b(analyze.*and.*implement|分析.*并.*实现)\b/i,
    /\b(multiple files|多个文件)\b/i,
  ],
};

/**
 * 专业化指标
 */
const SPECIALIZATION_INDICATORS: Record<string, RegExp[]> = {
  'database': [/\b(database|sql|schema|migration|postgresql|mysql|sqlite)\b/i],
  'frontend': [/\b(react|vue|css|ui|component|frontend|前端)\b/i],
  'backend': [/\b(api|server|backend|service|后端|接口)\b/i],
  'devops': [/\b(deploy|ci|cd|docker|kubernetes|部署|容器)\b/i],
  'security': [/\b(security|auth|permission|vulnerability|安全|权限)\b/i],
  'performance': [/\b(performance|optimize|speed|latency|性能|优化)\b/i],
};

/**
 * 分析任务
 */
export function analyzeTask(task: string): TaskAnalysis {
  const lower = task.toLowerCase();

  // 检测复杂度
  let complexity: TaskComplexity = 'moderate';

  for (const pattern of COMPLEXITY_INDICATORS.simple) {
    if (pattern.test(task) && task.length < 100) {
      complexity = 'simple';
      break;
    }
  }

  for (const pattern of COMPLEXITY_INDICATORS.complex) {
    if (pattern.test(task)) {
      complexity = 'complex';
      break;
    }
  }

  // 长任务描述通常更复杂
  if (task.length > 500) {
    complexity = 'complex';
  }

  // 多个编号列表
  const numberedItems = (task.match(/\d+\./g) || []).length;
  if (numberedItems >= 3) {
    complexity = 'complex';
  }

  // 检测涉及的操作
  const involvesFiles = /\b(file|read|write|edit|create|modify|文件|读取|写入|修改)\b/i.test(task);
  const involvesNetwork = /\b(http|api|fetch|url|web|network|网络|接口)\b/i.test(task);
  const involvesExecution = /\b(run|execute|test|build|命令|执行|测试|构建)\b/i.test(task);

  // 检测专业化需求
  const specializations: string[] = [];
  for (const [spec, patterns] of Object.entries(SPECIALIZATION_INDICATORS)) {
    for (const pattern of patterns) {
      if (pattern.test(task)) {
        specializations.push(spec);
        break;
      }
    }
  }

  // 估算步骤数
  let estimatedSteps = 5;
  if (complexity === 'simple') estimatedSteps = 3;
  if (complexity === 'complex') estimatedSteps = 15;
  if (numberedItems > 0) estimatedSteps = Math.max(estimatedSteps, numberedItems * 3);

  // 估算并行度
  let parallelism = 1;
  if (specializations.length > 1) parallelism = specializations.length;
  if (/\b(parallel|concurrent|同时|并行)\b/i.test(task)) parallelism = Math.max(parallelism, 3);
  if (/(\d+)\s*(个|份|批)/.test(task)) {
    const match = task.match(/(\d+)\s*(个|份|批)/);
    if (match && parseInt(match[1]) > 5) {
      parallelism = Math.min(Math.ceil(parseInt(match[1]) / 10), 10);
    }
  }

  // 推断任务类型
  let taskType = 'code';
  if (/\b(review|审查|检查)\b/i.test(task)) taskType = 'review';
  if (/深度搜索|深入调研|全面分析|深度调研|深入搜索|深度分析|研究报告|详细调研|deep\s*research|comprehensive\s*research|in-depth\s*analysis|thorough\s*research/i.test(task)) taskType = 'research';
  else if (/\b(search|find|explore|查找|搜索|探索)\b/i.test(task)) taskType = 'search';
  if (/\b(plan|design|规划|设计)\b/i.test(task)) taskType = 'plan';
  if (/\b(test|测试)\b/i.test(task)) taskType = 'test';
  if (/\b(excel|xlsx|csv|数据|分析|清洗|透视|聚合|统计|dataframe|pandas)\b/i.test(task)) taskType = 'data';
  if (/\b(ppt|pptx|幻灯片|演示|slide|presentation)\b/i.test(task)) taskType = 'ppt';
  if (/\b(文章|报告|文档|撰写|write.*article|write.*report|write.*document)\b/i.test(task)) taskType = 'document';
  if (/\b(生成.*图|画.*图|image|draw|generate.*image|生图|插图)\b/i.test(task)) taskType = 'image';
  if (/\b(生成.*视频|做.*视频|制作.*视频|视频生成|video|generate.*video|短视频|动画)\b/i.test(task)) taskType = 'video';

  // 计算置信度
  let confidence = 0.5;
  if (complexity !== 'moderate') confidence += 0.1;
  if (specializations.length > 0) confidence += 0.1;
  if (task.length > 50) confidence += 0.1;

  return {
    complexity,
    taskType,
    involvesFiles,
    involvesNetwork,
    involvesExecution,
    estimatedSteps,
    parallelism,
    specializations,
    confidence: Math.min(confidence, 1),
  };
}

// ============================================================================
// Task Router
// ============================================================================

/**
 * 任务路由器
 *
 * 根据任务复杂度和特征，决定使用核心角色、动态 Agent 还是 Agent Swarm。
 */
export class TaskRouter {
  private factory = getDynamicAgentFactory();

  /**
   * 路由任务
   *
   * @param context - 路由上下文
   * @returns 路由决策
   */
  async route(context: RoutingContext): Promise<RoutingDecision> {
    const startTime = Date.now();
    const analysis = analyzeTask(context.task);

    logger.info('Routing task', {
      complexity: analysis.complexity,
      taskType: analysis.taskType,
      parallelism: analysis.parallelism,
      specializations: analysis.specializations,
    });

    // 强制指定 Agent
    if (context.forcedAgentId && isCoreAgent(context.forcedAgentId)) {
      return {
        type: 'core',
        agent: CORE_AGENTS[context.forcedAgentId],
        reason: `Forced agent: ${context.forcedAgentId}`,
      };
    }

    // 路由决策
    let decision: RoutingDecision;

    if (this.shouldUseCoreAgent(analysis)) {
      decision = this.routeToCoreAgent(analysis, context);
    } else if (this.shouldUseSwarm(analysis)) {
      decision = await this.routeToSwarm(analysis, context);
    } else {
      decision = await this.routeToDynamic(analysis, context);
    }

    // 交叉验证标记（纯增强，不改变路由结果）
    if (this.shouldCrossVerify(analysis)) {
      decision.crossVerify = true;
      logger.info('Task marked for cross-verify with Codex');
    }

    logger.info('Routing decision', {
      type: decision.type,
      reason: decision.reason,
      crossVerify: decision.crossVerify ?? false,
      routingTime: Date.now() - startTime,
    });

    return decision;
  }

  /**
   * 判断是否应该使用核心角色
   */
  private shouldUseCoreAgent(analysis: TaskAnalysis): boolean {
    // 简单任务直接用核心角色
    if (analysis.complexity === 'simple') {
      return true;
    }

    // 中等任务且无特殊需求
    if (analysis.complexity === 'moderate' && analysis.specializations.length <= 1) {
      return true;
    }

    // 低并行度
    if (analysis.parallelism <= 1) {
      return true;
    }

    return false;
  }

  /**
   * 判断是否应该使用 Swarm
   */
  private shouldUseSwarm(analysis: TaskAnalysis): boolean {
    // 高并行度
    if (analysis.parallelism >= 3) {
      return true;
    }

    // 复杂任务 + 多专业化
    if (analysis.complexity === 'complex' && analysis.specializations.length >= 2) {
      return true;
    }

    // 大量步骤
    if (analysis.estimatedSteps >= 15) {
      return true;
    }

    return false;
  }

  /**
   * 判断是否需要双模型交叉验证
   * 优先读 settings.codex?.crossVerifyEnabled，回退到环境变量
   * 条件：启用 + 复杂任务 + 代码类型 + Codex MCP 可用
   */
  private shouldCrossVerify(analysis: TaskAnalysis): boolean {
    // 1. 优先读 settings
    let enabled = false;
    try {
      const { getConfigServiceInstance } = require('../../app/bootstrap');
      const configService = getConfigServiceInstance();
      if (configService) {
        const settings = configService.getSettings();
        if (settings.codex?.crossVerifyEnabled !== undefined) {
          enabled = settings.codex.crossVerifyEnabled;
        }
      }
    } catch {
      // bootstrap not available, fall through to env var
    }

    // 2. 回退到环境变量
    if (!enabled) {
      enabled = process.env[CROSS_VERIFY.ENV_VAR] === 'true';
    }

    return (
      enabled &&
      analysis.complexity === 'complex' &&
      analysis.taskType === 'code' &&
      isCodexAvailable()
    );
  }

  /**
   * 路由到核心角色
   * 先查 profiler 推荐，如果有历史表现数据则优先使用
   */
  private routeToCoreAgent(
    analysis: TaskAnalysis,
    _context: RoutingContext
  ): CoreRoutingDecision {
    // 尝试使用 profiler 推荐
    try {
      const { getAgentProfiler } = require('../profiling/agentProfiler');
      const profiler = getAgentProfiler();
      const recommendation = profiler.recommendAgent(analysis.taskType);
      if (recommendation && isCoreAgent(recommendation.agentId)) {
        logger.info('Using profiler recommendation', {
          agentId: recommendation.agentId,
          wilsonScore: recommendation.wilsonScore.toFixed(3),
          totalExecutions: recommendation.totalExecutions,
        });
        return {
          type: 'core',
          agent: CORE_AGENTS[recommendation.agentId as CoreAgentId],
          reason: `Profiler recommended: ${recommendation.agentId} (wilson=${recommendation.wilsonScore.toFixed(3)})`,
        };
      }
    } catch {
      // Profiler not available, fall through to default
    }

    const agentId = recommendCoreAgent(analysis.taskType);
    const agent = CORE_AGENTS[agentId];

    return {
      type: 'core',
      agent,
      reason: `Simple/moderate task → core agent: ${agentId}`,
    };
  }

  /**
   * 路由到动态 Agent
   */
  private async routeToDynamic(
    analysis: TaskAnalysis,
    context: RoutingContext
  ): Promise<DynamicRoutingDecision> {
    // 生成动态 Agent 规格
    const specs = this.generateDynamicSpecs(analysis, context);

    // 创建 Agent
    const generationContext: GenerationContext = {
      task: context.task,
      workingDirectory: context.workingDirectory,
      projectStructure: context.projectStructure,
      relevantFiles: context.relevantFiles,
      parentTaskId: context.sessionId || `task-${Date.now()}`,
    };

    const result = this.factory.createFromSpecs(specs, generationContext);

    return {
      type: 'dynamic',
      agents: result.agents,
      executionOrder: result.executionOrder,
      reason: `Moderate task with specializations → ${specs.length} dynamic agents`,
    };
  }

  /**
   * 路由到 Swarm
   */
  private async routeToSwarm(
    analysis: TaskAnalysis,
    context: RoutingContext
  ): Promise<SwarmRoutingDecision> {
    // 生成更多的动态 Agent
    const specs = this.generateSwarmSpecs(analysis, context);

    // 创建 Agent
    const generationContext: GenerationContext = {
      task: context.task,
      workingDirectory: context.workingDirectory,
      projectStructure: context.projectStructure,
      relevantFiles: context.relevantFiles,
      parentTaskId: context.sessionId || `task-${Date.now()}`,
    };

    const result = this.factory.createFromSpecs(specs, generationContext);

    // Swarm 配置
    // 根据任务依赖密度选择执行模式：
    // - 松耦合（无 dependencies）→ 乐观并发（optimistic）
    // - 紧耦合（有 dependencies 链）→ DAG 调度（dag）
    const hasDependencies = specs.some(s => (s.dependencies?.length ?? 0) > 0);
    const executionMode = hasDependencies ? 'dag' : 'optimistic';

    const config: SwarmConfig = {
      maxAgents: Math.min(analysis.parallelism * 2, 50),
      reportingMode: 'sparse',  // 稀疏汇报
      conflictResolution: 'coordinator',
      timeout: analysis.estimatedSteps * 60000,  // 每步 1 分钟
    };

    return {
      type: 'swarm',
      agents: result.agents,
      config,
      reason: `Complex task → swarm (${executionMode}) with ${result.agents.length} agents`,
    };
  }

  /**
   * 生成动态 Agent 规格
   */
  private generateDynamicSpecs(
    analysis: TaskAnalysis,
    context: RoutingContext
  ): DynamicAgentSpec[] {
    const specs: DynamicAgentSpec[] = [];

    // 根据专业化生成
    for (const spec of analysis.specializations) {
      specs.push({
        name: `${spec}-specialist`,
        responsibility: `Handle ${spec}-related aspects of the task`,
        tools: this.getToolsForSpecialization(spec),
        parallelizable: true,
        dependencies: [],
      });
    }

    // 如果没有专业化，生成通用的
    if (specs.length === 0) {
      const coreId = recommendCoreAgent(analysis.taskType);
      specs.push({
        name: `${analysis.taskType}-executor`,
        responsibility: `Execute the ${analysis.taskType} task`,
        tools: CORE_AGENTS[coreId].tools,
        parallelizable: false,
        dependencies: [],
      });
    }

    return specs;
  }

  /**
   * 生成 Swarm Agent 规格
   */
  private generateSwarmSpecs(
    analysis: TaskAnalysis,
    context: RoutingContext
  ): DynamicAgentSpec[] {
    const specs: DynamicAgentSpec[] = [];

    // 1. 规划 Agent（总是第一个）
    specs.push({
      name: 'task-planner',
      responsibility: 'Analyze the task and create a detailed execution plan',
      tools: ['read_file', 'glob', 'grep', 'list_directory'],
      parallelizable: false,
      dependencies: [],
    });

    // 2. 专业化 Agent
    for (const spec of analysis.specializations) {
      specs.push({
        name: `${spec}-worker`,
        responsibility: `Implement ${spec}-related changes`,
        tools: this.getToolsForSpecialization(spec),
        parallelizable: true,
        dependencies: ['task-planner'],
      });
    }

    // 3. 如果并行度高，添加更多工作 Agent
    if (analysis.parallelism > analysis.specializations.length) {
      const additionalWorkers = analysis.parallelism - analysis.specializations.length;
      for (let i = 0; i < Math.min(additionalWorkers, 5); i++) {
        specs.push({
          name: `worker-${i + 1}`,
          responsibility: `Execute assigned subtasks from the plan`,
          tools: ['read_file', 'write_file', 'edit_file', 'glob', 'grep', 'bash'],
          parallelizable: true,
          dependencies: ['task-planner'],
        });
      }
    }

    // 4. 验证步骤：不再生成 task-verifier agent，
    //    改由 agentSwarm.execute() 结束时运行确定性 VerifierRegistry
    //    （见 agentSwarm.ts 中 coordinator.aggregate() 之后的验证步骤）

    return specs;
  }

  /**
   * 获取专业化对应的工具
   */
  private getToolsForSpecialization(spec: string): string[] {
    const toolMap: Record<string, string[]> = {
      'database': ['read_file', 'write_file', 'edit_file', 'bash', 'glob', 'grep'],
      'frontend': ['read_file', 'write_file', 'edit_file', 'glob', 'grep'],
      'backend': ['read_file', 'write_file', 'edit_file', 'bash', 'glob', 'grep'],
      'devops': ['read_file', 'write_file', 'bash', 'glob'],
      'security': ['read_file', 'glob', 'grep', 'bash'],
      'performance': ['read_file', 'glob', 'grep', 'bash'],
    };

    return toolMap[spec] || ['read_file', 'glob', 'grep'];
  }
}

// ============================================================================
// Singleton
// ============================================================================

let routerInstance: TaskRouter | null = null;

export function getTaskRouter(): TaskRouter {
  if (!routerInstance) {
    routerInstance = new TaskRouter();
  }
  return routerInstance;
}
