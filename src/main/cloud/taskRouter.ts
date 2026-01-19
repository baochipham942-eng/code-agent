// ============================================================================
// TaskRouter - 任务路由决策器
// 根据任务特性决定在本地还是云端执行
// ============================================================================

import type {
  CloudTask,
  CloudAgentType,
  TaskExecutionLocation,
  TaskRoutingDecision,
  CreateCloudTaskRequest,
  HybridTaskConfig,
} from '../../shared/types/cloud';
import { TASK_ANALYSIS } from '../../shared/constants';

// ============================================================================
// 默认配置
// ============================================================================

const DEFAULT_HYBRID_CONFIG: HybridTaskConfig = {
  // 本地优先的任务类型（需要访问本地文件系统）
  localPreferred: ['analyzer'],
  // 云端优先的任务类型（纯计算/研究）
  cloudPreferred: ['researcher', 'writer', 'reviewer', 'planner'],
  // 自动回退到本地的条件
  fallbackToLocal: {
    onCloudTimeout: true,
    onCloudError: true,
    maxRetries: 2,
  },
  // 并行执行配置
  parallel: {
    enabled: true,
    maxConcurrent: 3,
  },
};

// ============================================================================
// 任务特征分析
// ============================================================================

interface TaskCharacteristics {
  needsLocalFileAccess: boolean;
  needsLocalShell: boolean;
  needsRealTimeInteraction: boolean;
  isComputeIntensive: boolean;
  isLongRunning: boolean;
  hasSensitiveData: boolean;
  estimatedDuration: number; // 毫秒
}

/**
 * 分析任务特征
 */
function analyzeTaskCharacteristics(
  request: CreateCloudTaskRequest
): TaskCharacteristics {
  const prompt = request.prompt.toLowerCase();
  const description = (request.description || '').toLowerCase();
  const combinedText = `${prompt} ${description}`;

  // 检测是否需要本地文件访问
  const needsLocalFileAccess =
    /\b(read|write|edit|create|delete|modify)\s+(file|folder|directory)/i.test(combinedText) ||
    /\b(open|save|load)\s+\S+\.(ts|js|py|json|md|txt)/i.test(combinedText) ||
    /本地文件|读取文件|写入文件|编辑文件/i.test(combinedText);

  // 检测是否需要本地 shell
  const needsLocalShell =
    /\b(run|execute|npm|yarn|git|docker|make)\b/i.test(combinedText) ||
    /\b(build|test|lint|compile)\b/i.test(combinedText) ||
    /运行|执行|构建|测试/i.test(combinedText);

  // 检测是否需要实时交互
  const needsRealTimeInteraction =
    /\b(interactive|realtime|real-time|live)\b/i.test(combinedText) ||
    /实时|交互/i.test(combinedText);

  // 检测是否计算密集
  const isComputeIntensive =
    /\b(analyze|process|transform|convert|generate|compute)\b/i.test(combinedText) ||
    /分析|处理|转换|生成/i.test(combinedText);

  // 检测是否长时间运行
  const isLongRunning =
    /\b(comprehensive|thorough|detailed|extensive)\b/i.test(combinedText) ||
    /全面|详细|深入/i.test(combinedText) ||
    Boolean(request.maxIterations && request.maxIterations > 20);

  // 检测是否包含敏感数据
  const hasSensitiveData =
    /\b(password|secret|token|key|credential|api[_-]?key)\b/i.test(combinedText) ||
    /密码|密钥|凭证/i.test(combinedText);

  // 估算执行时间
  let estimatedDuration = TASK_ANALYSIS.DEFAULT_ESTIMATED_DURATION;
  if (isLongRunning) estimatedDuration *= 3;
  if (isComputeIntensive) estimatedDuration *= 1.5;
  if (needsLocalShell) estimatedDuration *= 1.2;

  return {
    needsLocalFileAccess,
    needsLocalShell,
    needsRealTimeInteraction,
    isComputeIntensive,
    isLongRunning,
    hasSensitiveData,
    estimatedDuration,
  };
}

// ============================================================================
// 路由决策逻辑
// ============================================================================

/**
 * 基于规则的路由决策
 */
function makeRuleBasedDecision(
  request: CreateCloudTaskRequest,
  characteristics: TaskCharacteristics,
  config: HybridTaskConfig
): TaskRoutingDecision {
  const taskId = `routing_${Date.now()}`;
  const alternatives: TaskRoutingDecision['alternatives'] = [];
  let recommendedLocation: TaskExecutionLocation = 'cloud';
  let reason = '';
  let confidence = 0.8;

  // 规则 1: 敏感数据必须本地执行
  if (characteristics.hasSensitiveData) {
    recommendedLocation = 'local';
    reason = '任务包含敏感数据，必须在本地执行以确保安全';
    confidence = 0.95;
    alternatives.push({
      location: 'cloud',
      reason: '云端执行会暴露敏感数据（不推荐）',
    });
    return { taskId, recommendedLocation, reason, confidence, alternatives };
  }

  // 规则 2: 需要本地文件/shell 访问
  if (characteristics.needsLocalFileAccess || characteristics.needsLocalShell) {
    recommendedLocation = 'local';
    reason = '任务需要访问本地文件系统或执行本地命令';
    confidence = 0.9;
    alternatives.push({
      location: 'hybrid',
      reason: '可以拆分为本地和云端部分分别执行',
    });
    return { taskId, recommendedLocation, reason, confidence, alternatives };
  }

  // 规则 3: 需要实时交互
  if (characteristics.needsRealTimeInteraction) {
    recommendedLocation = 'local';
    reason = '任务需要实时交互，本地执行响应更快';
    confidence = 0.85;
    alternatives.push({
      location: 'cloud',
      reason: '云端执行延迟较高但可行',
    });
    return { taskId, recommendedLocation, reason, confidence, alternatives };
  }

  // 规则 4: 根据任务类型的默认偏好
  if (config.localPreferred.includes(request.type)) {
    recommendedLocation = 'local';
    reason = `${request.type} 类型任务默认在本地执行`;
    confidence = 0.7;
    alternatives.push({
      location: 'cloud',
      reason: '也可以在云端执行',
    });
  } else if (config.cloudPreferred.includes(request.type)) {
    recommendedLocation = 'cloud';
    reason = `${request.type} 类型任务适合在云端执行`;
    confidence = 0.75;
    alternatives.push({
      location: 'local',
      reason: '也可以在本地执行',
    });
  }

  // 规则 5: 长时间运行的任务考虑云端
  if (characteristics.isLongRunning && recommendedLocation !== 'local') {
    recommendedLocation = 'cloud';
    reason = '长时间运行的任务在云端执行不会阻塞本地';
    confidence = 0.8;
    alternatives.push({
      location: 'local',
      reason: '本地执行会占用资源但结果更可控',
    });
  }

  // 添加混合选项
  if ((recommendedLocation as TaskExecutionLocation) !== 'hybrid') {
    alternatives.push({
      location: 'hybrid',
      reason: '可以拆分任务并行执行',
    });
  }

  return { taskId, recommendedLocation, reason, confidence, alternatives };
}

// ============================================================================
// TaskRouter 类
// ============================================================================

export class TaskRouter {
  private config: HybridTaskConfig;
  private routingHistory: Map<string, TaskRoutingDecision> = new Map();

  constructor(config: Partial<HybridTaskConfig> = {}) {
    this.config = { ...DEFAULT_HYBRID_CONFIG, ...config };
  }

  /**
   * 决定任务应该在哪里执行
   */
  route(request: CreateCloudTaskRequest): TaskRoutingDecision {
    // 如果用户明确指定了位置，直接使用
    if (request.location && request.location !== 'hybrid') {
      const decision: TaskRoutingDecision = {
        taskId: `routing_${Date.now()}`,
        recommendedLocation: request.location,
        reason: '用户明确指定了执行位置',
        confidence: 1.0,
        alternatives: [],
      };
      this.routingHistory.set(decision.taskId, decision);
      return decision;
    }

    // 分析任务特征
    const characteristics = analyzeTaskCharacteristics(request);

    // 做出路由决策
    const decision = makeRuleBasedDecision(request, characteristics, this.config);

    // 记录决策历史
    this.routingHistory.set(decision.taskId, decision);

    return decision;
  }

  /**
   * 批量路由多个任务
   */
  routeBatch(requests: CreateCloudTaskRequest[]): TaskRoutingDecision[] {
    return requests.map((req) => this.route(req));
  }

  /**
   * 获取路由历史
   */
  getRoutingHistory(): TaskRoutingDecision[] {
    return Array.from(this.routingHistory.values());
  }

  /**
   * 清除路由历史
   */
  clearHistory(): void {
    this.routingHistory.clear();
  }

  /**
   * 更新配置
   */
  updateConfig(config: Partial<HybridTaskConfig>): void {
    this.config = { ...this.config, ...config };
  }

  /**
   * 获取当前配置
   */
  getConfig(): HybridTaskConfig {
    return { ...this.config };
  }

  /**
   * 判断任务是否应该重试
   */
  shouldRetry(task: CloudTask, error: string): boolean {
    const retryableErrors = [
      'timeout',
      'rate limit',
      'service unavailable',
      'connection refused',
      '超时',
      '限流',
      '服务不可用',
    ];

    const isRetryable = retryableErrors.some((e) =>
      error.toLowerCase().includes(e.toLowerCase())
    );

    if (!isRetryable) return false;

    // 检查是否应该回退到本地
    if (
      task.location === 'cloud' &&
      this.config.fallbackToLocal.onCloudError
    ) {
      return true;
    }

    return true;
  }

  /**
   * 获取重试策略
   */
  getRetryStrategy(
    task: CloudTask,
    retryCount: number
  ): { location: TaskExecutionLocation; delay: number } | null {
    if (retryCount >= this.config.fallbackToLocal.maxRetries) {
      return null;
    }

    // 指数退避
    const delay = Math.min(1000 * Math.pow(2, retryCount), 30000);

    // 云端任务失败后回退到本地
    if (
      task.location === 'cloud' &&
      retryCount >= 1 &&
      this.config.fallbackToLocal.onCloudError
    ) {
      return { location: 'local', delay };
    }

    return { location: task.location, delay };
  }
}

// ============================================================================
// 单例实例
// ============================================================================

let routerInstance: TaskRouter | null = null;

export function getTaskRouter(): TaskRouter {
  if (!routerInstance) {
    routerInstance = new TaskRouter();
  }
  return routerInstance;
}

export function initTaskRouter(config: Partial<HybridTaskConfig>): TaskRouter {
  routerInstance = new TaskRouter(config);
  return routerInstance;
}
